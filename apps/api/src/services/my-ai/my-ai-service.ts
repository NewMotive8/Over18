import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { MyAiCompanion, MyAiDraft } from '@over18/shared';
import type { Db } from '../../db/client.js';
import { userCompanions, type UserCompanionRow } from '../../db/schema.js';
import type { MyAiEnv } from '../../env.js';
import { toOhPayload } from './oh-mapping.js';
import {
  generateCharacter,
  getCharacterStatus,
  saveCharacter,
  OhRequestError,
  type OhStatus,
} from './oh-client.js';

/**
 * My AI — creating, owning and reading back a user's companions.
 *
 * ── OWNERSHIP IS NOT OPTIONAL ───────────────────────────────────────────────
 *
 * Every read below takes a `userId` and puts it in the WHERE clause. There is
 * no "get by id" that omits it, because the first time one exists someone
 * calls it from a route and a companion becomes readable by its id alone.
 * Reading somebody else's and reading one that does not exist give the same
 * answer: null, which the routes turn into the same 404.
 */

/** Minutes a generation may take before we stop waiting and call it failed. */
const POLL_TIMEOUT_MS = 4 * 60 * 1000;
const POLL_INTERVAL_MS = 4_000;
/** A portrait is a few hundred KB. Anything far past that is not one. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * The provider states that mean she has been drawn.
 *
 * `saving` and `saved` count: those are OhAPI's own bookkeeping after the
 * drawing is finished, and a generation that raced past `ready` between two
 * polls must not be mistaken for one still in progress.
 */
export const RENDERED_STATUSES: readonly OhStatus[] = ['ready', 'saving', 'saved'];
export const isRendered = (status: OhStatus): boolean => RENDERED_STATUSES.includes(status);

/**
 * How long to keep asking for the picture after she is drawn.
 *
 * Six attempts, five seconds apart. The URL is named in the very first
 * response and the file appears behind it a moment later; this is the gap.
 */
const DOWNLOAD_ATTEMPTS = 6;
const DOWNLOAD_RETRY_MS = 5_000;

