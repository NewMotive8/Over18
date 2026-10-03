import { API_URL, callsApi, type VoiceCallSession } from './api';
import { announceCreditsChanged } from './creditsStore';

/**
 * The browser half of a live voice call (Phase 2B).
 *
 * ── WHAT THIS FILE IS NOT ────────────────────────────────────────────────────
 *
 * It is not a provider client. There is no provider URL here, no API key, no
 * client secret, and no code that could use one. The only socket it opens is to
 * our own API at `/api/calls/:id/socket`, authenticated by the session cookie
 * the browser already holds. The server creates the provider session when that
 * socket connects and relays every frame in both directions, because a probe of
 * the live API established that a client connected directly can read the
 * compiled persona back out of it.
 *
 * ── WHY THE BROWSER PARTS ARE SOMEWHERE ELSE ─────────────────────────────────
 *
 * Everything in here is a pure function or a state machine over injected
 * dependencies, because the web test environment is `node` with no DOM (see
 * apps/web/vitest.config.ts). The microphone, the AudioContext and the real
 * WebSocket live in `voiceCallAudio.ts` behind the two small interfaces below,
 * so the protocol, the lifecycle and the PCM conversion can all be tested and
 * only the irreducible browser glue needs a real browser.
 */

/* ------------------------------------------------------------------ *
 * The protocol, taken from the relay rather than guessed
 * ------------------------------------------------------------------ */

/**
 * The only event types the relay will forward upstream.
 *
 * Copied from `CLIENT_TO_PROVIDER_ALLOWLIST` in apps/api/src/voice/
 * relay-protocol.ts. Anything else is dropped by the server, silently, so
 * sending it would simply not work.
 */
export const CLIENT_EVENT = {
  appendAudio: 'input_audio_buffer.append',
  commitAudio: 'input_audio_buffer.commit',
  clearAudio: 'input_audio_buffer.clear',
  createResponse: 'response.create',
  cancelResponse: 'response.cancel',
} as const;

/**
 * The relay's own notices, distinct from anything the provider sends.
 * From `RELAY_EVENTS` in relay-protocol.ts.
 */
export const RELAY_EVENT = {
  connected: 'relay.connected',
  closed: 'relay.closed',
  error: 'relay.error',
} as const;

/**
 * Audio formats, as the provider documents them in its session response:
 * `input_audio: 'pcm16 mono 16 kHz'`, `output_audio: 'pcm16 mono 24 kHz'`.
 * Recorded in apps/api/src/test/voice-provider.test.ts.
 *
 * They are constants here because the server does not pass them on -- its
 * `VoiceSession` type drops both fields, so there is nothing to read at runtime.
 */
export const INPUT_SAMPLE_RATE = 16_000;
export const OUTPUT_SAMPLE_RATE = 24_000;

/**
 * How much audio goes in one frame.
 *
 * The relay refuses anything over 64 KiB (`MAX_CLIENT_FRAME_BYTES`) and treats
 * an oversized frame as hostile rather than clumsy -- it closes the call. 40 ms
 * of 16 kHz mono PCM16 is 1,280 bytes, about 1.7 KB of base64, which leaves the
 * limit a long way off while keeping latency low enough to feel like talking.
 */
export const CAPTURE_FRAME_MS = 40;

/* ------------------------------------------------------------------ *
 * PCM conversion
 * ------------------------------------------------------------------ */

/** Float samples in [-1, 1] to signed 16-bit, clamped rather than wrapped. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    // Clamping matters: a sample slightly over 1 would wrap to a loud negative
    // and arrive as a click.
    const clamped = Math.max(-1, Math.min(1, input[i]!));
    out[i] = Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff));
  }
  return out;
}

/** Signed 16-bit back to float, for playback through a Web Audio buffer. */
export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i]!;
    out[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }
  return out;
}

/**
 * Nearest-neighbour resample to the provider's input rate.
 *
 * DELIBERATELY THE SIMPLE ONE. A browser gives us whatever rate its hardware
 * prefers -- usually 48 kHz -- and the provider wants 16. Proper resampling
 * wants a low-pass filter first, and the difference is audible on music; on one
 * person talking into a laptop microphone, through a speech model, it is not
 * what will limit quality. If it ever is, this is the one function to replace.
 */
export function resampleTo(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = input[Math.floor(i * ratio)] ?? 0;
  }
  return out;
}

