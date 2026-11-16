import { and, desc, eq } from 'drizzle-orm';
import type { MyAiCompanion, MyAiDraft } from '@over18/shared';
import type { Db } from '../../db/client.js';
import { userCompanions, type UserCompanionRow } from '../../db/schema.js';
import type { MyAiEnv } from '../../env.js';
import { DOWNLOAD_ATTEMPTS, downloadImage, removeImage } from './media.js';
import { photoPathsFor } from './my-ai-photos.js';
import { toOhPayload, type OhCharacterPayload } from './oh-mapping.js';
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
/**
 * The provider states that mean she has been drawn.
 *
 * `saving` and `saved` count: those are OhAPI's own bookkeeping after the
 * drawing is finished, and a generation that raced past `ready` between two
 * polls must not be mistaken for one still in progress.
 */
export const RENDERED_STATUSES: readonly OhStatus[] = ['ready', 'saving', 'saved'];
export const isRendered = (status: OhStatus): boolean => RENDERED_STATUSES.includes(status);


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

/**
 * Delete one of her owner's companions, and her picture with her.
 *
 * Owner-scoped like every other operation here, and it answers false for
 * "not yours" and "does not exist" alike, which the route turns into the same
 * 404. Her row goes and her bytes go: a deleted companion that leaves a
 * portrait on the volume is a picture the user believes they removed.
 */
