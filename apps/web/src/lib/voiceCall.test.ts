import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_FRAME_MS,
  CLIENT_EVENT,
  IDLE_CALL_STATE,
  PICKUP_GRACE_MS,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  audioAppendFrame,
  base64ToPcm16,
  cancelResponseFrame,
  createCallController,
  decodeRelayFrame,
  floatToPcm16,
  messageForReason,
  pcm16ToBase64,
  pcm16ToFloat,
  relaySocketUrl,
  resampleTo,
  type CallAudio,
  type CallSocket,
  type CallSocketHandlers,
  type CallState,
} from './voiceCall';

/**
 * The browser half of a voice call.
 *
 * Everything worth testing is here rather than in `voiceCallAudio.ts` on
 * purpose: this repo's web tests run in `node` with no DOM, so the protocol, the
 * PCM conversion and the whole call lifecycle are pure or injected, and the
 * untested remainder is the `getUserMedia`/`AudioContext`/`WebSocket` glue that
 * genuinely cannot be exercised without a browser.
 */

/* ------------------------------------------------------------------ *
 * Test doubles
 * ------------------------------------------------------------------ */

function fakeAudio() {
  const played: Int16Array[] = [];
  const calls = { start: 0, stopPlayback: 0, dispose: 0 };
  let onFrame: ((frame: string) => void) | null = null;
  let failWith: Error | null = null;

  const audio: CallAudio = {
    async start(handler) {
      calls.start += 1;
      if (failWith) throw failWith;
      onFrame = handler;
    },
    play(pcm16) {
      played.push(pcm16);
    },
    stopPlayback() {
      calls.stopPlayback += 1;
    },
    async dispose() {
      calls.dispose += 1;
      onFrame = null;
    },
  };

  return {
    audio,
    played,
    calls,
    emitFrame: (frame: string) => onFrame?.(frame),
    failNextStart: (error: Error) => (failWith = error),
  };
}

