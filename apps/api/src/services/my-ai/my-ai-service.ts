import { and, desc, eq } from 'drizzle-orm';
import type { MyAiCompanion, MyAiDraft } from '@over18/shared';
import type { Db } from '../../db/client.js';
import { userCompanions, type UserCompanionRow } from '../../db/schema.js';
import type { MyAiEnv } from '../../env.js';
import { removeImage } from './media.js';
import { photoPathsFor, renderPhotoToFile } from './my-ai-photos.js';
import { openingPhotoPrompt, toOhPayload, type OhCharacterPayload } from './oh-mapping.js';
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
/*
 * Tightened from 4s, then from 2.5s. This interval is now ON the headline
 * number — a companion becomes usable the moment this loop notices she is
 * drawn, so on average half of it is added to the only wait the user sees.
 * A status GET is cheap next to the render it watches; a second of her life
 * is not.
 */
const POLL_INTERVAL_MS = 1_500;
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
     * Her picture's progress, separately from hers. The client polls on this,
     * because `status` now reaches 'ready' about a minute before the
     * photograph does.
     */
    portraitStatus: row.portraitStatus,
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

/**
 * She could not be drawn at all.
 *
 * `portraitStatus` goes with her: a companion who never existed has no
 * photograph on the way, and leaving it 'pending' would have the client poll
 * for one until the tab is closed.
 */
const fail = async (db: Db, id: string, message: string) => {
  await db
    .update(userCompanions)
    .set({
      status: 'failed',
      portraitStatus: 'failed',
      errorMessage: message,
      updatedAt: new Date(),
    })
    .where(eq(userCompanions.id, id));
};

/**
 * Settle the PHOTOGRAPH's outcome, leaving her alone.
 *
 * Used for every way the picture can be lost after she is already `ready` and
 * in use — a provider save that never reports an id, a render that throws.
 * Deliberately never touches `status`: she is finished and may be mid
 * conversation, and the only thing that failed is a picture.
 */