export async function deleteCompanion(
  db: Db,
  userId: string,
  id: string,
  storageDir: string,
): Promise<boolean> {
  const row = await getCompanion(db, userId, id);
  if (!row) return false;

  /*
   * HER PHOTOGRAPHS' FILES ARE COLLECTED BEFORE THE ROW GOES.
   *
   * The foreign key cascades, so deleting her removes those rows for us — and
   * with them any record of where their files are. Read the paths first or
   * the pictures stay on the volume for ever, referenced by nothing, which is
   * the one outcome a delete must not produce.
   */
  const photoFiles = await photoPathsFor(db, id);

  const deleted = await db
    .delete(userCompanions)
    .where(and(eq(userCompanions.id, id), eq(userCompanions.userId, userId)))
    .returning({ id: userCompanions.id });
  if (deleted.length === 0) return false;

  if (row.imagePath) await removeImage(row.imagePath, storageDir);
  for (const path of photoFiles) await removeImage(path, storageDir);
  return true;
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
    const started = await startGeneration(env, payload, log, companionId);

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

    const finished = await db
      .update(userCompanions)
      .set({ status: 'ready', imagePath, errorMessage: null, updatedAt: new Date() })
      .where(eq(userCompanions.id, companionId))
      .returning({ id: userCompanions.id });

    /*
     * SHE WAS DELETED WHILE SHE WAS BEING DRAWN. Nothing to update means the
     * row is gone, so the file just written belongs to nobody — remove it,
     * or a user who deleted a companion mid-generation leaves a portrait
     * behind on the volume that nothing will ever reference or clean up.
     */
    if (finished.length === 0) {
      await removeImage(imagePath, deps.storageDir);
      log.info({ companionId }, 'my-ai companion was deleted while being created; portrait discarded');
      return;
    }

    log.info({ companionId }, 'my-ai companion ready');

    /*
     * SAVE HER AT THE PROVIDER, and keep the id that comes back.
     *
     * Not bookkeeping — this is what gives her a lasting identity there.
     * A generated-but-unsaved character has `characterId: null`, and that
     * numeric id is how OhAPI's image endpoint addresses a character, so
     * until she is saved there can never be a second photograph of her.
     * Measured on staging: unsaved reports null, saved reports a number.
     *
     * It happens automatically rather than behind a "Confirm" button,
     * because saving costs nothing, cannot be done twice ("already saved" is
     * a 400), and a companion who is finished but unsaved is one who can
     * never be photographed again — a worse outcome than a saved companion
     * the user deletes, which is a button they already have.
     *
     * Deliberately AFTER we are done: her picture is downloaded and her row
     * says ready, so a failure here must not undo any of it. She simply has
     * no provider id, which is recoverable later and invisible for now.
     */
    try {
      await saveCharacter(env, started.characterGuid);
      const characterId = await awaitSavedId(deps, started.characterGuid);
      if (characterId !== null) {
        await db
          .update(userCompanions)
          .set({ providerCharacterId: characterId, updatedAt: new Date() })
          .where(eq(userCompanions.id, companionId));
      } else {
        log.warn({ companionId }, 'my-ai: provider save did not report an id in time');
      }
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

/** How long to wait for a save to land before giving up on the id for now. */
const SAVE_TIMEOUT_MS = 60_000;
const SAVE_INTERVAL_MS = 3_000;

/**
 * Wait for the save to finish and report the id it minted.
 *
 * `save` answers 202 and finishes behind the request, exactly like generate,
 * so the id is not in its response — it appears on the status endpoint when
 * the status reaches `saved`.
 *
 * Returns null rather than throwing on a timeout. By this point she is
 * already complete and visible to her owner; not having the provider id is a
 * missing future capability, not a failed creation.
 */
async function awaitSavedId(deps: GenerationDeps, guid: string): Promise<number | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + SAVE_TIMEOUT_MS;

  while (now() < deadline) {
    await sleep(SAVE_INTERVAL_MS);
    const polled = await getCharacterStatus(deps.env, guid);
    if (polled.characterId !== null) return polled.characterId;
    if (polled.status === 'failed') return null;
  }
  return null;
}

/**
 * Start the generation, and survive the one 400 that is worth a second try.
 *
 * `additionalDescription` is the only free text in the payload — everything
 * else is a value from a fixed vocabulary — and OhAPI moderates it, answering
 * `400 {"message":"Additional details blocked by moderation"}`. Rather than
 * lose a companion the user has just spent five steps building, it goes again
 * without that field: she arrives without the outfit phrase, and for five of
 * eight hairstyles without the prose describing her hair. A smaller loss than
 * nothing at all, and the second attempt costs nothing because a refused
 * request was never a generation.
 *
 * ONLY on moderation. A 400 for a missing field or an under-21 date of birth
 * means precisely the same thing the second time.
 */
async function startGeneration(
  env: MyAiEnv,
  payload: OhCharacterPayload,
  log: GenerationDeps['log'],
  companionId: string,
) {
  try {
    return await generateCharacter(env, payload);
  } catch (cause) {
    const moderated =
      cause instanceof OhRequestError &&
      cause.status === 400 &&
      /moderat/i.test(cause.providerDetail);
    if (!moderated || payload.additionalDescription === undefined) throw cause;

    log.warn({ companionId }, 'my-ai: provider moderation refused the free text; retrying without it');
    const { additionalDescription: _dropped, ...withoutFreeText } = payload;
    return generateCharacter(env, withoutFreeText);
  }
}

/**
 * Copy her reference portrait onto OUR media volume.
 *
 * A thin wrapper over the shared downloader, kept by name because this is the
 * one picture that is NOT a row in `user_companion_photos`: the provider drew
 * it from her attributes, and it is the input to every photograph asked for
 * later.
 */
export function downloadPortrait(
  url: string,
  storageDir: string,
  companionId: string,
  sleep: (ms: number) => Promise<void>,
  attempts = DOWNLOAD_ATTEMPTS,
): Promise<string> {
  return downloadImage(url, storageDir, 'my-ai', companionId, sleep, attempts);
}

/**
 * Delete her ORIGINAL portrait, leaving her in place.
 *
 * She survives it. The provider keeps its own copy of her reference image —
 * this is a copy on our volume — so further photographs of her still work.
 * The gallery simply falls back to whatever else she has, and a companion
 * with nothing left shows the empty state rather than disappearing.
 */
export async function deletePortrait(
  db: Db,
  userId: string,
  id: string,
  storageDir: string,
): Promise<boolean> {
  const row = await getCompanion(db, userId, id);
  if (!row?.imagePath) return false;

  const cleared = await db
    .update(userCompanions)
    .set({ imagePath: null, updatedAt: new Date() })
    .where(and(eq(userCompanions.id, id), eq(userCompanions.userId, userId)))
    .returning({ id: userCompanions.id });
  if (cleared.length === 0) return false;

  await removeImage(row.imagePath, storageDir);
  return true;
}