function fakeSocket() {
  const sent: string[] = [];
  const closes = { count: 0 };
  let handlers: CallSocketHandlers | null = null;
  let openedUrl: string | null = null;

  const socket: CallSocket = {
    send: (data) => sent.push(data),
    close: () => {
      closes.count += 1;
    },
  };

  return {
    sent,
    closes,
    openedUrl: () => openedUrl,
    open: (url: string, incoming: CallSocketHandlers): CallSocket => {
      openedUrl = url;
      handlers = incoming;
      return socket;
    },
    deliver: (payload: unknown) =>
      handlers?.onMessage(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    hangUp: () => handlers?.onClose(),
    fail: () => handlers?.onError(),
  };
}

function harness(
  overrides: { maxSeconds?: number; startRejects?: unknown } = {},
) {
  const audio = fakeAudio();
  const socket = fakeSocket();
  const states: CallState[] = [];
  const api = {
    start: vi.fn(async () => {
      if (overrides.startRejects !== undefined) throw overrides.startRejects;
      return {
        callSession: {
          id: 'call-1',
          status: 'pending' as const,
          voice: 'Serena',
          maxSeconds: overrides.maxSeconds ?? 780,
          startedAt: null,
          endedAt: null,
          durationSeconds: null,
          terminationReason: null,
        },
      };
    }),
    end: vi.fn(async () => ({
      callSession: {
        id: 'call-1',
        status: 'ended' as const,
        voice: 'Serena',
        maxSeconds: 780,
        startedAt: null,
        endedAt: null,
        durationSeconds: 1,
        terminationReason: 'client_ended',
      },
    })),
  };

  let clock = 0;
  const ring = { starts: 0, stops: 0, ringing: false };
  const ringback = {
    start: () => {
      ring.starts += 1;
      ring.ringing = true;
    },
    stop: () => {
      ring.stops += 1;
      ring.ringing = false;
    },
  };
  const controller = createCallController({
    conversationId: 'conv-1',
    audio: audio.audio,
    openSocket: socket.open,
    onState: (state) => states.push(state),
    api,
    now: () => clock,
    ringback,
  });

  return {
    controller,
    ring,
    audio,
    socket,
    api,
    states,
    phases: () => states.map((s) => s.phase),
    advance: (ms: number) => (clock += ms),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * Protocol
 * ------------------------------------------------------------------ */

describe('the frames we send', () => {
  /** These five names are the relay's allowlist; anything else is dropped. */
  it('uses the allowlisted event names', () => {
    expect(CLIENT_EVENT.appendAudio).toBe('input_audio_buffer.append');
    expect(CLIENT_EVENT.commitAudio).toBe('input_audio_buffer.commit');
    expect(CLIENT_EVENT.clearAudio).toBe('input_audio_buffer.clear');
    expect(CLIENT_EVENT.createResponse).toBe('response.create');
    expect(CLIENT_EVENT.cancelResponse).toBe('response.cancel');
  });

  it('carries audio as base64 under `audio`', () => {
    expect(JSON.parse(audioAppendFrame('QUJD'))).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'QUJD',
    });
  });

  it('cancels a response with no payload at all', () => {
    expect(JSON.parse(cancelResponseFrame())).toEqual({ type: 'response.cancel' });
  });

  /**
   * The relay closes the call on a frame over 64 KiB, treating it as hostile.
   * One capture frame has to stay a long way under that.
   */
  it('keeps one capture frame far below the relay limit', () => {
    const samples = (INPUT_SAMPLE_RATE * CAPTURE_FRAME_MS) / 1000;
    const frame = audioAppendFrame(pcm16ToBase64(new Int16Array(samples)));
    expect(samples).toBe(640);
    expect(frame.length).toBeLessThan(4_000);
  });

  it('builds the relay URL from our own API origin, never a provider', () => {
    expect(relaySocketUrl('abc', 'https://api.example.com')).toBe(
      'wss://api.example.com/api/calls/abc/socket',
    );
    expect(relaySocketUrl('abc', 'http://localhost:3001')).toBe(
      'ws://localhost:3001/api/calls/abc/socket',
    );
    expect(relaySocketUrl('a/b', 'https://api.example.com')).toContain('a%2Fb');
  });
});

describe('the frames we receive', () => {
  it.each([
    [{ type: 'relay.connected' }, { kind: 'connected' }],
    [{ type: 'relay.closed', reason: 'client_closed' }, { kind: 'closed', reason: 'client_closed' }],
    [{ type: 'relay.error', reason: 'voice_unavailable' }, { kind: 'error', reason: 'voice_unavailable' }],
    [{ type: 'response.audio.delta', delta: 'QUJD' }, { kind: 'audio', delta: 'QUJD' }],
    [{ type: 'input_audio_buffer.speech_started' }, { kind: 'speechStarted' }],
    [{ type: 'input_audio_buffer.speech_stopped' }, { kind: 'speechStopped' }],
    [{ type: 'spicy.session_expired' }, { kind: 'expired' }],
    [
      { type: 'error', error: { code: 'content_blocked' } },
      { kind: 'providerError', code: 'content_blocked' },
    ],
    [
      { type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' },
      { kind: 'transcript', speaker: 'user', text: 'hello' },
    ],
    [
      { type: 'response.audio_transcript.done', transcript: 'hi there' },
      { kind: 'transcript', speaker: 'character', text: 'hi there' },
    ],
  ])('decodes %j', (frame, expected) => {
    expect(decodeRelayFrame(JSON.stringify(frame))).toEqual(expected);
  });

  /** A socket message handler is the last place that should be able to throw. */
  it.each(['not json', 'null', '"a string"', '{}', '{"type":42}'])('never throws on %s', (raw) => {
    expect(() => decodeRelayFrame(raw)).not.toThrow();
    expect(decodeRelayFrame(raw).kind).toBe('ignored');
  });

  it('ignores a known-but-unused event rather than failing', () => {
    expect(decodeRelayFrame(JSON.stringify({ type: 'response.done' }))).toEqual({
      kind: 'ignored',
      type: 'response.done',
    });
  });

  it('substitutes a generic code for a provider error that carries none', () => {
    expect(decodeRelayFrame(JSON.stringify({ type: 'error' }))).toEqual({
      kind: 'providerError',
      code: 'provider_error',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Audio conversion
 * ------------------------------------------------------------------ */

describe('PCM conversion', () => {
  it('clamps rather than wrapping, so a hot sample is not a click', () => {
    const out = floatToPcm16(Float32Array.from([0, 1, -1, 1.5, -1.5]));
    expect([...out]).toEqual([0, 32767, -32768, 32767, -32768]);
  });

  it('round-trips through float and back within one step', () => {
    const original = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    const back = floatToPcm16(pcm16ToFloat(original));
    for (let i = 0; i < original.length; i += 1) {
      expect(Math.abs(back[i]! - original[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it('round-trips through base64', () => {
    const original = Int16Array.from([0, 1234, -4321, 32767, -32768]);
    expect([...base64ToPcm16(pcm16ToBase64(original))]).toEqual([...original]);
  });

  it('survives a base64 payload with an odd byte count', () => {
    // A truncated frame must not make a misaligned Int16Array throw.
    expect(() => base64ToPcm16(btoa('abc'))).not.toThrow();
    expect(base64ToPcm16(btoa('abc')).length).toBe(1);
  });

  it('resamples 48 kHz down to the provider input rate', () => {
    const input = new Float32Array(480); // 10 ms at 48 kHz
    const out = resampleTo(input, 48_000, INPUT_SAMPLE_RATE);
    expect(out.length).toBe(160); // 10 ms at 16 kHz
  });

  it('leaves audio alone when the rate already matches', () => {
    const input = Float32Array.from([0.1, 0.2]);
    expect(resampleTo(input, INPUT_SAMPLE_RATE, INPUT_SAMPLE_RATE)).toBe(input);
  });

  it('states the provider rates it was built against', () => {
    expect(INPUT_SAMPLE_RATE).toBe(16_000);
    expect(OUTPUT_SAMPLE_RATE).toBe(24_000);
  });
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

describe('starting a call', () => {
  it('asks for the microphone first, then claims the call', async () => {
    const h = harness();
    await h.controller.start();

    // The microphone comes BEFORE the claim, so a refusal costs no session.
    expect(h.audio.calls.start).toBe(1);
    expect(h.api.start).toHaveBeenCalledTimes(1);
    expect(h.phases()).toEqual(['permission', 'connecting', 'connecting']);
    expect(h.socket.openedUrl()).toContain('/api/calls/call-1/socket');

    h.socket.deliver({ type: 'relay.connected' });
    expect(h.controller.state.phase).toBe('active');
  });

  /** Like a phone: nothing he says is sent while it rings (see the ringback tests). */
  it('streams microphone frames once she has picked up', async () => {
    const h = harness();
    await h.controller.start();
    h.socket.deliver({ type: 'relay.connected' });
    h.socket.deliver({ type: 'response.audio.delta', delta: pcm16ToBase64(Int16Array.from([1])) });

    h.audio.emitFrame('QUJD');
    expect(h.socket.sent).toEqual([
      JSON.stringify({ type: 'input_audio_buffer.append', audio: 'QUJD' }),
    ]);
  });

  /** A double-click must not buy two calls. */
  it('returns the same attempt for a repeated start', async () => {
    const h = harness();
    const first = h.controller.start();
    const second = h.controller.start();
    expect(second).toBe(first);
    await first;
    expect(h.api.start).toHaveBeenCalledTimes(1);
    expect(h.audio.calls.start).toBe(1);
  });

  it('refuses to start while a call is already active', async () => {
    const h = harness();
    await h.controller.start();
    h.socket.deliver({ type: 'relay.connected' });

    await h.controller.start();
    expect(h.api.start).toHaveBeenCalledTimes(1);
  });

  it('tells the person what to do when the microphone is refused', async () => {
    const h = harness();
    h.audio.failNextStart(new Error('microphone_denied'));
    await h.controller.start();

    expect(h.controller.state.phase).toBe('error');
    expect(h.controller.state.message).toContain('Allow it in the address bar');
    // Nothing was claimed, so there is no call to settle.
    expect(h.api.start).not.toHaveBeenCalled();
    expect(h.audio.calls.dispose).toBe(1);
  });

  it('reports a missing microphone differently from a refused one', async () => {
    const h = harness();
    h.audio.failNextStart(new Error('microphone_missing'));
    await h.controller.start();
    expect(h.controller.state.message).toContain('No microphone was found');
  });

  it('maps a server refusal to our own sentence, never the slug', async () => {
    const h = harness({ startRejects: { code: 'user_busy' } });
    await h.controller.start();

    expect(h.controller.state.phase).toBe('error');
    expect(h.controller.state.message).toBe('You are already on a call. End that one first.');
    expect(h.controller.state.message).not.toContain('user_busy');
    // The microphone is released even though the call never started.
    expect(h.audio.calls.dispose).toBe(1);
  });
});

describe('during a call', () => {
  const connected = async () => {
    const h = harness();
    await h.controller.start();
    h.socket.deliver({ type: 'relay.connected' });
    return h;
  };

  it('plays her audio and shows that she is speaking', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'response.audio.delta', delta: pcm16ToBase64(Int16Array.from([1, 2])) });

    expect(h.controller.state.characterSpeaking).toBe(true);
    expect(h.audio.played).toHaveLength(1);
    expect([...h.audio.played[0]!]).toEqual([1, 2]);
  });

  /** BARGE-IN: talking over her stops her, locally and upstream. */
  it('drops queued playback and cancels her turn when the person talks over her', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'response.audio.delta', delta: pcm16ToBase64(Int16Array.from([1])) });
    h.socket.sent.length = 0;

    h.socket.deliver({ type: 'input_audio_buffer.speech_started' });

    expect(h.audio.calls.stopPlayback).toBe(1);
    expect(h.socket.sent).toEqual([JSON.stringify({ type: 'response.cancel' })]);
    expect(h.controller.state.userSpeaking).toBe(true);
    expect(h.controller.state.characterSpeaking).toBe(false);
  });

  it('does not cancel a turn she was not taking', async () => {
    const h = await connected();
    h.socket.sent.length = 0;
    h.socket.deliver({ type: 'input_audio_buffer.speech_started' });

    // Playback is still flushed -- cheap and harmless -- but nothing is cancelled.
    expect(h.audio.calls.stopPlayback).toBe(1);
    expect(h.socket.sent).toEqual([]);
  });

  it('collects both sides of the transcript in order', async () => {
    const h = await connected();
    h.socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello there',
    });
    h.socket.deliver({ type: 'response.audio_transcript.done', transcript: 'hello yourself' });

    expect(h.controller.state.transcript).toEqual([
      { speaker: 'user', text: 'hello there' },
      { speaker: 'character', text: 'hello yourself' },
    ]);
    // Her finished transcript means that turn is over.
    expect(h.controller.state.characterSpeaking).toBe(false);
  });

  it('ignores an empty transcript rather than showing a blank line', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'response.audio_transcript.done', transcript: '   ' });
    expect(h.controller.state.transcript).toEqual([]);
  });

  it('counts down the time left and ends at the ceiling', async () => {
    vi.useFakeTimers();
    const h = harness({ maxSeconds: 3 });
    await h.controller.start();
    h.socket.deliver({ type: 'relay.connected' });
    expect(h.controller.state.secondsRemaining).toBe(3);

    h.advance(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.controller.state.secondsRemaining).toBe(2);

    h.advance(3_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.controller.state.phase).toBe('ended');
    expect(h.audio.calls.dispose).toBe(1);
  });
});

describe('ending a call', () => {
  const connected = async () => {
    const h = harness();
    await h.controller.start();
    h.socket.deliver({ type: 'relay.connected' });
    return h;
  };

  it('hangs up, releases the microphone and settles the call', async () => {
    const h = await connected();
    await h.controller.hangUp();

    expect(h.phases()).toContain('ending');
    expect(h.controller.state.phase).toBe('ended');
    expect(h.controller.state.message).toBeNull();
    expect(h.audio.calls.dispose).toBe(1);
    expect(h.socket.closes.count).toBe(1);
    expect(h.api.end).toHaveBeenCalledWith('call-1');
  });

  it('is safe to hang up twice', async () => {
    const h = await connected();
    await h.controller.hangUp();
    await h.controller.hangUp();
    expect(h.audio.calls.dispose).toBe(1);
    expect(h.api.end).toHaveBeenCalledTimes(1);
  });

  it('treats the provider expiring as a normal ending', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'spicy.session_expired' });
    await Promise.resolve();

    expect(h.controller.state.phase).toBe('ended');
    expect(h.controller.state.message).toBeNull();
    expect(h.audio.calls.dispose).toBe(1);
  });

  it('treats a clean relay close as an ending', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'relay.closed', reason: 'client_closed' });
    await Promise.resolve();
    expect(h.controller.state.phase).toBe('ended');
  });

  it.each([
    ['provider_unavailable', 'She could not be reached just now. Try again in a moment.'],
    ['max_duration', 'The call reached its time limit.'],
    /**
     * The reason the server gained. It already decoded to the right sentence
     * from a mid-call `error` frame; what was missing was any way for a call
     * REFUSED BEFORE IT STARTED to say so, and that arrives as a close.
     */
    ['content_blocked', 'That could not be continued.'],
  ])('treats a %s close as a failure with our own words', async (reason, message) => {
    const h = await connected();
    h.socket.deliver({ type: 'relay.closed', reason });
    await Promise.resolve();
    expect(h.controller.state.phase).toBe('error');
    expect(h.controller.state.message).toBe(message);
  });

  /**
   * A refusal is a FAILURE, not a tidy ending. If `content_blocked` were ever
   * treated as a clean close the overlay would read "Call ended" and say nothing
   * at all, which is the same silence the old wrong message replaced.
   */
  it('never treats a refusal as a clean hang-up', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'relay.closed', reason: 'content_blocked' });
    await Promise.resolve();
    expect(h.controller.state.phase).not.toBe('ended');
    expect(h.controller.state.message).not.toBeNull();
    // And never the advice that cannot work: this will fail the same way again.
    expect(h.controller.state.message).not.toContain('could not be reached');
  });

  it('reports a provider error by code, never by message', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'error', error: { code: 'content_blocked' } });
    await Promise.resolve();
    expect(h.controller.state.phase).toBe('error');
    expect(h.controller.state.message).toBe('That could not be continued.');
  });

  it('treats a socket that simply drops as a connection failure', async () => {
    const h = await connected();
    h.socket.fail();
    await Promise.resolve();
    expect(h.controller.state.phase).toBe('error');
    expect(h.audio.calls.dispose).toBe(1);
  });

  /** The first reason wins: a stampede of endings is still one ending. */
  it('settles once when several endings arrive together', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'relay.closed', reason: 'provider_unavailable' });
    h.socket.deliver({ type: 'error', error: { code: 'content_blocked' } });
    h.socket.hangUp();
    await Promise.resolve();

    expect(h.controller.state.message).toBe('She could not be reached just now. Try again in a moment.');
    expect(h.audio.calls.dispose).toBe(1);
    expect(h.api.end).toHaveBeenCalledTimes(1);
  });

  it('stops sending audio after the call is over', async () => {
    const h = await connected();
    await h.controller.hangUp();
    h.socket.sent.length = 0;
    h.audio.emitFrame('QUJD');
    expect(h.socket.sent).toEqual([]);
  });

  /** Unmount and navigation. The microphone must go out even with no UI left. */
  it('releases everything on dispose without emitting state', async () => {
    const h = await connected();
    const before = h.states.length;
    await h.controller.dispose();

    expect(h.audio.calls.dispose).toBe(1);
    expect(h.socket.closes.count).toBe(1);
    expect(h.api.end).toHaveBeenCalledWith('call-1');
    // Nothing emitted: the component is going away.
    expect(h.states.length).toBe(before);
  });

  it('can start a fresh call after one ended', async () => {
    const h = await connected();
    await h.controller.hangUp();
    await h.controller.start();
    expect(h.api.start).toHaveBeenCalledTimes(2);
    expect(h.audio.calls.start).toBe(2);
  });
});

