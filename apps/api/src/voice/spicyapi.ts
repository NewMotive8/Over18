import {
  VoiceProviderError,
  type VoiceSession,
  type VoiceSessionProvider,
  type VoiceSessionRequest,
} from './types.js';

/**
 * SpicyAPI live-call session creation.
 *
 * Every endpoint, field and limit below is taken from the published API
 * reference. Nothing is inferred.
 *
 *   POST https://api.spicyapi.com/v1/realtime/sessions
 *   Authorization: Bearer sk-spicy-...
 *   { model, voice, instructions, turn_detection, user }
 *   -> { id, object, model, voice, turn_detection, max_seconds,
 *        input_audio, output_audio, client_secret: { value, expires_at }, url }
 *
 * This module creates a session and returns. It never opens the WebSocket --
 * that is the relay's job in Phase 2.
 */

export const SPICYAPI_PROVIDER = 'spicyapi';
export const SPICYAPI_SESSIONS_URL = 'https://api.spicyapi.com/v1/realtime/sessions';
export const SPICYAPI_MODEL = 'spicy-live-1';

/** The published per-session ceiling. An application limit may be lower, never higher. */
export const SPICYAPI_MAX_SECONDS = 780;

/** The persona field's published limit. Longer input is truncated, not rejected. */
export const INSTRUCTIONS_MAX_CHARS = 8_000;

export interface SpicyApiConfig {
  apiKey: string;
  /** Bounded, so a hung provider cannot hold a request open indefinitely. */
  timeoutMs: number;
  /** The application's own ceiling; clamped to the provider's on the way out. */
  maxSeconds: number;
  /** Overridable only for tests. Production always uses the published URL. */
  sessionsUrl?: string;
}

/**
 * Trims the persona to the provider's limit on a sentence-ish boundary.
 *
 * Truncating mid-word is how a prompt ends with half an instruction, which the
 * model then tries to obey. Cutting at the last newline inside the budget keeps
 * whole lines, and the compiled prompt is built line by line.
 */
export function truncateInstructions(instructions: string, limit = INSTRUCTIONS_MAX_CHARS): string {
  if (instructions.length <= limit) return instructions;
  const slice = instructions.slice(0, limit);
  const lastBreak = slice.lastIndexOf('\n');
  return lastBreak > limit * 0.5 ? slice.slice(0, lastBreak) : slice;
}

/**
 * Reads a create-session response, refusing anything that is not the documented
 * shape.
 *
 * Exported for tests: a malformed 200 is a real failure mode and deserves its
 * own assertions without a network in the way.
 */
export function parseSessionResponse(body: unknown): VoiceSession {
  const fail = (what: string): never => {
    throw new VoiceProviderError('invalid_response', `Session response ${what}.`);
  };
  if (typeof body !== 'object' || body === null) return fail('was not an object');

  const raw = body as Record<string, unknown>;
  const secret = raw.client_secret as Record<string, unknown> | undefined;

  if (typeof raw.id !== 'string' || raw.id.length === 0) return fail('had no id');
  if (typeof raw.url !== 'string' || raw.url.length === 0) return fail('had no url');
  if (!secret || typeof secret.value !== 'string' || secret.value.length === 0) {
    return fail('had no client secret');
  }
  if (typeof raw.max_seconds !== 'number' || !Number.isFinite(raw.max_seconds)) {
    return fail('had no max_seconds');
  }

  return {
    providerSessionId: raw.id,
    voice: typeof raw.voice === 'string' ? raw.voice : '',
    maxSeconds: raw.max_seconds,
    url: raw.url,
    clientSecret: secret.value,
    clientSecretExpiresAt: typeof secret.expires_at === 'number' ? secret.expires_at : 0,
  };
}

/** Maps a non-2xx status to a kind. The body is never read. */
export function errorKindForStatus(status: number) {
  if (status === 401 || status === 403) return 'unauthorized' as const;
  if (status === 402) return 'payment_required' as const;
  if (status >= 500) return 'upstream' as const;
  return 'rejected' as const;
}