const markPortrait = async (db: Db, id: string, outcome: 'ready' | 'failed') => {
  await db
    .update(userCompanions)
    .set({ portraitStatus: outcome, updatedAt: new Date() })
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

  const startedAt = now();
  const since = () => Math.round((now() - startedAt) / 1000);

  /*
   * Whether she has already been handed to her owner.
   *
   * Everything after the flip to `ready` — the provider save, the opening
   * photograph — concerns her PICTURE, not her. Once this is true a thrown
   * error must never mark her failed: she is on her owner's list and may be
   * mid-conversation, and "she could not be created" about a companion you
   * are talking to is simply a lie.
   */
  let isUsable = false;

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
     * WAIT UNTIL SHE IS DRAWN, which is a question only the status endpoint
     * answers. The 202 that accepts the job reports a status too, and it is
     * the status of a job that has not started — treating it as "done" is how
     * the first companion ever created failed 1.3 seconds in.
     *
     * Her reference image is NOT collected here. It exists, and it is naked
     * every time whatever we send; the picture this product shows is asked
     * for in words further down.
     */
    let status = started.status;

    const deadline = now() + POLL_TIMEOUT_MS;
    while (!isRendered(status) && now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const polled = await getCharacterStatus(env, started.characterGuid);
      status = polled.status;
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

    /*
     * ── HER REFERENCE IMAGE IS DELIBERATELY NOT DOWNLOADED ──────────────────
     *
     * It exists, and `imageUrl` points at it, and it is NAKED — every time,
     * whatever we send. It is a single canonical body render, and nothing on
     * the character request controls clothing: `additionalDescription` is
     * documented as traits (a piercing, freckles, a tattoo), and
     * `contentLevel` is a ceiling on what she will engage with rather than an
     * instruction about what to draw. Both were tried. Honda arrived naked.
     *
     * So the provider keeps that image as their own record of her, and the
     * picture WE show is asked for in words below. Nothing nude is ever
     * downloaded or displayed unless her owner asks for it in so many words.
     */

    /*
     * ── SHE IS FINISHED HERE, AND THIS IS THE WHOLE POINT ───────────────────
     *
     * `ready` the moment she is DRAWN — not when her photograph arrives.
     *
     * Creation used to mean three serial provider jobs, and it was measured on
     * staging four times over: drawn in 15-19s, saved in a further 17s, and
     * then a 53-second second render for her opening photograph. Eighty-odd
     * seconds, of which she spent sixty-five already existing.
     *
     * None of what makes her usable is waiting on those two. Her conversation
     * is built from her own attributes and runs through our own model, so she
     * can be talked to the instant she is drawn; the save exists ONLY to mint
     * the provider id her photograph needs, and the photograph is a picture of
     * somebody who is already there.
     *
     * The 53 seconds cannot be shortened — there is no quality, step or model
     * parameter on the provider's image endpoint, `imageModel` is accepted
     * unvalidated, and resolution makes no difference (52s at 1080x1920, 53s
     * at 720x1280). So the wait is not removed, it is moved OFF the thing the
     * user is waiting for. She arrives in under half a minute and her
     * photograph develops behind her.
     */
    log.info({ companionId, afterSeconds: since() }, 'my-ai: character drawn');

    const [usable] = await db
      .update(userCompanions)
      .set({ status: 'ready', errorMessage: null, updatedAt: new Date() })
      .where(eq(userCompanions.id, companionId))
      .returning();
    if (!usable) {
      log.info({ companionId }, 'my-ai companion was deleted while being created');
      return;
    }
    isUsable = true;
    log.info({ companionId, afterSeconds: since() }, 'my-ai companion ready');

    /*
     * SAVE HER AT THE PROVIDER, which is what mints the numeric id. A
     * generated-but-unsaved character has `characterId: null`, and that id is
     * how the image endpoint addresses a character — so until she is saved
     * there can be no photograph of her at all, which now includes the first
     * one. Verified both ways on staging: unsaved reports null, and the image
     * endpoint answers `404 Character <guid> not found` when handed the guid,
     * so this step cannot be skipped or run alongside the photograph.
     *
     * It happens automatically rather than behind a "Confirm" button, because
     * saving costs nothing and cannot be done twice ("already saved" is a
     * 400), and a companion who is finished but unsaved could never be
     * photographed again.
     *
     * A FAILURE HERE NO LONGER FAILS HER. She is already `ready` and her owner
     * is already talking to her; only the photograph is lost.
     */
    await saveCharacter(env, started.characterGuid);
    const characterId = await awaitSavedId(deps, started.characterGuid);
    if (characterId === null) {
      log.warn({ companionId }, 'my-ai: provider save did not report an id in time');
      await markPortrait(db, companionId, 'failed');
      return;
    }

    const [withId] = await db
      .update(userCompanions)
      .set({ providerCharacterId: characterId, updatedAt: new Date() })
      .where(eq(userCompanions.id, companionId))
      .returning();
    if (!withId) {
      log.info({ companionId }, 'my-ai companion was deleted while being created');
      return;
    }

    /*
     * ── HER OPENING PHOTOGRAPH ──────────────────────────────────────────────
     *
     * Automatic, and never a choice in the flow: a bikini and somewhere
     * bright. This is the request that takes a description of a picture, and
     * therefore the only one that can promise she is dressed.
     *
     * It is a second generation, and it costs. That is the price of a card
     * that is not pornographic by default, and there is no cheaper mechanism
     * at this provider.
     */
    log.info({ companionId, afterSeconds: since() }, 'my-ai: character saved');

    const prompt = openingPhotoPrompt({ name: withId.name, attributes: withId.attributes });
    let imagePath: string | null = null;
    try {
      imagePath = await renderPhotoToFile({ db, env, storageDir: deps.storageDir, log, sleep, now }, withId, {
        prompt,
        style: 'glam',
        subdir: 'my-ai',
        fileId: companionId,
      });
    } catch (cause) {
      /*
       * SHE STILL EXISTS — and by now her owner may well be mid-conversation
       * with her, because she became `ready` a minute ago. The expensive,
       * irreversible part is done; losing her over a failed photograph would
       * throw away the thing that cost the most. Her page invites a picture
       * instead. What must never happen is falling back to the nude reference
       * to fill the gap.
       */
      log.warn(
        { companionId, providerDetail: cause instanceof OhRequestError ? cause.providerDetail : String(cause) },
        'my-ai: opening photo failed; she exists without a picture',
      );
    }

    /*
     * HER STATUS IS NOT TOUCHED HERE. She was marked `ready` the moment she
     * was drawn, and re-asserting it now would quietly undo anything that
     * happened to her in the meantime.
     */
    const finished = await db
      .update(userCompanions)
      .set({
        imagePath,
        portraitStatus: imagePath ? ('ready' as const) : ('failed' as const),
        updatedAt: new Date(),
      })
      .where(eq(userCompanions.id, companionId))
      .returning({ id: userCompanions.id });

    /*
     * SHE WAS DELETED WHILE SHE WAS BEING MADE. Nothing to update means the
     * row is gone, so the file just written belongs to nobody — remove it, or
     * a user who deleted a companion mid-generation leaves a picture behind
     * that nothing will ever reference or clean up.
     */
    if (finished.length === 0) {
      if (imagePath) await removeImage(imagePath, deps.storageDir);
      log.info({ companionId }, 'my-ai companion was deleted while being created; portrait discarded');
      return;
    }

    /*
     * The stage timings are logged because "it took over a minute" was
     * otherwise a question only archaeology could answer: three provider
     * jobs, and no way to tell which one was slow without reconstructing it
     * from timestamps afterwards. `afterSeconds` here is the PHOTOGRAPH's
     * arrival, long after the companion's own.
     */
    log.info(
      { companionId, withPhoto: imagePath !== null, afterSeconds: since() },
      'my-ai: opening photo settled',
    );
  } catch (cause) {
    // Provider text goes to the log; the owner gets something plain.
    log.error(
      { companionId, isUsable, providerDetail: cause instanceof OhRequestError ? cause.providerDetail : String(cause) },
      'my-ai generation errored',
    );

    /*
     * ONLY THE PICTURE FAILED, if she was already handed over. The provider
     * save throws from here — it is the step between her becoming usable and
     * her photograph being asked for — and marking a companion her owner is
     * talking to as "could not be created" would be both wrong and
     * destructive.
     */
    if (isUsable) {
      await markPortrait(db, companionId, 'failed').catch(() => {});
      return;
    }

    await fail(
      db,
      companionId,
      cause instanceof OhRequestError ? cause.message : 'She could not be created. Please try again.',
    ).catch(() => {});
  }
}

/** How long to wait for a save to land before giving up on the id for now. */
const SAVE_TIMEOUT_MS = 60_000;
const SAVE_INTERVAL_MS = 2_000;

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