/** PCM16 to base64, which is how the provider's JSON transport carries audio. */
export function pcm16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  // Chunked: spreading a large array into String.fromCharCode overflows the
  // call stack somewhere around a hundred thousand samples.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 back to PCM16, for the audio the character speaks. */
export function base64ToPcm16(encoded: string): Int16Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // A truncated frame would make a misaligned Int16Array throw, so the length is
  // rounded down to whole samples rather than trusted.
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

/* ------------------------------------------------------------------ *
 * Frames
 * ------------------------------------------------------------------ */

/** One frame of microphone audio, ready to send. */
export function audioAppendFrame(base64Audio: string): string {
  return JSON.stringify({ type: CLIENT_EVENT.appendAudio, audio: base64Audio });
}

/** Asks the character to stop talking. Used for barge-in. */
export function cancelResponseFrame(): string {
  return JSON.stringify({ type: CLIENT_EVENT.cancelResponse });
}

/** What the UI needs from a frame the relay sent us. */
export type RelayMessage =
  | { kind: 'connected' }
  | { kind: 'closed'; reason: string }
  | { kind: 'error'; reason: string }
  /** Base64 PCM16 at OUTPUT_SAMPLE_RATE. */
  | { kind: 'audio'; delta: string }
  /** The person started or stopped speaking, per the provider's own VAD. */
  | { kind: 'speechStarted' }
  | { kind: 'speechStopped' }
  /** A finished line of transcript, from one side or the other. */
  | { kind: 'transcript'; speaker: 'user' | 'character'; text: string }
  /** The provider's own session clock ran out. */
  | { kind: 'expired' }
  /** A provider error, reduced by the relay to a documented short code. */
  | { kind: 'providerError'; code: string }
  /** Anything else the relay forwards: known, harmless, not acted on here. */
  | { kind: 'ignored'; type: string };

/**
 * Reads one relay frame.
 *
 * Total by construction: an unparsable or unexpected frame becomes `ignored`
 * rather than throwing, because a socket message handler is the last place that
 * should be able to take the call down. Every type named here is one the relay
 * can actually send -- see `PROVIDER_EVENT_BUILDERS` and `RELAY_EVENTS`.
 */
export function decodeRelayFrame(raw: string): RelayMessage {
  let event: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'ignored', type: '<none>' };
    event = parsed as Record<string, unknown>;
  } catch {
    return { kind: 'ignored', type: '<unparsable>' };
  }
  const type = typeof event.type === 'string' ? event.type : '<none>';
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');

  switch (type) {
    case RELAY_EVENT.connected:
      return { kind: 'connected' };
    case RELAY_EVENT.closed:
      return { kind: 'closed', reason: text(event.reason) || 'closed' };
    case RELAY_EVENT.error:
      return { kind: 'error', reason: text(event.reason) || 'error' };
    case 'response.audio.delta':
      return { kind: 'audio', delta: text(event.delta) };
    case 'input_audio_buffer.speech_started':
      return { kind: 'speechStarted' };
    case 'input_audio_buffer.speech_stopped':
      return { kind: 'speechStopped' };
    case 'conversation.item.input_audio_transcription.completed':
      return { kind: 'transcript', speaker: 'user', text: text(event.transcript) };
    case 'response.audio_transcript.done':
      return { kind: 'transcript', speaker: 'character', text: text(event.transcript) };
    case 'spicy.session_expired':
      return { kind: 'expired' };
    case 'error':
      return {
        kind: 'providerError',
        code: text((event.error as Record<string, unknown> | undefined)?.code) || 'provider_error',
      };
    default:
      return { kind: 'ignored', type };
  }
}

/* ------------------------------------------------------------------ *
 * What the UI sees
 * ------------------------------------------------------------------ */

export type CallPhase =
  /** Nothing happening. The button is available. */
  | 'idle'
  /** Asking for the microphone. The browser is showing its own prompt. */
  | 'permission'
  /** Claiming the call and opening the socket. */
  | 'connecting'
  /** Talking. */
  | 'active'
  /** Hanging up: the socket is closing and the call is being settled. */
  | 'ending'
  /** Over, normally. */
  | 'ended'
  /** Over, not normally. `message` says what a person can do about it. */
  | 'error';

/** One line of what was said, newest last. Display only -- never persisted here. */
export interface CallTranscriptLine {
  speaker: 'user' | 'character';
  text: string;
}