describe('what a person is told', () => {
  it('never shows a raw slug', () => {
    for (const reason of [
      'microphone_denied',
      'voice_unavailable',
      'already_connecting',
      'provider_unavailable',
      'content_blocked',
      'payment_required',
      'wat_is_this',
    ]) {
      const message = messageForReason(reason);
      expect(message).not.toContain('_');
      expect(message.endsWith('.')).toBe(true);
    }
  });

  it('starts from a state with nothing in it', () => {
    expect(IDLE_CALL_STATE).toEqual({
      phase: 'idle',
      characterSpeaking: false,
      userSpeaking: false,
      secondsRemaining: null,
      transcript: [],
      message: null,
      answered: false,
    });
  });
});

describe('she picks up: "Calling…" until her first word', () => {
  const connected = async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.start();
    h.socket.deliver({ type: 'relay.connected' });
    return h;
  };

  it('the call is active at once, but not yet answered', async () => {
    const h = await connected();
    expect(h.controller.state.phase).toBe('active');
    expect(h.controller.state.answered).toBe(false);
  });

  it('answered on her first audio', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'response.audio.delta', delta: pcm16ToBase64(Int16Array.from([1, 2])) });
    expect(h.controller.state.answered).toBe(true);
  });

  it('answered if he speaks first', async () => {
    const h = await connected();
    h.socket.deliver({ type: 'input_audio_buffer.speech_started' });
    expect(h.controller.state.answered).toBe(true);
  });

  it('never stuck on "Calling…": answered after the grace period anyway', async () => {
    const h = await connected();
    await vi.advanceTimersByTimeAsync(PICKUP_GRACE_MS - 1);
    expect(h.controller.state.answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.controller.state.answered).toBe(true);
  });

  it('a call that ends before she answers leaves no timer behind', async () => {
    const h = await connected();
    await h.controller.hangUp();
    const after = h.states.length;
    await vi.advanceTimersByTimeAsync(PICKUP_GRACE_MS * 2);
    expect(h.states.length).toBe(after);
    expect(h.controller.state.phase).toBe('ended');
  });
});

