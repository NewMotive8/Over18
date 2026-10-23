import { VOICE_CATALOGUE, type LiveCallVoice } from '@over18/shared';
import {
  VoiceProviderError,
  type VoiceSession,
  type VoiceSessionProvider,
  type VoiceSessionRequest,
} from './types.js';

/**
 * xAI Grok Voice live-call sessions.
 *
 * Every endpoint, field and event name below is taken from the published xAI
 * documentation (`docs.x.ai/developers/model-capabilities/audio/
 * speech-to-speech` and the Voice REST reference, read 2026-10-22). Nothing is
 * inferred, and where the documentation is silent this module says so rather
 * than guessing.
 *
 * ── HOW IT DIFFERS FROM SPICYAPI, STRUCTURALLY ───────────────────────────────
 *
 * SpicyAPI creates a session with one REST call that CARRIES the persona, and
 * returns a URL with the credential already in it. xAI has no equivalent:
 *
 *   1. There is no create-session call. `POST /v1/realtime/client_secrets`
 *      mints a short-lived token and accepts only `model` and
 *      `reasoning.effort` -- not `instructions`, not `voice`.
 *   2. The socket URL is a bare endpoint. Authentication is an `Authorization`
 *      header, which the WHATWG WebSocket API cannot set, or the token as a
 *      subprotocol -- which it can.
 *   3. The persona therefore arrives as a `session.update` frame written the
 *      moment the socket opens.
 *
 * So this adapter still does its work before any socket exists -- it mints the
 * token, which is also what validates the credential -- and hands the relay the
 * two things the seam now carries for it: `subprotocols` and `onOpenFrames`.
 */

export const GROK_PROVIDER = 'grok';
export const GROK_REALTIME_URL = 'wss://api.x.ai/v1/realtime';
export const GROK_CLIENT_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';
export const GROK_VOICE_MODEL = 'grok-voice-latest';

/**
 * The audio formats OVER18's browser client already uses.
 *
 * THE REASON THIS INTEGRATION NEEDS NO AUDIO WORK. `apps/web/src/lib/
 * voiceCall.ts` captures PCM16 mono at 16 kHz and plays at 24 kHz, because
 * SpicyAPI fixes both and does not negotiate. xAI takes either rate as session
 * configuration, so asking it for the same two numbers makes the existing
 * capture and playback code correct for both providers -- the difference is a
 * JSON field, not a resampler.
 */
export const GROK_INPUT_RATE = 16_000;
export const GROK_OUTPUT_RATE = 24_000;

/** How long the minted token stays valid. The relay opens its socket immediately. */
const CLIENT_SECRET_TTL_SECONDS = 120;

/**
 * xAI publishes no ceiling on `instructions`.
 *
 * Stated as null on the provider rather than as a large number, so nothing
 * downstream trims a persona to fit a limit that was invented here. See
 * `VoiceSessionProvider.instructionsMaxChars`.
 */
export const GROK_INSTRUCTIONS_MAX_CHARS = null;

/* ------------------------------------------------------------------ *
 * Voice casting
 * ------------------------------------------------------------------ */

/**
 * The Grok voice roster, transcribed from x.ai/api/voice on 2026-10-22.
 *
 * Lower-case because xAI documents the ids as case-insensitive, unlike
 * SpicyAPI's, where case matters.
 */
export const GROK_VOICE_CATALOGUE = [
  'ara', 'eve', 'leo', 'rex', 'sal', 'altair', 'atlas', 'aurora',
  'carina', 'castor', 'celeste', 'cosmo', 'helios', 'helix', 'iris', 'kepler',
  'liora', 'lumen', 'luna', 'lux', 'naksh', 'orion', 'perseus', 'rigel',
  'sirius', 'ursa', 'zagan', 'zenith',
] as const;

export type GrokVoice = (typeof GROK_VOICE_CATALOGUE)[number];

const GROK_VOICES = new Set<string>(GROK_VOICE_CATALOGUE);

export const DEFAULT_GROK_VOICE: GrokVoice = 'eve';