export interface CallState {
  phase: CallPhase;
  /** True while the character is speaking, so the UI can show it. */
  characterSpeaking: boolean;
  /** True while the person is speaking, per the provider's VAD. */
  userSpeaking: boolean;
  /** Seconds remaining of the call's ceiling, once known. */
  secondsRemaining: number | null;
  transcript: CallTranscriptLine[];
  /** Set in `error`, and only ever one of our own sentences. */
  message: string | null;
  /**
   * She has PICKED UP -- for the screen only. The call is `active` (socket
   * open, microphone streaming) a couple of seconds before she can speak,
   * because the provider still has to set up and screen her opening cue. A
   * phone shows "Calling…" until the other side answers, so this does too: it
   * turns true on her first audio, on his first speech, or after
   * PICKUP_GRACE_MS so a call can never look stuck. It changes nothing about
   * what the call does.
   */
  answered: boolean;
}

/** The longest "Calling…" may stay up once the call is active. */
export const PICKUP_GRACE_MS = 4_000;

export const IDLE_CALL_STATE: CallState = {
  phase: 'idle',
  characterSpeaking: false,
  userSpeaking: false,
  secondsRemaining: null,
  transcript: [],
  message: null,
  answered: false,
};

/**
 * What a person is told, by cause.
 *
 * OUR WORDS, NOT THE SERVER'S. The relay sends short machine slugs
 * (`voice_unavailable`, `already_connecting`, `provider_unavailable`) and a
 * provider error is reduced to a code. None of that is shown; each maps to a
 * sentence that says what happened and what to do, and anything unrecognised
 * falls back to a generic one rather than leaking a slug into the interface.
 */
export function messageForReason(reason: string): string {
  switch (reason) {
    case 'microphone_denied':
      return 'Your browser blocked microphone access. Allow it in the address bar, then try again.';
    case 'microphone_missing':
      return 'No microphone was found. Connect one and try again.';
    case 'voice_unavailable':
      return 'Calls are not available yet.';
    case 'already_connecting':
    case 'user_busy':
      return 'You are already on a call. End that one first.';
    case 'not_found':
      return 'This conversation could not be found.';
    case 'forbidden_origin':
    case 'server_error':
      return 'Something went wrong on our side. Try again in a moment.';
    case 'provider_unavailable':
    case 'provider_timeout':
      return 'She could not be reached just now. Try again in a moment.';
    case 'content_blocked':
      return 'That could not be continued.';
    case 'payment_required':
      return 'Calls are not available on your plan right now.';
    case 'max_duration':
      return 'The call reached its time limit.';
    case 'session_expired':
      return 'The call timed out.';
    default:
      return 'The call ended unexpectedly. Try again in a moment.';
  }
}

/** Reasons the relay sends when a call simply finished, not failed. */
const CLEAN_CLOSE_REASONS = new Set(['client_closed', 'client_ended', 'provider_closed']);

/* ------------------------------------------------------------------ *
 * The injected browser pieces
 * ------------------------------------------------------------------ */

/** The socket, narrowed to what the controller uses. */
export interface CallSocket {
  send(data: string): void;
  close(): void;
}

export interface CallSocketHandlers {
  onMessage: (raw: string) => void;
  onClose: () => void;
  onError: () => void;
}

/** Microphone capture and speaker playback. Implemented in voiceCallAudio.ts. */
export interface CallAudio {
  /**
   * Opens the microphone and starts delivering frames.
   * Rejects with a `reason` the message map knows when permission is refused.
   */
  start(onFrame: (base64Pcm16: string) => void): Promise<void>;
  /** Queues one chunk of the character's speech for playback. */
  play(pcm16: Int16Array): void;
  /** Drops anything queued but not yet heard. Barge-in. */
  stopPlayback(): void;
  /** Releases the microphone track, the context and everything else. */
  dispose(): Promise<void>;
}

export interface CallControllerDeps {
  conversationId: string;
  audio: CallAudio;
  /** Opens the relay socket. Injected so tests need no WebSocket. */
  openSocket: (url: string, handlers: CallSocketHandlers) => CallSocket;
  onState: (state: CallState) => void;
  /** Overridable for tests; defaults to the real REST client. */
  api?: Pick<typeof callsApi, 'start' | 'end'>;
  /** Injected so the duration countdown is testable. */
  now?: () => number;
}