/**
 * The `error.type` values that mean the persona itself was refused.
 *
 * CLOSED, AND THE REASON IS THE SAME ONE `LOGGABLE_CODES` HAS. The value being
 * read comes out of a body that can quote the request, and the request carried
 * the compiled persona. A pattern loose enough to admit a vocabulary we have
 * not seen is also loose enough to admit a sentence of the persona. So nothing
 * is matched by shape: a type either IS one of these exact strings or it is not
 * a content refusal, and the string is compared and then discarded.
 */
const CONTENT_REFUSAL_TYPES = new Set(['moderation_blocked']);

/**
 * Whether an error body says the content was refused, rather than the request.
 *
 * ── WHY THE STATUS IS NOT ENOUGH ─────────────────────────────────────────────
 *
 * The observed refusal is an HTTP 422, but 422 is the status for any
 * unprocessable request -- a bad voice name would plausibly land there too.
 * Treating the status as the signal would tell somebody their call was refused
 * on content when the real fault was a typo in a config field. So the status is
 * not consulted at all: `error.type` is the provider's own name for what
 * happened, and it is the only thing trusted here.
 *
 * ── WHAT IS READ, AND WHAT IS NOT ────────────────────────────────────────────
 *
 * One field, compared against a closed set, and nothing retained. The sibling
 * fields are deliberately ignored: `message` is free text that can echo the
 * request, and `code` and `categories` carry the classifier's verdict about the
 * persona -- the server's business when diagnosing, never something to widen
 * this seam for. Anything unrecognised returns undefined and the caller falls
 * back to classifying by status, exactly as before.
 *
 * Exported for tests: this is the whole of the new decision, and it deserves
 * assertions without a network in the way.
 */
export function contentRefusalFrom(body: unknown): 'content_blocked' | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const type = (error as Record<string, unknown>).type;
  return typeof type === 'string' && CONTENT_REFUSAL_TYPES.has(type) ? 'content_blocked' : undefined;
}

export function createSpicyApiProvider(config: SpicyApiConfig): VoiceSessionProvider {
  const url = config.sessionsUrl ?? SPICYAPI_SESSIONS_URL;
  // The application never asks for more than the provider allows.
  const maxSeconds = Math.min(config.maxSeconds, SPICYAPI_MAX_SECONDS);

  return {
    name: SPICYAPI_PROVIDER,

    async createSession(request: VoiceSessionRequest): Promise<VoiceSession> {
      /**
       * NO RETRY, DELIBERATELY. A timeout or a dropped socket may mean the
       * provider created a session we never heard about. Retrying would create
       * a second one, and the caller would be paying for both while managing
       * neither. One attempt; a failure is a failure.
       */
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: SPICYAPI_MODEL,
            voice: request.voice,
            instructions: truncateInstructions(request.instructions),
            turn_detection: { type: 'server_vad' },
            user: request.userRef,
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new VoiceProviderError('timeout', `Session creation timed out after ${config.timeoutMs}ms.`);
        }
        throw new VoiceProviderError('network', 'Could not reach the voice provider.');
      }

      if (!response.ok) {
        /**
         * One field out of the body, then the status. The body can echo the
         * request and the request carried the persona, so it is read here and
         * nowhere else: `contentRefusalFrom` returns a kind or nothing, the
         * parsed body is never bound to a name that outlives this expression,
         * and the message below still says only what the status was.
         *
         * A body that will not parse is simply not a content refusal. That is
         * the safe direction to fail: it costs a less precise message, where
         * trusting an unparsed body would cost the guarantee above.
         */
        let refusal: 'content_blocked' | undefined;
        try {
          refusal = contentRefusalFrom(await response.json());
        } catch {
          refusal = undefined;
        }
        throw new VoiceProviderError(
          refusal ?? errorKindForStatus(response.status),
          `Voice provider returned HTTP ${response.status}.`,
          response.status,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new VoiceProviderError('invalid_response', 'Voice provider returned non-JSON output.');
      }

      const session = parseSessionResponse(body);
      // Trust the provider's ceiling over ours when it is stricter.
      return { ...session, maxSeconds: Math.min(session.maxSeconds, maxSeconds) };
    },
  };
}
