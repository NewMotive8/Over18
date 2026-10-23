import { afterEach, describe, expect, it, vi } from 'vitest';
import { VOICE_CATALOGUE } from '@over18/shared';
import {
  DEFAULT_GROK_VOICE,
  GROK_CLIENT_SECRETS_URL,
  GROK_INPUT_RATE,
  GROK_OUTPUT_RATE,
  GROK_REALTIME_URL,
  GROK_VOICE_CATALOGUE,
  GROK_VOICE_MODEL,
  UNMAPPED_SPICYAPI_VOICES,
  createGrokVoiceProvider,
  grokErrorKindForStatus,
  grokSessionUpdateFrame,
  grokSocketUrl,
  grokSubprotocol,
  isKnownGrokVoice,
  parseClientSecretResponse,
  resolveGrokVoice,
} from '../voice/grok.js';
import { VoiceProviderError } from '../voice/types.js';

/**
 * The Grok adapter, exercised with NO NETWORK.
 *
 * `fetch` is stubbed throughout: a test that reached xAI would spend money, need
 * a credential, and fail in CI. The published request shape is asserted
 * instead -- that is the part a change could silently break.
 */

const TEST_URL = 'https://xai.invalid/v1/realtime/client_secrets';
const PERSONA = 'She is an adult and so is he. CANARY-GROK-PERSONA-4f81c2.';

const config = (over: Record<string, unknown> = {}) => ({
  apiKey: 'xai-test-key',
  timeoutMs: 5_000,
  maxSeconds: 120,
  clientSecretsUrl: TEST_URL,
  ...over,
});

const okBody = (over: Record<string, unknown> = {}) => ({
  value: 'ephemeral-token-abc',
  expires_at: 1_790_000_000,
  ...over,
});

const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response> | Response) => {
  // Typed rather than cast to `never`: the point of the spy is reading
  // `mock.calls`, and a `never` cast hides exactly that.
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Voice casting
 * ------------------------------------------------------------------ */

describe('voice casting', () => {
  it('maps every SpicyAPI catalogue voice, so no character falls back by accident', () => {
    expect(UNMAPPED_SPICYAPI_VOICES).toEqual([]);
  });

  it('maps to real Grok voices and nothing invented', () => {
    for (const voice of VOICE_CATALOGUE) {
      expect(isKnownGrokVoice(resolveGrokVoice(voice)), `${voice} mapped outside the roster`).toBe(
        true,
      );
    }
  });

  it('does NOT collapse every character onto one voice', () => {
    /**
     * The regression this exists to prevent is on the record: with SpicyAPI,
     * every character ended up sounding like Serena. A mapping that pointed all
     * 28 names at `eve` would pass every other test in this file.
     */
    const distinct = new Set(VOICE_CATALOGUE.map((v) => resolveGrokVoice(v)));
    expect(distinct.size).toBeGreaterThanOrEqual(8);
  });

  it('passes a Grok voice id straight through, so an operator can pin one', () => {
    expect(resolveGrokVoice('ara')).toBe('ara');
    expect(resolveGrokVoice('ARA')).toBe('ara');
    expect(resolveGrokVoice('  celeste ')).toBe('celeste');
  });

  it('falls back rather than failing, so an unmapped voice cannot make a character uncallable', () => {
    expect(resolveGrokVoice('a voice nobody published')).toBe(DEFAULT_GROK_VOICE);
    expect(resolveGrokVoice(null)).toBe(DEFAULT_GROK_VOICE);
    expect(resolveGrokVoice(undefined)).toBe(DEFAULT_GROK_VOICE);
    expect(resolveGrokVoice('')).toBe(DEFAULT_GROK_VOICE);
  });

  it('honours a configured fallback voice', () => {
    expect(resolveGrokVoice(null, 'luna')).toBe('luna');
  });

  it('holds the 28 voices x.ai publishes', () => {
    expect(GROK_VOICE_CATALOGUE).toHaveLength(28);
    expect(new Set(GROK_VOICE_CATALOGUE).size).toBe(28);
  });
});

/* ------------------------------------------------------------------ *
 * The session frame
 * ------------------------------------------------------------------ */

describe('the session.update frame', () => {
  it('puts the persona in session.instructions, where the docs put it', () => {
    const frame = JSON.parse(grokSessionUpdateFrame({ instructions: PERSONA, voice: 'eve' }));
    expect(frame.type).toBe('session.update');
    expect(frame.session.instructions).toBe(PERSONA);
    expect(frame.session.voice).toBe('eve');
  });

  it('asks for the rates the browser already uses, so no resampling is needed', () => {
    const frame = JSON.parse(grokSessionUpdateFrame({ instructions: 'x', voice: 'eve' }));
    expect(frame.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: GROK_INPUT_RATE });
    expect(frame.session.audio.output.format).toEqual({
      type: 'audio/pcm',
      rate: GROK_OUTPUT_RATE,
    });
    // The values apps/web/src/lib/voiceCall.ts captures and plays at.
    expect(GROK_INPUT_RATE).toBe(16_000);
    expect(GROK_OUTPUT_RATE).toBe(24_000);
  });

  it('enables server VAD, which is what keeps interruptions working', () => {
    const frame = JSON.parse(grokSessionUpdateFrame({ instructions: 'x', voice: 'eve' }));
    expect(frame.session.turn_detection).toEqual({ type: 'server_vad' });
  });

  it('builds the documented socket url and subprotocol', () => {
    expect(grokSocketUrl(GROK_VOICE_MODEL)).toBe(`${GROK_REALTIME_URL}?model=grok-voice-latest`);
    expect(grokSubprotocol('tok')).toBe('xai-client-secret.tok');
  });
});