export interface CallController {
  start: () => Promise<void>;
  /** Hang up. Safe to call at any phase, including twice. */
  hangUp: () => Promise<void>;
  /** Release everything. Called on unmount and on navigation. */
  dispose: () => Promise<void>;
  readonly state: CallState;
}

/**
 * The relay socket's URL.
 *
 * `ws://` or `wss://` derived from the API's own origin, so a call goes to the
 * same place every other request does and the session cookie applies. No
 * provider host is involved, and none could be: the browser has never been told
 * one.
 */
export function relaySocketUrl(callSessionId: string, apiUrl: string = API_URL): string {
  const base = apiUrl.replace(/^http/, 'ws').replace(/\/$/, '');
  return `${base}/api/calls/${encodeURIComponent(callSessionId)}/socket`;
}

/**
 * The call, as a state machine.
 *
 * ── ONE CALL AT A TIME, WHATEVER THE USER DOES ───────────────────────────────
 *
 * `start()` is guarded two ways. A second call while one is in flight returns
 * the SAME promise rather than starting again, so a double-click or two
 * components mounting cannot claim twice; and anything other than `idle`,
 * `ended` or `error` is refused outright. The server refuses a second claim too
 * -- it has its own atomic guard -- but a browser that relies on a 409 to notice
 * its own double-click has already shown the person an error it caused itself.
 *
 * ── EVERY EXIT RELEASES THE MICROPHONE ───────────────────────────────────────
 *
 * Hanging up, the provider expiring, the socket dropping, the ceiling being
 * reached, navigating away and unmounting all converge on `finish()`, which
 * disposes the audio and closes the socket exactly once. A microphone left live
 * after a call is the single most alarming bug this feature could ship.
 */
