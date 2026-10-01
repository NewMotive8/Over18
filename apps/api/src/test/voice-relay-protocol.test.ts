import { describe, expect, it } from 'vitest';
import {
  CLIENT_TO_PROVIDER_ALLOWLIST,
  MAX_CLIENT_FRAME_BYTES,
  PROVIDER_TO_CLIENT_ALLOWLIST,
  decideClientFrame,
  sanitiseProviderFrame,
} from '../voice/relay-protocol.js';

/**
 * The relay's sanitisation layer.
 *
 * THE DEFECT THESE EXIST FOR is not hypothetical. A probe of the live provider
 * planted a canary inside the session instructions and watched it come back
 * verbatim in `session.updated`. A browser connected directly could therefore
 * read the compiled persona.
 *
 * The fix is not "delete that field from that event" -- it is that nothing is
 * forwarded at all. Every browser-bound frame is rebuilt from named primitive
 * fields, so a secret in a field nobody anticipated, at any depth, cannot make
 * the crossing. These tests attack that claim rather than confirming it.
 */

const CANARY = 'CANARY-PERSONA-4F91D2';
const SECRET = 'cs_SUPER_SECRET_VALUE';
const URL_SECRET = 'wss://api.spicyapi.com/v1/realtime?session=TICKET';

/** Nothing forwarded may contain any of these, ever. */
function expectNoSecrets(payload: unknown) {
  const text = JSON.stringify(payload);
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('wss://');
  expect(text).not.toContain('sk-spicy');
  expect(text).not.toContain('instructions');
}

const forward = (raw: string) => {
  const decision = sanitiseProviderFrame(raw);
  if (decision.action !== 'forward') throw new Error(`expected forward, got drop: ${decision.type}`);
  return decision.payload;
};

/* ------------------------------------------------------------------ *
 * Provider -> browser
 * ------------------------------------------------------------------ */

describe('the persona cannot cross to the browser', () => {
  /** THE EXACT EVENT THE LIVE PROBE CAUGHT. */
  it('strips instructions from session.updated', () => {
    const payload = forward(
      JSON.stringify({
        type: 'session.updated',
        event_id: 'evt_1',
        session: {
          id: 'sess_1',
          voice: 'Serena',
          instructions: `You are Nadia. Reference code ${CANARY}.`,
          turn_detection: { type: 'server_vad' },
        },
      }),
    );

    expect(payload).toEqual({ type: 'session.updated' });
    expectNoSecrets(payload);
  });

  it('strips them from session.created too', () => {
    const payload = forward(
      JSON.stringify({ type: 'session.created', session: { instructions: CANARY, id: 's1' } }),
    );
    expect(payload).toEqual({ type: 'session.created' });
    expectNoSecrets(payload);
  });

  /**
   * NOT A DENYLIST. A secret buried three levels down, under a key nobody
   * anticipated, must still not cross -- because nothing is copied.
   */
  it('cannot be smuggled through a nested or unexpected field', () => {
    const payload = forward(
      JSON.stringify({
        type: 'response.audio.delta',
        delta: 'AAAABBBB',
        debug: {
          upstream: { url: URL_SECRET, credentials: { client_secret: SECRET } },
          prompt: { compiled: { instructions: CANARY } },
        },
        session: { instructions: CANARY },
      }),
    );

    // Only the audio survived.
    expect(payload).toEqual({ type: 'response.audio.delta', delta: 'AAAABBBB' });
    expectNoSecrets(payload);
  });

  it('drops an event type it does not know', () => {
    const decision = sanitiseProviderFrame(
      JSON.stringify({ type: 'some.future.event', instructions: CANARY }),
    );
    expect(decision).toEqual({ action: 'drop', type: 'some.future.event', reason: 'not_allowlisted' });
  });

  /** Cost figures are the server's business, not the customer's. */
  it('does not forward spicy.usage', () => {
    expect(sanitiseProviderFrame(JSON.stringify({ type: 'spicy.usage', cost_usd: 0.004 })).action).toBe(
      'drop',
    );
  });
});

describe('provider errors are reduced to a code', () => {
  /**
   * THE MOST DANGEROUS EVENT. A provider error routinely quotes the request
   * that caused it, and our request carries the persona. So the message never
   * crosses -- only the documented short slug.
   */
  it('forwards the code and never the message', () => {
    const payload = forward(
      JSON.stringify({
        type: 'error',
        error: {
          code: 'content_blocked',
          message: `Rejected instructions: You are Nadia. Reference code ${CANARY}`,
          request: { instructions: CANARY, url: URL_SECRET },
        },
      }),
    );

    expect(payload).toEqual({ type: 'error', error: { code: 'content_blocked' } });
    expectNoSecrets(payload);
  });

  it('substitutes a generic code when the provider gives none', () => {
    expect(forward(JSON.stringify({ type: 'error', error: { message: CANARY } }))).toEqual({
      type: 'error',
      error: { code: 'provider_error' },
    });
    expect(forward(JSON.stringify({ type: 'error' }))).toEqual({
      type: 'error',
      error: { code: 'provider_error' },
    });
  });

  it('never lets a non-string code through as an object', () => {
    const payload = forward(
      JSON.stringify({ type: 'error', error: { code: { nested: CANARY } } }),
    );
    expect(payload).toEqual({ type: 'error', error: { code: 'provider_error' } });
    expectNoSecrets(payload);
  });
});

