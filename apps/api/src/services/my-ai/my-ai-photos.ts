import { and, desc, eq } from 'drizzle-orm';
import type { MyAiPhoto } from '@over18/shared';
import { MY_AI_REFERENCE_PHOTO_ID } from '@over18/shared';
import type { Db } from '../../db/client.js';
import {
  userCompanionPhotos,
  userCompanions,
  type UserCompanionPhotoRow,
  type UserCompanionRow,
} from '../../db/schema.js';
import type { MyAiEnv } from '../../env.js';
import { downloadImage, removeImage } from './media.js';
import { OhRequestError, generateImage, getJobStatus } from './oh-client.js';

/**
 * My AI — the photographs a user asks for of a companion they already have.
 *
 * ── OWNERSHIP RUNS THROUGH THE COMPANION ────────────────────────────────────
 *
 * A photograph has no user of its own. It belongs to a companion, and the
 * companion belongs to an account — so every read here joins back to
 * `user_companions` and filters on `userId`. There is deliberately no "get
 * photo by id": the first time one exists, somebody calls it from a route and
 * a stranger's photograph becomes readable by guessing a uuid.
 *
 * ── EVERY ROW IS MONEY ──────────────────────────────────────────────────────
 *
 * One row, one generation, one charge at the provider. Pricing is not wired
 * up yet; when it is, this table is what it counts. Until then the only brake
 * is one generation at a time per user, enforced in the route.
 */

/** Long enough for a busy queue, short enough that a stuck job is not forever. */
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const JOB_INTERVAL_MS = 4_000;

export function toPhotoWire(row: UserCompanionPhotoRow): MyAiPhoto {
  return {
    id: row.id,
    url: row.imagePath ? `/api/my-ai/${row.companionId}/photos/${row.id}/image` : null,
    prompt: row.prompt,
    style: row.style,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    isReference: false,
  };
}

/**
 * Her original portrait, dressed as a photograph.
 *
 * It does not live in the photographs table — the provider drew it from her
 * attributes and every other photograph is generated FROM it — but the
 * gallery shows one list, so it answers to the reserved id `reference` and
 * keeps its own route.
 */
export function referencePhoto(companion: UserCompanionRow): MyAiPhoto | null {
  if (!companion.imagePath) return null;
  return {
    id: MY_AI_REFERENCE_PHOTO_ID,
    url: `/api/my-ai/${companion.id}/image`,
    prompt: '',
    style: 'glam',
    status: 'ready',
    createdAt: companion.createdAt.toISOString(),
    isReference: true,
  };
}

/** This companion's photographs, newest first. Scoped by the caller. */
export function listPhotos(db: Db, companionId: string): Promise<UserCompanionPhotoRow[]> {
  return db
    .select()
    .from(userCompanionPhotos)
    .where(eq(userCompanionPhotos.companionId, companionId))
    .orderBy(desc(userCompanionPhotos.createdAt));
}

/**
 * One photograph, only if the asking account owns the companion it belongs to.
 *
 * The join is the whole point: a photo id alone proves nothing about who may
 * see it. Null for "not yours" and "does not exist" alike.
 */
export async function getPhoto(
  db: Db,
  userId: string,
  companionId: string,
  photoId: string,
): Promise<UserCompanionPhotoRow | null> {
  const [row] = await db
    .select({ photo: userCompanionPhotos })
    .from(userCompanionPhotos)
    .innerJoin(userCompanions, eq(userCompanions.id, userCompanionPhotos.companionId))
    .where(
      and(
        eq(userCompanionPhotos.id, photoId),
        eq(userCompanionPhotos.companionId, companionId),
        eq(userCompanions.userId, userId),
      ),
    )
    .limit(1);
  return row?.photo ?? null;
}

/** Every photograph this user currently has in flight, across all companions. */
export async function countGenerating(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ id: userCompanionPhotos.id })
    .from(userCompanionPhotos)
    .innerJoin(userCompanions, eq(userCompanions.id, userCompanionPhotos.companionId))
    .where(and(eq(userCompanions.userId, userId), eq(userCompanionPhotos.status, 'generating')));
  return rows.length;
}

/** Record the request before the provider is called, exactly like a companion. */
export async function createPhoto(
  db: Db,
  companionId: string,
  input: { prompt: string; style: string },
): Promise<UserCompanionPhotoRow> {
  const [row] = await db
    .insert(userCompanionPhotos)
    .values({ companionId, prompt: input.prompt.trim(), style: input.style, status: 'generating' })
    .returning();
  return row;
}

export async function deletePhoto(
  db: Db,
  userId: string,
  companionId: string,
  photoId: string,
  storageDir: string,
): Promise<boolean> {
  const row = await getPhoto(db, userId, companionId, photoId);
  if (!row) return false;

  const deleted = await db
    .delete(userCompanionPhotos)
    .where(eq(userCompanionPhotos.id, photoId))
    .returning({ id: userCompanionPhotos.id });
  if (deleted.length === 0) return false;

  if (row.imagePath) await removeImage(row.imagePath, storageDir);
  return true;
}