export function createCallController(deps: CallControllerDeps): CallController {
  const api = deps.api ?? callsApi;
  const now = deps.now ?? (() => Date.now());

  let state: CallState = { ...IDLE_CALL_STATE };
  let socket: CallSocket | null = null;
  let sessionId: string | null = null;
  let starting: Promise<void> | null = null;
  let finished = false;
  let countdown: ReturnType<typeof setInterval> | null = null;
  let deadline: number | null = null;
  let pickup: ReturnType<typeof setTimeout> | null = null;

  const emit = (patch: Partial<CallState>): void => {
    state = { ...state, ...patch };
    deps.onState(state);
  };

  const clearPickup = (): void => {
    if (pickup !== null) {
      clearTimeout(pickup);
      pickup = null;
    }
  };

  /** She picked up (or it is time to stop saying "Calling…"). Once. */
  const markAnswered = (): void => {
    clearPickup();
    if (!state.answered) emit({ answered: true });
  };

  const clearCountdown = (): void => {
    if (countdown !== null) {
      clearInterval(countdown);
      countdown = null;
    }
    deadline = null;
  };

  /**
   * Ends the call once, from whichever direction reached here first.
   *
   * `finished` is what makes it once: a provider hang-up, a socket error and the
   * person pressing End can all arrive together, and the first reason is the one
   * the person is shown.
   */
  const finish = async (phase: 'ended' | 'error', reason: string | null): Promise<void> => {
    if (finished) return;
    finished = true;
    clearCountdown();
    clearPickup();

    try {
      socket?.close();
    } catch {
      /* already gone */
    }
    socket = null;

    // Always, before anything that can fail: the microphone light goes out.
    try {
      await deps.audio.dispose();
    } catch {
      /* nothing left to release */
    }

    emit({
      phase,
      characterSpeaking: false,
      userSpeaking: false,
      secondsRemaining: null,
      message: phase === 'error' ? messageForReason(reason ?? 'unknown') : null,
    });

    // Best effort, and deliberately last. The server settles the call from its
    // own socket closing, so this is belt and braces for the case where the
    // socket never opened at all.
    if (sessionId !== null) {
      const id = sessionId;
      sessionId = null;
      try {
        await api.end(id);
      } catch {
        /* the server settles it from the closed socket, or the deadline does */
      }
    }
    // A call may have spent Credits: every balance on screen asks the server again.
    announceCreditsChanged();
  };

  const handleMessage = (raw: string): void => {
    if (finished) return;
    const message = decodeRelayFrame(raw);
    switch (message.kind) {
      case 'connected':
        emit({ phase: 'active', answered: false });
        clearPickup();
        pickup = setTimeout(markAnswered, PICKUP_GRACE_MS);
        return;

      case 'audio':
        if (message.delta.length === 0) return;
        emit({ characterSpeaking: true });
        markAnswered();
        deps.audio.play(base64ToPcm16(message.delta));
        return;

      /**
       * BARGE-IN. The provider's VAD heard the person start talking over her, so
       * what is already queued for playback is dropped and she is told to stop.
       * Without the local drop she would keep talking out of the speaker for as
       * long as the buffer held, which is exactly what makes a voice assistant
       * feel like a recording rather than a conversation.
       */
      case 'speechStarted':
        deps.audio.stopPlayback();
        if (state.characterSpeaking) {
          try {
            socket?.send(cancelResponseFrame());
          } catch {
            /* the socket is going; the close handler will finish the call */
          }
        }
        emit({ userSpeaking: true, characterSpeaking: false });
        markAnswered();
        return;

      case 'speechStopped':
        emit({ userSpeaking: false });
        return;

      case 'transcript':
        if (message.text.trim().length === 0) return;
        emit({
          transcript: [...state.transcript, { speaker: message.speaker, text: message.text }],
          // Her transcript arriving means that turn is finished.
          characterSpeaking: message.speaker === 'character' ? false : state.characterSpeaking,
        });
        return;

      case 'expired':
        void finish('ended', null);
        return;

      case 'closed':
        void finish(CLEAN_CLOSE_REASONS.has(message.reason) ? 'ended' : 'error', message.reason);
        return;

      case 'error':
        void finish('error', message.reason);
        return;

      case 'providerError':
        void finish('error', message.code);
        return;

      case 'ignored':
        return;
    }
  };

  const run = async (): Promise<void> => {
    // The microphone first, so a refusal costs nothing: no call is claimed and
    // no session is created until there is something to send into it.
    emit({ ...IDLE_CALL_STATE, phase: 'permission' });
    try {
      await deps.audio.start((frame) => {
        if (finished || socket === null) return;
        try {
          socket.send(audioAppendFrame(frame));
        } catch {
          /* the socket is going; its close handler finishes the call */
        }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'microphone_denied';
      await finish('error', reason);
      return;
    }

    emit({ phase: 'connecting' });

    let session: VoiceCallSession;
    try {
      session = (await api.start(deps.conversationId)).callSession;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      await finish('error', typeof code === 'string' ? code : 'server_error');
      return;
    }
    sessionId = session.id;

    deadline = now() + session.maxSeconds * 1000;
    emit({ secondsRemaining: session.maxSeconds });
    countdown = setInterval(() => {
      if (deadline === null) return;
      const remaining = Math.max(0, Math.ceil((deadline - now()) / 1000));
      emit({ secondsRemaining: remaining });
      // The server enforces the ceiling and will close the socket; this only
      // stops the UI from sitting on 0 if that close is slow to arrive.
      if (remaining === 0) void finish('ended', 'max_duration');
    }, 1000);

    socket = deps.openSocket(relaySocketUrl(session.id), {
      onMessage: handleMessage,
      // A socket that closes without a `relay.closed` first is a transport
      // failure, not a hang-up, so it reads as an error.
      onClose: () => void finish(finished ? 'ended' : 'error', 'connection_lost'),
      onError: () => void finish('error', 'connection_lost'),
    });
  };

  return {
    start(): Promise<void> {
      // The same promise, not a second attempt: this is what makes a double
      // click harmless rather than a 409 the person has to read.
      if (starting !== null) return starting;
      if (state.phase !== 'idle' && state.phase !== 'ended' && state.phase !== 'error') {
        return Promise.resolve();
      }
      finished = false;
      const attempt = run().finally(() => {
        starting = null;
      });
      starting = attempt;
      return attempt;
    },

    async hangUp(): Promise<void> {
      if (state.phase === 'idle' || finished) return;
      emit({ phase: 'ending' });
      await finish('ended', null);
    },

    async dispose(): Promise<void> {
      clearCountdown();
      clearPickup();
      // Unmount and navigation both land here. No state is emitted: the
      // component is going away and React would warn about updating it.
      finished = true;
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      socket = null;
      try {
        await deps.audio.dispose();
      } catch {
        /* nothing left to release */
      }
      if (sessionId !== null) {
        const id = sessionId;
        sessionId = null;
        try {
          await api.end(id);
        } catch {
          /* the server settles it from the closed socket */
        }
      }
    },

    get state(): CallState {
      return state;
    },
  };
}