describe('the events the browser genuinely needs still arrive', () => {
  it('carries audio', () => {
    expect(forward(JSON.stringify({ type: 'response.audio.delta', delta: 'QUJD' }))).toEqual({
      type: 'response.audio.delta',
      delta: 'QUJD',
    });
  });

  it('carries both transcripts', () => {
    expect(
      forward(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'i1',
          transcript: 'hello there',
        }),
      ),
    ).toEqual({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'hello there',
    });

    expect(
      forward(JSON.stringify({ type: 'response.audio_transcript.done', transcript: 'hi' })),
    ).toEqual({ type: 'response.audio_transcript.done', transcript: 'hi' });
  });

  it('carries turn-taking so the browser can stop playback on barge-in', () => {
    expect(forward(JSON.stringify({ type: 'input_audio_buffer.speech_started' }))).toEqual({
      type: 'input_audio_buffer.speech_started',
    });
    expect(forward(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }))).toEqual({
      type: 'input_audio_buffer.speech_stopped',
    });
  });

  it('carries session expiry', () => {
    expect(forward(JSON.stringify({ type: 'spicy.session_expired' }))).toEqual({
      type: 'spicy.session_expired',
    });
  });

  it('omits a field the provider did not send rather than emitting undefined', () => {
    const payload = forward(JSON.stringify({ type: 'response.audio.delta' }));
    expect(payload).toEqual({ type: 'response.audio.delta' });
    expect(Object.keys(payload)).toEqual(['type']);
  });

  /** The allowlist is a closed, reviewable set. */
  it('allows exactly the documented event types', () => {
    expect([...PROVIDER_TO_CLIENT_ALLOWLIST].sort()).toEqual(
      [
        'conversation.item.input_audio_transcription.completed',
        'conversation.item.input_audio_transcription.delta',
        'error',
        'input_audio_buffer.committed',
        'input_audio_buffer.speech_started',
        'input_audio_buffer.speech_stopped',
        'response.audio.delta',
        'response.audio_transcript.delta',
        'response.audio_transcript.done',
        'response.created',
        'response.done',
        'session.created',
        'session.updated',
        'spicy.session_expired',
      ].sort(),
    );
  });

  it('returns an object sharing nothing with the provider frame', () => {
    const original = { type: 'response.audio.delta', delta: 'AA', session: { instructions: CANARY } };
    const payload = forward(JSON.stringify(original));
    // A fresh object, not a filtered copy of theirs.
    expect(payload).not.toBe(original);
    expect(Object.keys(payload).sort()).toEqual(['delta', 'type']);
  });
});

describe('malformed provider frames', () => {
  it.each([
    ['not json', 'unparsable'],
    ['null', 'no_type'],
    ['"a string"', 'no_type'],
    ['{}', 'no_type'],
    ['{"type":42}', 'no_type'],
    ['{"type":""}', 'no_type'],
  ])('drops %s', (raw, reason) => {
    const decision = sanitiseProviderFrame(raw);
    expect(decision.action).toBe('drop');
    if (decision.action === 'drop') expect(decision.reason).toBe(reason);
  });
});

/* ------------------------------------------------------------------ *
 * Browser -> provider
 * ------------------------------------------------------------------ */

describe('only audio may go upstream', () => {
  it.each([...CLIENT_TO_PROVIDER_ALLOWLIST])('forwards %s', (type) => {
    expect(decideClientFrame(JSON.stringify({ type }))).toEqual({ action: 'forward', type });
  });

  /**
   * `session.update` is refused even though the provider would only accept
   * turn_detection there: it is the event that provokes `session.updated`, and
   * Phase 2A gives the browser no reason to send it.
   */
  it('refuses session.update from the browser', () => {
    expect(decideClientFrame(JSON.stringify({ type: 'session.update' }))).toEqual({
      action: 'drop',
      type: 'session.update',
      reason: 'not_allowlisted',
    });
  });

  it.each(['conversation.item.create', 'session.created', 'anything.else'])('drops %s', (type) => {
    expect(decideClientFrame(JSON.stringify({ type })).action).toBe('drop');
  });

  it('fails closed on malformed input', () => {
    const dropped = (raw: string) => {
      const d = decideClientFrame(raw);
      if (d.action !== 'drop') throw new Error('expected drop');
      return d.reason;
    };
    expect(dropped('not json')).toBe('unparsable');
    expect(dropped('{}')).toBe('no_type');
    expect(dropped('{"type":7}')).toBe('no_type');
  });
});

describe('oversized frames are refused before parsing', () => {
  it('rejects a frame over the limit', () => {
    const huge = JSON.stringify({ type: 'input_audio_buffer.append', audio: 'A'.repeat(MAX_CLIENT_FRAME_BYTES) });
    expect(decideClientFrame(huge)).toEqual({
      action: 'drop',
      type: '<oversized>',
      reason: 'too_large',
    });
  });

  it('accepts a frame at a realistic audio size', () => {
    // 20ms of 16 kHz PCM16 is ~640 bytes, ~854 base64 chars.
    const frame = JSON.stringify({ type: 'input_audio_buffer.append', audio: 'A'.repeat(900) });
    expect(decideClientFrame(frame).action).toBe('forward');
  });

  /** Size is judged on bytes, not characters: multi-byte input still counts. */
  it('measures bytes rather than characters', () => {
    const multibyte = JSON.stringify({ type: 'input_audio_buffer.append', audio: 'é'.repeat(40_000) });
    expect(multibyte.length).toBeLessThan(MAX_CLIENT_FRAME_BYTES);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(MAX_CLIENT_FRAME_BYTES);
    const decision = decideClientFrame(multibyte);
    expect(decision.action).toBe('drop');
    if (decision.action === 'drop') expect(decision.reason).toBe('too_large');
  });
});
