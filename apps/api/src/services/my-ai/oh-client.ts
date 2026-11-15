import type { MyAiEnv } from '../../env.js';
import type { OhCharacterPayload } from './oh-mapping.js';

/**
 * The OhAPI calls My AI makes. Nothing else in the system talks to OhAPI.
 *
 * ── THE SHAPE OF A GENERATION ───────────────────────────────────────────────
 *
 *   POST /api/v2/characters/generate  -> 202 { characterGuid, status, images }
 *   GET  /api/v2/characters/{guid}/status  (poll: draft -> generating -> ready)
 *   POST /api/v2/characters/save      -> saved
 *
 * It is asynchronous on their side and takes the better part of a minute, so
 * nothing here blocks a request: the route returns as soon as the job is
 * accepted and the work continues behind it.
 *
 * ── WHAT NEVER LEAVES THIS FILE ─────────────────────────────────────────────
 *
 * The API key. It goes in a header and is never logged, never returned, never
 * put in an error message — including the ones that get thrown upward, since
 * those reach request logs. Provider error BODIES are not echoed to clients
 * either: they are written to the server log and the owner is told something
 * plain, because a provider's 400 text is both unhelpful to a user and a way
 * to leak the shape of our account.
 */

export type OhStatus = 'draft' | 'generating' | 'ready' | 'saving' | 'saved' | 'failed';

export interface OhGenerateResult {
  characterGuid: string;
  status: OhStatus;
  /** Present once rendering finishes; `nsfw_image` is the one we keep. */
  images: { nsfw_image?: string; sfw_image?: string } | null;
}

export interface OhStatusResult {
  status: OhStatus;
  images: { nsfw_image?: string; sfw_image?: string } | null;
  errorMessage: string | null;
}

/** Thrown for anything the provider refused or could not answer. */
export class OhRequestError extends Error {
  constructor(
    readonly status: number,
    /** Provider text, for the SERVER log only. Never shown to a user. */
    readonly providerDetail: string,
    message: string,
  ) {
    super(message);
    this.name = 'OhRequestError';
  }
}

async function ohFetch(
  env: MyAiEnv,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<unknown> {
  /*
   * An explicit timeout on every call. `fetch` has no default one, and a
   * provider that accepts a connection and then says nothing would otherwise
   * hold a generation open until the process restarts.
   */
  const abort = AbortSignal.timeout(env.timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${env.ohBaseUrl}${path}`, {
      method: init.method,
      headers: {
        'X-API-Key': env.ohApiKey,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: abort,
    });
  } catch (cause) {
    // Network-level: DNS, TLS, timeout. The URL is safe to name; the key is
    // in a header and cannot appear here.
    throw new OhRequestError(0, String(cause), 'The image service could not be reached.');
  }

  const text = await response.text();
  if (!response.ok) {
    throw new OhRequestError(
      response.status,
      text.slice(0, 500),
      response.status === 401
        ? 'The image service rejected our credentials.'
        : 'The image service refused the request.',
    );
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new OhRequestError(response.status, text.slice(0, 200), 'The image service replied with something unreadable.');
  }
}

export async function generateCharacter(
  env: MyAiEnv,
  payload: OhCharacterPayload,
): Promise<OhGenerateResult> {
  const body = (await ohFetch(env, '/api/v2/characters/generate', {
    method: 'POST',
    body: payload,
  })) as { characterGuid?: string; status?: OhStatus; images?: OhGenerateResult['images'] };

  if (!body.characterGuid) {
    throw new OhRequestError(200, JSON.stringify(body).slice(0, 300), 'The image service did not start the job.');
  }
  return {
    characterGuid: body.characterGuid,
    status: body.status ?? 'generating',
    images: body.images ?? null,
  };
}

export async function getCharacterStatus(env: MyAiEnv, guid: string): Promise<OhStatusResult> {
  const body = (await ohFetch(env, `/api/v2/characters/${encodeURIComponent(guid)}/status`, {
    method: 'GET',
  })) as { status?: OhStatus; images?: OhStatusResult['images']; errorMessage?: string };

  return {
    status: body.status ?? 'generating',
    images: body.images ?? null,
    errorMessage: body.errorMessage ?? null,
  };
}

/**
 * Persist her on the provider's side once rendering is done.
 *
 * Deliberately NOT fatal to us if it fails: by this point we already have her
 * picture downloaded and her attributes stored, so she is complete as far as
 * the user is concerned. Failing the whole creation over a provider-side
 * bookkeeping step would throw away work the user already paid for in time.
 */
export async function saveCharacter(env: MyAiEnv, guid: string): Promise<void> {
  await ohFetch(env, '/api/v2/characters/save', {
    method: 'POST',
    body: { characterGuid: guid },
  });
}