/**
 * Which Grok voice a character configured for a SpicyAPI voice should speak in.
 *
 * ── THIS IS A CASTING DECISION AND IT IS UNVERIFIED ──────────────────────────
 *
 * `characters.live_call_voice` holds a SpicyAPI voice name, which means nothing
 * to xAI. Something has to map it, and the alternative to a table here is a
 * schema change -- a second voice column on `characters` plus an admin control
 * for it -- which is a far larger change than switching provider.
 *
 * xAI DOES NOT PUBLISH THE GENDER OR CHARACTER OF ITS VOICES. The pairings
 * below are inferred from the names, which is a guess and is recorded as one.
 * What the table DOES guarantee is the property whose absence was the original
 * complaint -- see [[over18-spicyapi-voice]], "why everyone sounds like Serena":
 * distinct SpicyAPI voices map to distinct Grok voices, so characters do not
 * collapse onto one voice. Whether each pairing SUITS its character is a
 * listening job for an operator, and the report says so.
 *
 * A voice not in this table, or a character with none configured, falls back to
 * the default rather than failing: a retired or unmapped voice must not make a
 * character uncallable.
 */
const SPICYAPI_TO_GROK: Readonly<Partial<Record<LiveCallVoice, GrokVoice>>> = {
  // Voices that read as feminine in SpicyAPI's catalogue.
  Tina: 'ara',
  Cindy: 'aurora',
  'Liora Mira': 'liora',
  Serena: 'eve',
  Maia: 'carina',
  Mia: 'celeste',
  Katerina: 'iris',
  Jennifer: 'luna',
  Sonrisa: 'aurora',
  Hana: 'celeste',
  Griet: 'carina',
  Sigga: 'liora',
  Bea: 'ara',
  Chloe: 'iris',
  Kiki: 'luna',
  Sohee: 'eve',
  // Voices that read as masculine.
  Zane: 'rex',
  Ryan: 'leo',
  Raymond: 'atlas',
  'Theo Calm': 'orion',
  Aiden: 'castor',
  Andre: 'kepler',
  Dolce: 'cosmo',
  Bodega: 'zagan',
  Jakub: 'rigel',
  Alek: 'perseus',
  Emilien: 'sirius',
  Evan: 'helios',
};

export function isKnownGrokVoice(value: unknown): value is GrokVoice {
  return typeof value === 'string' && GROK_VOICES.has(value.trim().toLowerCase());
}

/**
 * The Grok voice for a request's voice value.
 *
 * Accepts either a SpicyAPI catalogue name (mapped) or a Grok voice id passed
 * through -- the second so an operator can pin a voice by setting it directly
 * without this table being in the way.
 */
export function resolveGrokVoice(configured: string | null | undefined, fallback: GrokVoice = DEFAULT_GROK_VOICE): GrokVoice {
  if (isKnownGrokVoice(configured)) return configured.trim().toLowerCase() as GrokVoice;
  const mapped = configured === null || configured === undefined
    ? undefined
    : SPICYAPI_TO_GROK[configured as LiveCallVoice];
  return mapped ?? fallback;
}

/** Every SpicyAPI voice is mapped. Asserted by a test rather than trusted. */
export const UNMAPPED_SPICYAPI_VOICES = VOICE_CATALOGUE.filter(
  (voice) => SPICYAPI_TO_GROK[voice] === undefined,
);

/* ------------------------------------------------------------------ *
 * Session configuration
 * ------------------------------------------------------------------ */

/**
 * The frame that installs the persona, the voice and the audio formats.
 *
 * RELAY-ORIGINATED, AND ONLY THAT. `session.update` is absent from
 * `CLIENT_TO_PROVIDER_ALLOWLIST` for the reason it has always been absent: a
 * browser able to send one could replace the persona, or provoke the
 * `session.updated` echo that the sanitiser exists to neutralise. This is built
 * here, from instructions the server compiled, and written straight to the
 * upstream socket.
 *
 * `turn_detection: server_vad` is the same setting SpicyAPI is sent, and it is
 * what makes interruptions work: xAI documents barge-in as automatic under
 * server VAD, which preserves the behaviour the call UI already depends on.
 */
export function grokSessionUpdateFrame(input: { instructions: string; voice: string }): string {
  return JSON.stringify({
    type: 'session.update',
    session: {
      instructions: input.instructions,
      voice: input.voice,
      turn_detection: { type: 'server_vad' },
      audio: {
        input: { format: { type: 'audio/pcm', rate: GROK_INPUT_RATE } },
        output: { format: { type: 'audio/pcm', rate: GROK_OUTPUT_RATE } },
      },
    },
  });
}

export function grokSocketUrl(model: string): string {
  return `${GROK_REALTIME_URL}?model=${encodeURIComponent(model)}`;
}

