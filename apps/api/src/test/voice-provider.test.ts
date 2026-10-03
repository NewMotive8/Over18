import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSpicyApiProvider,
  contentRefusalFrom,
  errorKindForStatus,
  parseSessionResponse,
  truncateInstructions,
  INSTRUCTIONS_MAX_CHARS,
  SPICYAPI_MAX_SECONDS,
  SPICYAPI_MODEL,
  SPICYAPI_SESSIONS_URL,
} from '../voice/spicyapi.js';
import {
  VoiceProviderError,
  providerFailureLogFields,
  unconfiguredVoiceProvider,
} from '../voice/types.js';
import {
  DEFAULT_LIVE_CALL_VOICE,
  VOICE_CATALOGUE,
  isKnownVoice,
  resolveVoice,
} from '../voice/voice-catalogue.js';

/**
 * The SpicyAPI adapter, exercised with NO NETWORK.
 *
 * `fetch` is stubbed throughout: a test that reached the real provider would
 * spend money, need a credential, and fail in CI. The published request shape
 * is asserted instead — that is the part a change could silently break.
 */

const TEST_URL = 'https://provider.invalid/v1/realtime/sessions';

const okBody = (over: Record<string, unknown> = {}) => ({
  id: 'rt_abc',
  object: 'realtime.session',
  model: SPICYAPI_MODEL,
  voice: 'Serena',
  turn_detection: { type: 'server_vad' },
  max_seconds: 780,
  input_audio: 'pcm16 mono 16 kHz',
  output_audio: 'pcm16 mono 24 kHz',
  client_secret: { value: 'cs_secret', expires_at: 1_790_000_000 },
  url: 'wss://api.spicyapi.com/v1/realtime?session=ticket',
  ...over,
});

const provider = () =>
  createSpicyApiProvider({ apiKey: 'sk-spicy-test', timeoutMs: 500, maxSeconds: 780, sessionsUrl: TEST_URL });