describe('the ringback tone, and the line is open only once she answers', () => {
  const herFirstWords = () => ({ type: 'response.audio.delta', delta: pcm16ToBase64(Int16Array.from([1, 2])) });
  const ringing = async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.start();
    return h;
  };

  it('rings from "Calling…" -- before the socket even connects', async () => {
    const h = await ringing();
    expect(h.controller.state.phase).toBe('connecting');
    expect(h.ring.ringing).toBe(true);
    expect(h.ring.starts).toBe(1);
  });

  it('keeps ringing once connected, until she picks up', async () => {
    const h = await ringing();
    h.socket.deliver({ type: 'relay.connected' });
    expect(h.ring.ringing).toBe(true);
    h.socket.deliver(herFirstWords());
    expect(h.ring.ringing).toBe(false);
    expect(h.controller.state.answered).toBe(true);
  });

  it('nothing he says is sent while it rings; everything after she answers is', async () => {
    const h = await ringing();
    h.socket.deliver({ type: 'relay.connected' });
    h.audio.emitFrame('UklORw=='); // the ring, or him, before she picked up
    expect(h.socket.sent).toHaveLength(0);
    h.socket.deliver(herFirstWords());
    h.audio.emitFrame('QUJD');
    expect(h.socket.sent).toEqual([JSON.stringify({ type: 'input_audio_buffer.append', audio: 'QUJD' })]);
  });

  it('if she never speaks, the ring stops and the line opens after the grace period', async () => {
    const h = await ringing();
    h.socket.deliver({ type: 'relay.connected' });
    await vi.advanceTimersByTimeAsync(PICKUP_GRACE_MS);
    expect(h.ring.ringing).toBe(false);
    h.audio.emitFrame('QUJD');
    expect(h.socket.sent).toHaveLength(1);
  });

  it.each([
    ['hanging up while it rings', async (h: Awaited<ReturnType<typeof ringing>>) => h.controller.hangUp()],
    ['the call failing while it rings', async (h: Awaited<ReturnType<typeof ringing>>) => h.socket.deliver({ type: 'relay.error', reason: 'provider_unavailable' })],
    ['leaving the page while it rings', async (h: Awaited<ReturnType<typeof ringing>>) => h.controller.dispose()],
  ])('the ring stops on %s', async (_label, end) => {
    const h = await ringing();
    await end(h);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.ring.ringing).toBe(false);
  });

  it('a call with no ringback (tests, or no audio) still works', async () => {
    vi.useFakeTimers();
    const audio = { start: vi.fn(async () => {}), play: vi.fn(), stopPlayback: vi.fn(), dispose: vi.fn(async () => {}) };
    const controller = createCallController({
      conversationId: 'c',
      audio,
      openSocket: () => ({ send: () => {}, close: () => {} }),
      onState: () => {},
      api: { start: vi.fn(async () => ({ callSession: { id: 'x', maxSeconds: 60 } })) as never, end: vi.fn(async () => ({})) as never },
    });
    await controller.start();
    expect(controller.state.phase).toBe('connecting');
    await controller.dispose();
  });
});