/** The subprotocol form xAI documents for an ephemeral token. */
export function grokSubprotocol(token: string): string {
  return `xai-client-secret.${token}`;
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */

export interface GrokVoiceConfig {
  apiKey: string;
  timeoutMs: number;
  maxSeconds: number;
  model?: string;
  /** The voice used when a character has none configured or none that maps. */
  defaultVoice?: GrokVoice;
  /** Overridable only for tests. */
  clientSecretsUrl?: string;
}

/**
 * Reads a minted client secret, refusing anything that is not the documented
 * shape.
 *
 * Exported for tests: a malformed 200 is a real failure mode and deserves
 * assertions without a network in the way.
 */
export function parseClientSecretResponse(body: unknown): { value: string; expiresAt: number } {
  const fail = (what: string): never => {
    throw new VoiceProviderError('invalid_response', `Client secret response ${what}.`);
  };
  if (typeof body !== 'object' || body === null) return fail('was not an object');
  const raw = body as Record<string, unknown>;

  /**
   * Both shapes the documentation shows are accepted: the token at the top
   * level, and nested under `client_secret` as the realtime sessions endpoint
   * returns it. Reading two known shapes is not the same as guessing -- an
   * unrecognised body still fails.
   */
  const nested = raw.client_secret as Record<string, unknown> | undefined;
  const value = typeof raw.value === 'string' ? raw.value : nested?.value;
  const expiresAt = typeof raw.expires_at === 'number' ? raw.expires_at : nested?.expires_at;

  if (typeof value !== 'string' || value.length === 0) return fail('had no token');
  return {
    value,
    expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

/** Maps a non-2xx status to a kind. The body is never read. */
export function grokErrorKindForStatus(status: number) {
  if (status === 401 || status === 403) return 'unauthorized' as const;
  if (status === 402) return 'payment_required' as const;
  if (status >= 500) return 'upstream' as const;
  return 'rejected' as const;
}

export function createGrokVoiceProvider(config: GrokVoiceConfig): VoiceSessionProvider {
  const url = config.clientSecretsUrl ?? GROK_CLIENT_SECRETS_URL;
  const model = config.model ?? GROK_VOICE_MODEL;
  const fallbackVoice = config.defaultVoice ?? DEFAULT_GROK_VOICE;

  return {
    name: GROK_PROVIDER,
    instructionsMaxChars: GROK_INSTRUCTIONS_MAX_CHARS,

    async createSession(request: VoiceSessionRequest): Promise<VoiceSession> {
      const voice = resolveGrokVoice(request.voice, fallbackVoice);

      /**
       * NO RETRY, DELIBERATELY -- the rule the SpicyAPI adapter follows, for the
       * same reason. A timeout may mean the provider did something we never
       * heard about, and retrying would do it twice while managing neither.
       *
       * Minting the token is also what VALIDATES THE CREDENTIAL. Doing it here,
       * before the relay opens a socket, keeps `unauthorized` detectable at the
       * same point it is for SpicyAPI -- which matters because the caller's
       * first minute has already been reserved by then and an unusable key must
       * surface as a refusal rather than as a call that connects and says
       * nothing.
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
            expires_after: { seconds: CLIENT_SECRET_TTL_SECONDS },
            session: { model },
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
         * THE BODY IS NOT READ AT ALL, unlike the SpicyAPI adapter.
         *
         * There, one field (`error.type`) is read against a closed set because
         * SpicyAPI documents `moderation_blocked` and a content refusal needs
         * telling apart from a transient fault. xAI documents no such value, so
         * there is nothing to match -- and a pattern loose enough to guess at
         * one would be loose enough to admit a sentence of the persona, which
         * these error bodies can quote. A content refusal from xAI will arrive
         * as `rejected`; the report records that as a known gap rather than
         * inventing a vocabulary for it.
         */
        throw new VoiceProviderError(
          grokErrorKindForStatus(response.status),
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

      const secret = parseClientSecretResponse(body);

      return {
        /**
         * No session id exists yet: xAI assigns one on `session.created`, after
         * the socket opens. The token's identity is the only handle available at
         * this point, so the row records that the provider was reached and the
         * column stays truthful -- it is documented as an opaque provider
         * handle, not as a session id.
         */
        providerSessionId: `grok-secret-${secret.expiresAt}`,
        voice,
        /**
         * xAI publishes no per-session ceiling, so the application's own is the
         * only one. `VOICE_MAX_SECONDS` already bounds the call, and the relay
         * enforces it with its own timer -- that path is unchanged.
         */
        maxSeconds: config.maxSeconds,
        url: grokSocketUrl(model),
        clientSecret: secret.value,
        clientSecretExpiresAt: secret.expiresAt,
        subprotocols: [grokSubprotocol(secret.value)],
        onOpenFrames: [grokSessionUpdateFrame({ instructions: request.instructions, voice })],
      };
    },
  };
}