/** Every file belonging to a companion's photographs, for deleting her. */
export async function photoPathsFor(db: Db, companionId: string): Promise<string[]> {
  const rows = await db
    .select({ imagePath: userCompanionPhotos.imagePath })
    .from(userCompanionPhotos)
    .where(eq(userCompanionPhotos.companionId, companionId));
  return rows.map((r) => r.imagePath).filter((p): p is string => typeof p === 'string');
}

export interface PhotoGenerationDeps {
  db: Db;
  env: MyAiEnv;
  storageDir: string;
  log: {
    info: (o: object, m: string) => void;
    warn: (o: object, m: string) => void;
    error: (o: object, m: string) => void;
  };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const fail = (db: Db, id: string, message: string) =>
  db
    .update(userCompanionPhotos)
    .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
    .where(eq(userCompanionPhotos.id, id));

/**
 * Drive one photograph to completion. Never throws, like its sibling: a
 * background job that rejects takes the reason with it.
 */
export async function runPhotoGeneration(
  deps: PhotoGenerationDeps,
  photoId: string,
): Promise<void> {
  const { db, env, log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  try {
    const [found] = await db
      .select({ photo: userCompanionPhotos, companion: userCompanions })
      .from(userCompanionPhotos)
      .innerJoin(userCompanions, eq(userCompanions.id, userCompanionPhotos.companionId))
      .where(eq(userCompanionPhotos.id, photoId))
      .limit(1);
    if (!found) return;

    const { photo, companion } = found;

    /*
     * WITHOUT HER PROVIDER ID THERE IS NOBODY TO PHOTOGRAPH. It appears when
     * she is saved, and a companion whose save never completed has none — so
     * this is a real state, not an impossible one, and it must not become an
     * opaque provider error.
     */
    if (companion.providerCharacterId === null) {
      log.warn({ photoId }, 'my-ai photo: companion has no provider id');
      await fail(db, photoId, 'She is not ready for new photos yet.');
      return;
    }

    const job = await startImageJob(env, companion, photo.prompt, photo.style, log, photoId);

    await db
      .update(userCompanionPhotos)
      .set({ providerJobId: job.jobId, updatedAt: new Date() })
      .where(eq(userCompanionPhotos.id, photoId));

    const deadline = now() + JOB_TIMEOUT_MS;
    let url: string | null = null;

    while (now() < deadline) {
      await sleep(JOB_INTERVAL_MS);
      const polled = await getJobStatus(env, job.jobId);
      if (polled.status === 'failed') {
        log.warn({ photoId, providerDetail: polled.error }, 'my-ai photo failed at the provider');
        await fail(db, photoId, 'That photo could not be made. Try describing it differently.');
        return;
      }
      if (polled.status === 'completed' && polled.url) {
        url = polled.url;
        break;
      }
    }

    if (!url) {
      log.warn({ photoId }, 'my-ai photo timed out');
      await fail(db, photoId, 'That photo took too long. Please try again.');
      return;
    }

    const imagePath = await downloadImage(url, deps.storageDir, 'my-ai/photos', photoId, sleep);

    const finished = await db
      .update(userCompanionPhotos)
      .set({ status: 'ready', imagePath, errorMessage: null, updatedAt: new Date() })
      .where(eq(userCompanionPhotos.id, photoId))
      .returning({ id: userCompanionPhotos.id });

    // Deleted while it was being made: the file belongs to nobody now.
    if (finished.length === 0) {
      await removeImage(imagePath, deps.storageDir);
      log.info({ photoId }, 'my-ai photo was deleted while being made; file discarded');
      return;
    }

    log.info({ photoId }, 'my-ai photo ready');
  } catch (cause) {
    log.error(
      { photoId, providerDetail: cause instanceof OhRequestError ? cause.providerDetail : String(cause) },
      'my-ai photo generation errored',
    );
    await fail(
      db,
      photoId,
      cause instanceof OhRequestError ? cause.message : 'That photo could not be made.',
    ).catch(() => {});
  }
}

/**
 * Ask for the photograph, addressing her by the id that works.
 *
 * OhAPI documents `character_id` as a string and gives no example, and a
 * character has two identifiers: the numeric id minted when she is saved, and
 * the guid of the job that generated her. Rather than guess and have every
 * photograph fail, this tries the numeric id and falls back to the guid once.
 *
 * It costs nothing to be wrong: a refused request is not a generation, so the
 * fallback is free. Which one worked is logged, so this stops being a
 * question the first time anyone reads the logs.
 */
async function startImageJob(
  env: MyAiEnv,
  companion: UserCompanionRow,
  prompt: string,
  style: string,
  log: PhotoGenerationDeps['log'],
  photoId: string,
) {
  const numeric = String(companion.providerCharacterId);
  try {
    return await generateImage(env, { characterId: numeric, prompt, style });
  } catch (cause) {
    const worthRetrying =
      cause instanceof OhRequestError &&
      (cause.status === 400 || cause.status === 404) &&
      companion.providerCharacterGuid !== null;
    if (!worthRetrying) throw cause;

    log.warn({ photoId }, 'my-ai photo: numeric character id refused, retrying with the guid');
    return generateImage(env, {
      characterId: companion.providerCharacterGuid!,
      prompt,
      style,
    });
  }
}
