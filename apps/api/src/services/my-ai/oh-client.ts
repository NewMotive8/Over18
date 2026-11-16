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
  /**
   * The provider's numeric id for her — null until she is SAVED there.
   *
   * Verified on staging 2026-11-16 against two characters at once: an
   * unsaved one reports `characterId: null` with status `ready`, a saved one
   * reports a number with status `saved`. It is the id their image endpoint
   * takes, so saving is what makes a second photograph of the same companion
   * possible at all.
   */
  characterId: number | null;
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
  })) as {
    status?: OhStatus;
    images?: OhStatusResult['images'];
    errorMessage?: string;
    characterId?: number | null;
  };

  return {
    status: body.status ?? 'generating',
    images: body.images ?? null,
    errorMessage: body.errorMessage ?? null,
    characterId: typeof body.characterId === 'number' ? body.characterId : null,
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
    /*
     * THE CEILING IS RAISED HERE, AND ONLY HERE.
     *
     * `contentLevel` governs what the provider will render for a character —
     * her reference portrait AND every photograph asked for later. She is
     * GENERATED at `Sexy` so the portrait that represents her is clothed;
     * that was the fix for the first companion arriving naked.
     *
     * But her owner can ask for anything afterwards, and a companion capped
     * at "suggestive/clothed" would have those requests refused by the
     * provider with no way to lift the cap. Save documents itself as "any
     * fields provided here override what was generated", so this is the one
     * moment both are possible: the portrait is already drawn, and the
     * ceiling applies from now on.
     */
    body: { characterGuid: guid, contentLevel: 'Sex' },
  });
}

/* ------------------------------------------------------------------ *
 * Further photographs of a character that already exists
 * ------------------------------------------------------------------ */

export type OhJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface OhImageJob {
  jobId: string;
  status: OhJobStatus;
}

export interface OhJobResult {
  status: OhJobStatus;
  /** The finished image, as a presigned URL that expires. Null until done. */
  url: string | null;
  error: string | null;
}

/**
 * Ask for another photograph of a character the provider already holds.
 *
 * ── WHY THIS IS NOT THE ENDPOINT THAT MADE HER ──────────────────────────────
 *
 * `/characters/generate` invents a person from attributes. This one addresses
 * a person who exists — so the result is recognisably HER rather than a new
 * woman matching the same description, which is the entire point of the
 * feature. It needs her provider id, which only exists once she is saved.
 *
 * `prompt_enhancement` is ON: with it the provider rewrites the request in
 * the chosen style and, for an explicit request, composes the scene properly.
 * With it off, a short phrase like "nude, on white sheets" is handed to the
 * model raw, and the results are markedly worse.
 */
export async function generateImage(
  env: MyAiEnv,
  input: { characterId: string; prompt: string; style: string },
): Promise<OhImageJob> {
  const body = (await ohFetch(env, '/api/v1/images', {
    method: 'POST',
    body: {
      character_id: input.characterId,
      prompt: input.prompt,
      prompt_enhancement: true,
      style: input.style,
      /*
       * ASKED FOR EXPLICITLY, AND THIS IS WHERE THE MINUTE WENT.
       *
       * Left unset, the provider rendered 1080x1920 — 2.25x the pixels of
       * the reference images, and roughly 50 of the 67 seconds a companion
       * took to create. 9:16 is their 720x1280 preset: the same size every
       * reference portrait already is, the same shape the card displays, and
       * a 2.8 MB file down to about 1.1 MB on a phone.
       *
       * It is a quality decision as much as a speed one. If these ever need
       * to be sharper, this one value is the whole change.
       */
      resolution: '9:16',
    },
  })) as { job_id?: string; status?: OhJobStatus };

  if (!body.job_id) {
    throw new OhRequestError(200, JSON.stringify(body).slice(0, 300), 'The image service did not start the job.');
  }
  return { jobId: body.job_id, status: body.status ?? 'queued' };
}

/** Where an async job has got to, and its result when it has one. */
export async function getJobStatus(env: MyAiEnv, jobId: string): Promise<OhJobResult> {
  const body = (await ohFetch(env, `/api/v1/jobs/${encodeURIComponent(jobId)}/status`, {
    method: 'GET',
  })) as { status?: OhJobStatus; url?: string; error?: string };

  return {
    status: body.status ?? 'processing',
    url: typeof body.url === 'string' && body.url.length > 0 ? body.url : null,
    error: typeof body.error === 'string' ? body.error : null,
  };
}