export function toWire(row: UserCompanionRow): MyAiCompanion {
  return {
    id: row.id,
    name: row.name,
    age: row.age,
    status: row.status,
    /*
     * An OWNER-SCOPED route, not a storage key and not the provider's URL.
     * Deliberately not the public `/api/media/assets/:id/file` the lobby uses,
     * which serves anyone who asks — correct for published content, wrong for
     * something one person made for themselves.
     */
    imageUrl: row.imagePath ? `/api/my-ai/${row.id}/image` : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function listCompanions(db: Db, userId: string): Promise<UserCompanionRow[]> {
  return db
    .select()
    .from(userCompanions)
    .where(eq(userCompanions.userId, userId))
    .orderBy(desc(userCompanions.createdAt));
}

/** Null for "not yours" and for "does not exist" alike. */
export async function getCompanion(
  db: Db,
  userId: string,
  id: string,
): Promise<UserCompanionRow | null> {
  const [row] = await db
    .select()
    .from(userCompanions)
    .where(and(eq(userCompanions.id, id), eq(userCompanions.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Record her, then start rendering in the background.
 *
 * The row exists BEFORE the provider is called. If the call fails, the user
 * has a companion marked `failed` with a reason, instead of a button that did
 * nothing — and if the process dies mid-generation we know she was in flight
 * rather than losing her entirely.
 */
export async function createCompanion(
  db: Db,
  userId: string,
  draft: MyAiDraft,
): Promise<UserCompanionRow> {
  const {
    name, age, voice,
    ethnicity, hairColour, hairStyle, eyeColour,
    figure, breasts, butt, personality, relationship, job, interests,
  } = draft;

  const [row] = await db
    .insert(userCompanions)
    .values({
      userId,
      name: name.trim(),
      age,
      voice,
      attributes: {
        ethnicity, hairColour, hairStyle, eyeColour,
        figure, breasts, butt, personality, relationship, job, interests,
      },
      status: 'generating',
    })
    .returning();

  return row;
}

interface GenerationDeps {
  db: Db;
  env: MyAiEnv;
  /** MEDIA_STORAGE_DIR. Her portrait lands under `<dir>/my-ai/`. */
  storageDir: string;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
  /** Injectable so tests do not sit through four minutes of polling. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const fail = async (db: Db, id: string, message: string) => {
  await db
    .update(userCompanions)
    .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
    .where(eq(userCompanions.id, id));
};

/**
 * Drive one generation to completion. Never throws — a background job that
 * rejects takes the reason with it; this one always lands the row in a
 * terminal state the owner can see.
 */
export async function runGeneration(deps: GenerationDeps, companionId: string): Promise<void> {
  const { db, env, log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  try {
    const [row] = await db
      .select()
      .from(userCompanions)
      .where(eq(userCompanions.id, companionId))
      .limit(1);
    if (!row) return;

    const payload = toOhPayload({ name: row.name, age: row.age, attributes: row.attributes });
    const started = await generateCharacter(env, payload);

    await db
      .update(userCompanions)
      .set({ providerCharacterGuid: started.characterGuid, updatedAt: new Date() })
      .where(eq(userCompanions.id, companionId));

    /*
     * WHERE THE PICTURE COMES FROM, AND WHY WAITING IS A SEPARATE QUESTION.
     *
     * THE FIRST COMPANION EVER CREATED FAILED HERE, 1.3 SECONDS IN, on
     * "portrait download 404". The reason is that these two facts come from
     * two different places and the old loop assumed they came from one:
     *
     *   · The 202 that accepts the job ALREADY NAMES the image URLs. They are
     *     where the picture will be, not where it is — OhAPI is still drawing.
     *     Measured on staging 2026-11-16: accepted 06:15:06.490, ready
     *     06:15:17. Downloading on acceptance is downloading eleven seconds
     *     too early, every single time.
     *
     *   · The status endpoint says WHEN she is drawn — and carries no images
     *     at all. Verified against that same finished character: status
     *     `ready`, no `images` key in the body. So waiting for a URL to appear
     *     in a poll would simply time out after four minutes.
     *
     * The URL therefore comes from the 202 and the readiness from the poll.
     * Neither one on its own is enough.
     */
    let imageUrl = started.images?.nsfw_image ?? started.images?.sfw_image ?? null;
    let status = started.status;

    const deadline = now() + POLL_TIMEOUT_MS;
    while (!isRendered(status) && now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const polled = await getCharacterStatus(env, started.characterGuid);
      status = polled.status;
      // Taken if it is ever offered — today it never is. Never overwritten
      // with nothing, because the 202's URL is the one that works.
      imageUrl = polled.images?.nsfw_image ?? polled.images?.sfw_image ?? imageUrl;
      if (status === 'failed') {
        log.warn({ companionId, providerStatus: status, providerDetail: polled.errorMessage }, 'my-ai generation failed at the provider');
        await fail(db, companionId, 'She could not be created. Nothing was charged.');
        return;
      }
    }

    if (!isRendered(status)) {
      log.warn({ companionId, providerStatus: status }, 'my-ai generation timed out');
      await fail(db, companionId, 'She took too long to create. Please try again.');
      return;
    }

    if (!imageUrl) {
      log.warn({ companionId, providerStatus: status }, 'my-ai generation finished with no picture to fetch');
      await fail(db, companionId, 'Her picture could not be downloaded.');
      return;
    }

    const imagePath = await downloadPortrait(imageUrl, deps.storageDir, companionId, sleep);

    await db
      .update(userCompanions)
      .set({ status: 'ready', imagePath, errorMessage: null, updatedAt: new Date() })
      .where(eq(userCompanions.id, companionId));

    log.info({ companionId }, 'my-ai companion ready');

    /*
     * Provider-side bookkeeping, and deliberately after we are already done.
     * Her picture is downloaded and her row says ready, so a failure here
     * changes nothing the user can see and must not undo any of it.
     */
    try {
      await saveCharacter(env, started.characterGuid);
    } catch (cause) {
      log.warn(
        { companionId, providerDetail: cause instanceof OhRequestError ? cause.providerDetail : String(cause) },
        'my-ai: provider save failed after the companion was already complete',
      );
    }
  } catch (cause) {
    // Provider text goes to the log; the owner gets something plain.
    log.error(
      { companionId, providerDetail: cause instanceof OhRequestError ? cause.providerDetail : String(cause) },
      'my-ai generation errored',
    );
    await fail(
      db,
      companionId,
      cause instanceof OhRequestError ? cause.message : 'She could not be created. Please try again.',
    ).catch(() => {});
  }
}

/**
 * Copy the portrait onto OUR media volume.
 *
 * The provider hands back a URL on their servers. A URL we do not host is not
 * storage: it expires, it depends on their uptime for every future view, and
 * it survives exactly as long as our account does. Downloading the bytes once
 * means a companion keeps her face if we change provider, and puts her inside
 * the same volume the backup process already covers.
 *
 * AND IT ASKS MORE THAN ONCE. The URL is named before the file exists, so a
 * 404 just after she is drawn means "not uploaded yet", not "wrong address".
 * One attempt is how a finished companion gets thrown away over a second of
 * CDN lag. Anything that is not a 404 or a 403 is not going to improve by
 * asking again, so it stops immediately.
 *
 * Exported for testing: this is the one part whose behaviour is a sequence of
 * provider responses rather than a value, and it is where the first live
 * creation failed.
 */
export async function downloadPortrait(
  url: string,
  storageDir: string,
  companionId: string,
  sleep: (ms: number) => Promise<void>,
  attempts = DOWNLOAD_ATTEMPTS,
): Promise<string> {
  let lastStatus = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
        throw new OhRequestError(200, `portrait size ${buffer.byteLength}`, 'Her picture could not be downloaded.');
      }

      /*
       * The filename is built from the companion's own UUID and a fixed
       * extension — never from the provider's URL, which is attacker-adjacent
       * input and the usual way a path escapes its directory. There is nothing
       * here for `..` to come from.
       */
      const path = resolve(join(storageDir, 'my-ai', `${companionId}.jpg`));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buffer);
      return path;
    }

    lastStatus = response.status;
    if (response.status !== 404 && response.status !== 403) break;
    if (attempt < attempts) await sleep(DOWNLOAD_RETRY_MS);
  }

  throw new OhRequestError(
    lastStatus,
    `portrait download ${lastStatus}`,
    'Her picture could not be downloaded.',
  );
}