/* ------------------------------------------------------------------ *
 * Reading the mint response
 * ------------------------------------------------------------------ */

describe('parseClientSecretResponse', () => {
  it('reads the documented top-level shape', () => {
    expect(parseClientSecretResponse(okBody())).toEqual({
      value: 'ephemeral-token-abc',
      expiresAt: 1_790_000_000,
    });
  });

  it('reads the nested client_secret shape the sessions endpoint returns', () => {
    expect(
      parseClientSecretResponse({ client_secret: { value: 'nested', expires_at: 123 } }),
    ).toEqual({ value: 'nested', expiresAt: 123 });
  });

  it('tolerates a missing expiry rather than failing the call over it', () => {
    expect(parseClientSecretResponse({ value: 'tok' })).toEqual({ value: 'tok', expiresAt: 0 });
  });

  it('refuses anything that is not the documented shape', () => {
    for (const body of [null, 'string', 42, {}, { value: '' }, { value: 7 }]) {
      expect(() => parseClientSecretResponse(body)).toThrow(VoiceProviderError);
    }
  });
});

describe('grokErrorKindForStatus', () => {
  it('separates a refused credential from an unpayable account and a provider fault', () => {
    expect(grokErrorKindForStatus(401)).toBe('unauthorized');
    expect(grokErrorKindForStatus(403)).toBe('unauthorized');
    expect(grokErrorKindForStatus(402)).toBe('payment_required');
    expect(grokErrorKindForStatus(500)).toBe('upstream');
    expect(grokErrorKindForStatus(503)).toBe('upstream');
    expect(grokErrorKindForStatus(400)).toBe('rejected');
    expect(grokErrorKindForStatus(422)).toBe('rejected');
  });
});

/* ------------------------------------------------------------------ *
 * createSession
 * ------------------------------------------------------------------ */

