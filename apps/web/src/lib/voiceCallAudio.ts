import {
  CAPTURE_FRAME_MS,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  floatToPcm16,
  pcm16ToBase64,
  pcm16ToFloat,
  resampleTo,
  type CallAudio,
  type CallSocket,
  type CallSocketHandlers,
} from './voiceCall';

/**
 * The irreducible browser glue: the microphone, the speaker, the socket.
 *
 * EVERYTHING HERE NEEDS A REAL BROWSER, which is why it is a separate file and
 * why it is as thin as it can be. The web test environment is `node` with no DOM
 * (apps/web/vitest.config.ts), so none of this is unit-tested and none of it
 * should hold logic worth testing -- the protocol, the lifecycle and the PCM
 * conversion all live in `voiceCall.ts`, which is tested. What remains is
 * `getUserMedia`, an `AudioContext`, and a `WebSocket` constructor.
 *
 * This is the part that needs trying on Staging with a real microphone.
 */

/** Reasons a microphone can refuse, mapped to what `messageForReason` knows. */
function microphoneFailure(error: unknown): Error {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error('microphone_denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new Error('microphone_missing');
  }
  return new Error('microphone_denied');
}

/**
 * Opens the relay socket.
 *
 * No subprotocol and no query string: the session cookie authenticates it,
 * exactly as it does every other request. A WebSocket cannot carry custom
 * headers from a browser, which is why the server checks the cookie and the
 * Origin rather than a bearer token.
 */
export function openRelaySocket(url: string, handlers: CallSocketHandlers): CallSocket {
  const ws = new WebSocket(url);
  ws.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  });
  ws.addEventListener('close', () => handlers.onClose());
  ws.addEventListener('error', () => handlers.onError());
  return {
    send(data: string) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close() {
      // 1000: a normal closure. The server settles the call from this.
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'client_ended');
      }
    },
  };
}

/**
 * Microphone capture and playback over Web Audio.
 *
 * ── CAPTURE ──────────────────────────────────────────────────────────────────
 *
 * The browser gives us whatever rate its hardware prefers; the provider wants
 * 16 kHz mono PCM16. So each block is resampled, converted and base64-encoded
 * into one frame per CAPTURE_FRAME_MS. Turn detection is the provider's
 * (`turn_detection: { type: 'server_vad' }`, set server-side in spicyapi.ts), so
 * this streams continuously and never commits a turn or asks for a response.
 *
 * ── PLAYBACK ─────────────────────────────────────────────────────────────────
 *
 * Her audio arrives as 24 kHz chunks that have to play gap-free, so each one is
 * scheduled at the end of the last rather than started on arrival -- `startAt`
 * is the running cursor. Barge-in stops every scheduled source at once and
 * resets the cursor, which is what makes interrupting her sound immediate
 * instead of letting the buffer drain.
 *
 * `ScriptProcessorNode` is deprecated in favour of `AudioWorklet`, and is used
 * anyway: a worklet needs a separately served module file, which is a build
 * concern this step does not touch. It is the one thing here worth revisiting.
 */
export function createBrowserCallAudio(): CallAudio {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let playback: AudioContext | null = null;
  let startAt = 0;
  let playing: AudioBufferSourceNode[] = [];

  return {
    async start(onFrame): Promise<void> {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // Echo cancellation is what stops her own voice being fed back in as
          // the person "interrupting" her through the laptop speaker.
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (error) {
        throw microphoneFailure(error);
      }

      context = new AudioContext();
      // Autoplay policies can start a context suspended even after a click.
      if (context.state === 'suspended') await context.resume();

      source = context.createMediaStreamSource(stream);
      // A power of two at or above one frame's worth of input samples.
      const blockSize = 4096;
      processor = context.createScriptProcessor(blockSize, 1, 1);

      const samplesPerFrame = Math.floor((INPUT_SAMPLE_RATE * CAPTURE_FRAME_MS) / 1000);
      let pending: number[] = [];

      processor.onaudioprocess = (event) => {
        const block = event.inputBuffer.getChannelData(0);
        const resampled = resampleTo(block, context!.sampleRate, INPUT_SAMPLE_RATE);
        for (let i = 0; i < resampled.length; i += 1) pending.push(resampled[i]!);
        // Emitted in fixed frames rather than per block, so frame size is a
        // property of the protocol and not of the browser's buffer size.
        while (pending.length >= samplesPerFrame) {
          const frame = Float32Array.from(pending.slice(0, samplesPerFrame));
          pending = pending.slice(samplesPerFrame);
          onFrame(pcm16ToBase64(floatToPcm16(frame)));
        }
      };

      source.connect(processor);
      // A ScriptProcessor only runs while connected to a destination. Gain is
      // zero so the person never hears their own microphone.
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(context.destination);

      playback = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      if (playback.state === 'suspended') await playback.resume();
      startAt = playback.currentTime;
    },

    play(pcm16: Int16Array): void {
      if (playback === null || pcm16.length === 0) return;
      const buffer = playback.createBuffer(1, pcm16.length, OUTPUT_SAMPLE_RATE);
      buffer.getChannelData(0).set(pcm16ToFloat(pcm16));
      const node = playback.createBufferSource();
      node.buffer = buffer;
      node.connect(playback.destination);
      // Never behind the clock: a chunk that arrives late starts now rather than
      // in the past, which would drop it silently.
      startAt = Math.max(startAt, playback.currentTime);
      node.start(startAt);
      startAt += buffer.duration;
      playing.push(node);
      node.onended = () => {
        playing = playing.filter((candidate) => candidate !== node);
      };
    },

    stopPlayback(): void {
      for (const node of playing) {
        try {
          node.stop();
        } catch {
          /* already finished */
        }
      }
      playing = [];
      if (playback !== null) startAt = playback.currentTime;
    },

    async dispose(): Promise<void> {
      this.stopPlayback();
      if (processor !== null) {
        processor.onaudioprocess = null;
        try {
          processor.disconnect();
        } catch {
          /* already disconnected */
        }
        processor = null;
      }
      try {
        source?.disconnect();
      } catch {
        /* already disconnected */
      }
      source = null;
      /**
       * THE TRACKS ARE STOPPED EXPLICITLY, and this is the line that matters
       * most in the file. Closing the AudioContext is not enough -- the
       * MediaStreamTrack keeps the microphone open, and the browser keeps showing
       * the recording indicator, until it is stopped.
       */
      for (const track of stream?.getTracks() ?? []) {
        try {
          track.stop();
        } catch {
          /* already stopped */
        }
      }
      stream = null;
      for (const ctx of [context, playback]) {
        try {
          await ctx?.close();
        } catch {
          /* already closed */
        }
      }
      context = null;
      playback = null;
    },
  };
}