const request = { instructions: 'You are Luna.', voice: 'Serena', userRef: 'call-1' };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (input: unknown, init: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('the request follows the published contract', () => {
  it('posts the documented fields to the documented endpoint', async () => {
    const spy = stubFetch(() => new Response(JSON.stringify(okBody()), { status: 200 }));

    await provider().createSession(request);

    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(TEST_URL);
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('spicy-live-1');
    expect(body.voice).toBe('Serena');
    expect(body.instructions).toBe('You are Luna.');
    expect(body.turn_detection).toEqual({ type: 'server_vad' });
    expect(body.user).toBe('call-1');
  });

  it('sends the key as a bearer token and nowhere else', async () => {
    const spy = stubFetch(() => new Response(JSON.stringify(okBody()), { status: 200 }));
    await provider().createSession(request);

    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-spicy-test');
    // Never in the URL, where it would reach access logs and referrers.
    expect(url).not.toContain('sk-spicy');
    expect(init.body as string).not.toContain('sk-spicy');
  });

  it('uses the published production URL by default', () => {
    expect(SPICYAPI_SESSIONS_URL).toBe('https://api.spicyapi.com/v1/realtime/sessions');
    expect(SPICYAPI_MAX_SECONDS).toBe(780);
  });

  /** One attempt only: a retry could create a second billable session. */
  it('never retries', async () => {
    const spy = stubFetch(() => new Response('', { status: 500 }));
    await expect(provider().createSession(request)).rejects.toThrow(VoiceProviderError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('bounds the request with a timeout signal', async () => {
    const spy = stubFetch(() => new Response(JSON.stringify(okBody()), { status: 200 }));
    await provider().createSession(request);
    const [, init] = spy.mock.calls[0]! as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });
});

describe('failures are classified by status, and by one allowlisted type', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [402, 'payment_required'],
    [400, 'rejected'],
    [429, 'rejected'],
    [500, 'upstream'],
    [503, 'upstream'],
  ])('HTTP %i -> %s', async (status, kind) => {
    stubFetch(() => new Response('{"error":{"message":"You are Luna."}}', { status }));

    await expect(provider().createSession(request)).rejects.toMatchObject({ kind, status });
  });

  /** The error body can echo the request, and the request carried the persona. */
  it('never puts the provider body in the error', async () => {
    stubFetch(() => new Response('{"error":{"message":"instructions: You are Luna."}}', { status: 400 }));

    await expect(provider().createSession(request)).rejects.toThrow(/HTTP 400/);
    await provider()
      .createSession(request)
      .catch((err: VoiceProviderError) => {
        expect(err.message).not.toContain('You are Luna');
      });
  });

  /**
   * THE REFUSAL THIS EXISTS FOR. A live Staging call was refused with exactly
   * this body shape -- HTTP 422, `error.type` of `moderation_blocked` -- and was
   * reported to the person as "she could not be reached", which invited a retry
   * that could only fail the same way.
   *
   * The sibling fields are present here on purpose: `message`, `code` and
   * `categories` all arrive in the real body, and none of them may influence the
   * decision or escape into the error.
   */
  it('classifies a content refusal from the type, not the status', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Rejected: instructions: You are Luna.',
              type: 'moderation_blocked',
              code: 'minor',
              categories: { minor: 0.77 },
            },
          }),
          { status: 422 },
        ),
    );

    await expect(provider().createSession(request)).rejects.toMatchObject({
      kind: 'content_blocked',
      status: 422,
    });
  });

  /** The type is the signal, so the same refusal is caught on any status. */
  it('classifies a content refusal arriving on a different status', async () => {
    stubFetch(() => new Response('{"error":{"type":"moderation_blocked"}}', { status: 400 }));

    await expect(provider().createSession(request)).rejects.toMatchObject({
      kind: 'content_blocked',
      status: 400,
    });
  });

  /**
   * THE MISCLASSIFICATION THIS GUARDS AGAINST. 422 is the status for any
   * unprocessable request -- a bad voice name would plausibly land there -- so a
   * 422 that does not say `moderation_blocked` must stay an ordinary rejection.
   */
  it.each([
    ['no type at all', '{"error":{"message":"voice not found"}}'],
    ['a different type', '{"error":{"type":"invalid_request_error","param":"voice"}}'],
    ['a non-string type', '{"error":{"type":{"nested":"moderation_blocked"}}}'],
    ['no error object', '{"detail":"unprocessable"}'],
    ['an unparsable body', '<html>gateway</html>'],
    ['an empty body', ''],
  ])('leaves a 422 with %s as an ordinary rejection', async (_label, body) => {
    stubFetch(() => new Response(body, { status: 422 }));

    await expect(provider().createSession(request)).rejects.toMatchObject({
      kind: 'rejected',
      status: 422,
    });
  });

  /** The fallback keeps its own shape: a 500 saying nothing is still upstream. */
  it('still classifies a 500 by status when the body says nothing', async () => {
    stubFetch(() => new Response('{"error":{"type":"server_error"}}', { status: 500 }));

    await expect(provider().createSession(request)).rejects.toMatchObject({
      kind: 'upstream',
      status: 500,
    });
  });

  /**
   * The body is now read, so the guarantee it was never read under has to be
   * re-established: the one field consulted is compared and dropped, and
   * everything beside it stays out of the error.
   */
  it('puts nothing from a refusal body into the error', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'instructions: You are Luna, and she is 26.',
              type: 'moderation_blocked',
              code: 'minor',
              categories: { minor: 0.77, injection: 0.63 },
              docs_url: 'https://example.invalid/moderation',
            },
          }),
          { status: 422 },
        ),
    );

    await provider()
      .createSession(request)
      .catch((err: VoiceProviderError) => {
        expect(err.message).toBe('Voice provider returned HTTP 422.');
        expect(err.message).not.toContain('Luna');
        expect(err.message).not.toContain('minor');
        expect(JSON.stringify(err)).not.toContain('0.77');
      });
    expect.assertions(4);
  });

  it('classifies a timeout', async () => {
    stubFetch(() => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    await expect(provider().createSession(request)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('classifies a network failure', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(provider().createSession(request)).rejects.toMatchObject({ kind: 'network' });
  });

  it('classifies non-JSON output', async () => {
    stubFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    await expect(provider().createSession(request)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  /**
   * Only failures that certainly created nothing are retryable. A timeout may
   * mean a session exists that we never heard about.
   */
  it('marks timeout and network as NOT definitely-created-nothing', () => {
    expect(new VoiceProviderError('timeout', 'x').definitelyCreatedNothing).toBe(false);
    expect(new VoiceProviderError('network', 'x').definitelyCreatedNothing).toBe(false);
    expect(new VoiceProviderError('upstream', 'x').definitelyCreatedNothing).toBe(false);
    expect(new VoiceProviderError('unauthorized', 'x').definitelyCreatedNothing).toBe(true);
    expect(new VoiceProviderError('rejected', 'x').definitelyCreatedNothing).toBe(true);
    // A refusal is a refusal: nothing was created, so nothing can be orphaned.
    expect(new VoiceProviderError('content_blocked', 'x').definitelyCreatedNothing).toBe(true);
  });

  it('classifies statuses with a pure function', () => {
    expect(errorKindForStatus(401)).toBe('unauthorized');
    expect(errorKindForStatus(402)).toBe('payment_required');
    expect(errorKindForStatus(418)).toBe('rejected');
    expect(errorKindForStatus(502)).toBe('upstream');
  });
});

describe('reading a refusal out of an error body', () => {
  it('accepts only the exact allowlisted type', () => {
    expect(contentRefusalFrom({ error: { type: 'moderation_blocked' } })).toBe('content_blocked');
  });

  /**
   * NOTHING IS MATCHED BY SHAPE. The value read comes out of a body that can
   * quote the request, so a near miss is a miss: no prefix, no casing variant
   * and no substring counts.
   */
  it.each([
    ['a near miss', { error: { type: 'moderation_blocked_v2' } }],
    ['a casing variant', { error: { type: 'Moderation_Blocked' } }],
    ['a substring host', { error: { type: 'not_moderation_blocked' } }],
    ['a sentence containing it', { error: { type: 'blocked: moderation_blocked' } }],
    ['the type one level too deep', { error: { error: { type: 'moderation_blocked' } } }],
    ['the type at the top level', { type: 'moderation_blocked' }],
    ['a number', { error: { type: 422 } }],
    ['a null error', { error: null }],
    ['an array error', { error: ['moderation_blocked'] }],
    ['no error key', { message: 'moderation_blocked' }],
    ['null', null],
    ['a string body', 'moderation_blocked'],
    ['undefined', undefined],
  ])('refuses %s', (_label, body) => {
    expect(contentRefusalFrom(body)).toBeUndefined();
  });
});

describe('what may be logged about a provider failure', () => {
  /**
   * THE DEFECT THIS CLOSES. The first live Staging call failed with
   * `provider_rejected` and the log carried only the kind, so the diagnosis
   * available was "a 4xx that is not 401, 402 or 403" -- which cannot tell a bad
   * field from a wrong model. The status was on the error the whole time.
   */
  it('carries the HTTP status alongside the kind', () => {
    expect(providerFailureLogFields(new VoiceProviderError('rejected', 'HTTP 400.', 400))).toEqual({
      voiceErrorKind: 'rejected',
      voiceErrorStatus: 400,
    });
  });

  it.each([
    [400, 'rejected'],
    [401, 'unauthorized'],
    [402, 'payment_required'],
    [422, 'rejected'],
    [503, 'upstream'],
  ] as const)('distinguishes HTTP %i (%s)', (status, kind) => {
    expect(
      providerFailureLogFields(new VoiceProviderError(kind, `HTTP ${status}.`, status)),
    ).toEqual({ voiceErrorKind: kind, voiceErrorStatus: status });
  });

  /** A timeout and a network failure have no status; neither logs an empty field. */
  it.each(['timeout', 'network'] as const)('omits the status for a %s failure', (kind) => {
    const fields = providerFailureLogFields(new VoiceProviderError(kind, 'no response'));
    expect(fields).toEqual({ voiceErrorKind: kind });
    expect('voiceErrorStatus' in fields).toBe(false);
  });

  it('classifies anything that is not a provider error as unexpected', () => {
    expect(providerFailureLogFields(new Error('something else'))).toEqual({
      voiceErrorKind: 'unexpected',
    });
    expect(providerFailureLogFields('a string')).toEqual({ voiceErrorKind: 'unexpected' });
    expect(providerFailureLogFields(null)).toEqual({ voiceErrorKind: 'unexpected' });
  });

  /**
   * THE RULE THAT MUST NOT SLIP. A provider error body echoes the request, and
   * the request carries the compiled persona. The status is three digits and
   * cannot; the message is free text and can.
   */
  it('never carries the message, however much is stuffed into it', () => {
    const error = new VoiceProviderError(
      'rejected',
      'Rejected instructions: You are Luna. sk-spicy-SECRET wss://api.spicyapi.com/v1/realtime',
      400,
    );
    const logged = JSON.stringify(providerFailureLogFields(error));

    expect(logged).toBe('{"voiceErrorKind":"rejected","voiceErrorStatus":400}');
    expect(logged).not.toContain('Luna');
    expect(logged).not.toContain('sk-spicy');
    expect(logged).not.toContain('wss://');
    expect(logged).not.toContain('instructions');
  });

  /** Exactly two keys, so a future field cannot be added without a test failing. */
  it('forwards two fields and no others', () => {
    expect(
      Object.keys(providerFailureLogFields(new VoiceProviderError('rejected', 'x', 400))).sort(),
    ).toEqual(['voiceErrorKind', 'voiceErrorStatus']);
  });
});

describe('a malformed 2xx is a failure, not a session', () => {
  it.each([
    ['not an object', 42],
    ['no id', okBody({ id: undefined })],
    ['empty id', okBody({ id: '' })],
    ['no url', okBody({ url: undefined })],
    ['no client secret', okBody({ client_secret: undefined })],
    ['empty secret value', okBody({ client_secret: { value: '' } })],
    ['no max_seconds', okBody({ max_seconds: undefined })],
    ['non-numeric max_seconds', okBody({ max_seconds: 'lots' })],
  ])('rejects: %s', (_label, body) => {
    expect(() => parseSessionResponse(body)).toThrow(VoiceProviderError);
  });

  it('accepts the documented shape', () => {
    const session = parseSessionResponse(okBody());
    expect(session.providerSessionId).toBe('rt_abc');
    expect(session.clientSecret).toBe('cs_secret');
    expect(session.maxSeconds).toBe(780);
  });
});

describe('duration ceilings', () => {
  it('never asks for more than the application limit', async () => {
    stubFetch(() => new Response(JSON.stringify(okBody({ max_seconds: 780 })), { status: 200 }));
    const capped = createSpicyApiProvider({
      apiKey: 'k',
      timeoutMs: 500,
      maxSeconds: 300,
      sessionsUrl: TEST_URL,
    });

    expect((await capped.createSession(request)).maxSeconds).toBe(300);
  });

  it("respects the provider's own ceiling when it is stricter", async () => {
    stubFetch(() => new Response(JSON.stringify(okBody({ max_seconds: 120 })), { status: 200 }));
    expect((await provider().createSession(request)).maxSeconds).toBe(120);
  });
});

describe('the persona is trimmed to the published limit', () => {
  it('leaves a normal prompt untouched', () => {
    expect(truncateInstructions('short')).toBe('short');
  });

  it('trims an over-long prompt on a line boundary', () => {
    const line = `${'x'.repeat(200)}\n`;
    const long = line.repeat(60); // well over 8,000
    const out = truncateInstructions(long);

    expect(out.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    // Cut between lines, not mid-instruction.
    expect(out.endsWith('x')).toBe(true);
    expect(long.startsWith(out)).toBe(true);
  });

  it('still cuts when there is no line break to cut on', () => {
    const out = truncateInstructions('y'.repeat(INSTRUCTIONS_MAX_CHARS + 500));
    expect(out.length).toBe(INSTRUCTIONS_MAX_CHARS);
  });
});

describe('the voice catalogue', () => {
  it('defaults to Serena', () => {
    expect(DEFAULT_LIVE_CALL_VOICE).toBe('Serena');
    expect(resolveVoice(null)).toBe('Serena');
    expect(resolveVoice(undefined)).toBe('Serena');
    expect(resolveVoice('')).toBe('Serena');
  });

  it('accepts a catalogued voice', () => {
    expect(resolveVoice('Chloe')).toBe('Chloe');
    expect(isKnownVoice('Zane')).toBe(true);
  });

  /** A browser-supplied string must never reach the provider. */
  it.each(['not-a-voice', 'serena', 'SERENA', '../../etc', 42, null, {}])(
    'refuses %s and falls back',
    (value) => {
      expect(isKnownVoice(value)).toBe(false);
      expect(resolveVoice(value as never)).toBe('Serena');
    },
  );

  it('contains the default and no duplicates', () => {
    expect(VOICE_CATALOGUE).toContain(DEFAULT_LIVE_CALL_VOICE);
    expect(new Set(VOICE_CATALOGUE).size).toBe(VOICE_CATALOGUE.length);
  });
});

describe('the unconfigured provider fails clearly', () => {
  it('throws not_configured rather than pretending', async () => {
    await expect(unconfiguredVoiceProvider.createSession(request)).rejects.toMatchObject({
      kind: 'not_configured',
    });
  });
});