describe('createSession', () => {
  it('mints a token and returns a session the relay can open', async () => {
    const spy = stubFetch(() => jsonResponse(okBody()));
    const provider = createGrokVoiceProvider(config());

    const session = await provider.createSession({
      instructions: PERSONA,
      voice: 'Katerina',
      userRef: 'call-1',
    });

    expect(provider.name).toBe('grok');
    expect(session.url).toBe(`${GROK_REALTIME_URL}?model=grok-voice-latest`);
    expect(session.clientSecret).toBe('ephemeral-token-abc');
    expect(session.subprotocols).toEqual(['xai-client-secret.ephemeral-token-abc']);
    // Katerina maps rather than being sent to a provider that never heard of her.
    expect(session.voice).toBe(resolveGrokVoice('Katerina'));
    expect(isKnownGrokVoice(session.voice)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('carries the persona as an on-open frame, because xAI has nowhere else to put it', async () => {
    stubFetch(() => jsonResponse(okBody()));
    const session = await createGrokVoiceProvider(config()).createSession({
      instructions: PERSONA,
      voice: 'Serena',
      userRef: 'call-1',
    });

    expect(session.onOpenFrames).toHaveLength(1);
    const frame = JSON.parse(session.onOpenFrames![0]);
    expect(frame.type).toBe('session.update');
    expect(frame.session.instructions).toBe(PERSONA);
    expect(frame.session.voice).toBe(session.voice);
  });

  it('sends the key as a bearer token and the model in the body, and no persona', async () => {
    const spy = stubFetch(() => jsonResponse(okBody()));
    await createGrokVoiceProvider(config()).createSession({
      instructions: PERSONA,
      voice: 'eve',
      userRef: 'call-1',
    });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(TEST_URL);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer xai-test-key');

    const body = JSON.parse(init.body as string);
    expect(body.session.model).toBe('grok-voice-latest');
    expect(typeof body.expires_after.seconds).toBe('number');
    /**
     * THE MINT CALL MUST NOT CARRY THE PERSONA. xAI's client_secrets endpoint
     * accepts only `model` and `reasoning.effort`; sending instructions there
     * would put the persona in a request that does nothing with it.
     */
    expect(init.body as string).not.toContain('CANARY-GROK-PERSONA');
  });

  it('publishes no instruction limit, so nothing trims a persona to a number xAI never stated', () => {
    expect(createGrokVoiceProvider(config()).instructionsMaxChars).toBeNull();
  });

  it('uses the application ceiling, since xAI publishes no per-session limit', async () => {
    stubFetch(() => jsonResponse(okBody()));
    const session = await createGrokVoiceProvider(config({ maxSeconds: 95 })).createSession({
      instructions: PERSONA,
      voice: 'eve',
      userRef: 'call-1',
    });
    expect(session.maxSeconds).toBe(95);
  });

  it('honours a configured model and default voice', async () => {
    const spy = stubFetch(() => jsonResponse(okBody()));
    const session = await createGrokVoiceProvider(
      config({ model: 'grok-voice-3.0', defaultVoice: 'luna' }),
    ).createSession({ instructions: PERSONA, voice: 'not a known voice', userRef: 'call-1' });

    expect(session.voice).toBe('luna');
    expect(session.url).toContain('model=grok-voice-3.0');
    expect(JSON.parse(spy.mock.calls[0][1].body as string).session.model).toBe('grok-voice-3.0');
  });

  it('defaults to the published endpoint when none is overridden', async () => {
    const spy = stubFetch(() => jsonResponse(okBody()));
    const { clientSecretsUrl: _omitted, ...withoutUrl } = config();
    await createGrokVoiceProvider(withoutUrl).createSession({
      instructions: PERSONA,
      voice: 'eve',
      userRef: 'call-1',
    });
    expect(spy.mock.calls[0][0]).toBe(GROK_CLIENT_SECRETS_URL);
  });
});

describe('createSession failures', () => {
  const expectKind = async (status: number, kind: string) => {
    stubFetch(() => jsonResponse({ error: { message: `echoed ${PERSONA}` } }, status));
    await expect(
      createGrokVoiceProvider(config()).createSession({
        instructions: PERSONA,
        voice: 'eve',
        userRef: 'call-1',
      }),
    ).rejects.toMatchObject({ kind, status });
  };

  it('names a refused credential, which is the likeliest first failure', async () => {
    await expectKind(401, 'unauthorized');
  });

  it('names an unpayable account and a provider fault separately', async () => {
    await expectKind(402, 'payment_required');
    await expectKind(503, 'upstream');
  });

  it('never carries the persona on the error, even when the body echoes it', async () => {
    stubFetch(() => jsonResponse({ error: { message: `echoed ${PERSONA}` } }, 422));
    const error = await createGrokVoiceProvider(config())
      .createSession({ instructions: PERSONA, voice: 'eve', userRef: 'call-1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoiceProviderError);
    expect(JSON.stringify({ m: (error as Error).message })).not.toContain('CANARY-GROK-PERSONA');
    expect((error as Error).message).toBe('Voice provider returned HTTP 422.');
  });

  it('reports a timeout as a timeout, and does not retry', async () => {
    const spy = stubFetch(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    await expect(
      createGrokVoiceProvider(config()).createSession({
        instructions: PERSONA,
        voice: 'eve',
        userRef: 'call-1',
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    // One attempt: a retry could mint a second token nobody manages.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reports an unreachable provider as a network failure', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(
      createGrokVoiceProvider(config()).createSession({
        instructions: PERSONA,
        voice: 'eve',
        userRef: 'call-1',
      }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('refuses a 2xx that is not the documented shape', async () => {
    stubFetch(() => new Response('<html>hello</html>', { status: 200 }));
    await expect(
      createGrokVoiceProvider(config()).createSession({
        instructions: PERSONA,
        voice: 'eve',
        userRef: 'call-1',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('classifies a timeout as possibly having created something, so it is not retried', async () => {
    const timeout = new VoiceProviderError('timeout', 'x');
    const unauthorized = new VoiceProviderError('unauthorized', 'x');
    expect(timeout.definitelyCreatedNothing).toBe(false);
    expect(unauthorized.definitelyCreatedNothing).toBe(true);
  });
});
