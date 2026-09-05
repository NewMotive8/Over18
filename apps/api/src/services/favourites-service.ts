import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { characters, favourites } from '../db/schema.js';
import {
  playWithMeCardsFor,
  type PublicPlayWithMeCardView,
} from './home-composition-service.js';

/**
 * Favourites — the user-to-character relationship behind the Favourites tab.
 *
 * TRANSPORT-AGNOSTIC, like every other service here: the route does auth and
 * status codes, this file does the product rule. Nothing in here reads a
 * cookie, and nothing in the route touches a table.
 *
 * ── WHAT A FAVOURITE IS ──────────────────────────────────────────────────────
 *
 * A user and a character. That is the whole record. It carries no asset id, no
 * url and no media type, which is the single decision that makes the rest of
 * this file short: there is no stored locator to go stale, so there is nothing
 * to reap when an operator withdraws a clip, replaces one, or uploads a newer
 * one. What a favourite DISPLAYS is asked at read time.
 *
 * ── THE THREE SURFACES ASK ONE QUESTION ──────────────────────────────────────
 *
 * Play with me, Swipe and Favourites all render "a character plus her current
 * real published clip", and `playWithMeCardsFor` is the one function that
 * answers it — the same identity join, the same `representativeClips` query and
 * the same category membership Home composes. Favourites therefore CANNOT show
 * something Play with me would have refused: not a reference portrait, not a
 * profileImage, not a bundled demo clip, not a lettered tile. There is no
 * branch in this file that could produce one, because this file never chooses
 * media at all.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 *
 * No pass/history table: a left swipe writes nothing, so there is no row here
 * that could accumulate one. No ranking, no recommendation, no match state, no
 * per-favourite clip pinning. Swiping right adds; only the heart removes.
 */

export type AddFavouriteResult =
  | { ok: true; created: boolean }
  | { ok: false; error: 'character_not_found' };

/**
 * Save a character to a user's favourites. IDEMPOTENT BY CONSTRUCTION.
 *
 * `created` distinguishes a new save from a repeat, and the repeat case is the
 * product rule the swipe deck depends on: swiping right on a character who is
 * already favourited must leave her favourited, with her original `createdAt`
 * intact. `on conflict do nothing` against the composite primary key gives that
 * for free, and — unlike a read-then-write — it is race-safe, so two rapid
 * right swipes cannot produce a duplicate-key error.
 *
 * A right swipe can NEVER remove a favourite. There is no code path from here
 * to a delete; the only delete in this module is `removeFavourite`, which the
 * heart calls and nothing else does.
 *
 * ONLY ACTIVE CHARACTERS CAN BE SAVED, checked before the insert so an unknown
 * id and a retired one both read as `character_not_found` — the same
 * no-existence-leak rule `startConversation` follows. This is not a second
 * eligibility gate: a character who is active but currently has no publishable
 * clip is savable, because she is not in Swipe to be swiped at, and because a
 * favourite is allowed to outlive her content (see `listFavourites`).
 */
export async function addFavourite(
  db: Db,
  userId: string,
  characterId: string,
): Promise<AddFavouriteResult> {
  const [character] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.status, 'active')))
    .limit(1);
  if (!character) return { ok: false, error: 'character_not_found' };

  const inserted = await db
    .insert(favourites)
    .values({ userId, characterId })
    .onConflictDoNothing({ target: [favourites.userId, favourites.characterId] })
    .returning();

  return { ok: true, created: inserted.length > 0 };
}

/**
 * Remove a character from a user's favourites — what the filled heart does, and
 * the ONLY way a favourite is ever deleted.
 *
 * Returns whether a row actually went. Removing something that was not saved is
 * not an error: the desired end state (not favourited) already holds, so the
 * caller reports success and the heart lands on outline either way.
 *
 * Scoped to `userId` in the WHERE, so one account can never delete another's
 * favourite even with a valid character id.
 */
export async function removeFavourite(
  db: Db,
  userId: string,
  characterId: string,
): Promise<{ removed: boolean }> {
  const deleted = await db
    .delete(favourites)
    .where(and(eq(favourites.userId, userId), eq(favourites.characterId, characterId)))
    .returning();
  return { removed: deleted.length > 0 };
}

/**
 * A user's favourite CHARACTER IDS, exactly as persisted.
 *
 * The raw relationship, with no eligibility applied and no join — this is what
 * the heart reflects, and the heart must show what is SAVED rather than what is
 * currently displayable. A character whose last clip was withdrawn is still
 * favourited, and her heart must still be filled.
 */
export async function listFavouriteCharacterIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ characterId: favourites.characterId })
    .from(favourites)
    .where(eq(favourites.userId, userId))
    .orderBy(asc(favourites.createdAt), asc(favourites.characterId));
  return rows.map((row) => row.characterId);
}

/**
 * THE FAVOURITES SURFACE, from one read of the relationship.
 *
 * Two halves, both needed at once and deliberately different:
 *
 *   `favourites`   — the gallery cards, each carrying the clip that represents
 *                    her RIGHT NOW.
 *   `characterIds` — the raw persisted relationship, which is what the heart
 *                    reflects.
 *
 * A saved character with no current clip is in the second and not renderable
 * from the first. They share the id read rather than each performing their own.
 *
 * ── THE CLIP IS RESOLVED, NEVER STORED ───────────────────────────────────────
 *
 * `playWithMeCardsFor` re-runs the same `distinct on (character_id)` Home runs,
 * so if an operator publishes a newer video the tile follows on the next
 * request with nothing to migrate. If the current one loses approval the card's
 * clip becomes null and the tile disappears — no reaping, no stale url, no
 * broken image.
 *
 * ── A NULL CLIP IS RETURNED, NOT FILTERED ────────────────────────────────────
 *
 * That is the point of returning cards rather than only the renderable ones.
 * The favourite still exists and the client still has to know that: the row
 * survives, the heart stays filled, and she reappears in the gallery the moment
 * eligible content does. The gallery renders no tile for her — a placeholder or
 * a substitute image would be a claim that she has content, which is precisely
 * the dishonest behaviour this whole feature exists to remove.
 *
 * INACTIVE CHARACTERS ARE ABSENT FROM THE CARDS ENTIRELY, because the shared
 * row query gates on `status = 'active'`. Her favourite row is untouched, she
 * stays in `characterIds`, and she returns to the gallery if she is ever
 * reactivated.
 *
 * ALPHABETICAL, like the rail. Not by save time: one ordering rule in the
 * system is easier to reason about than two, and "most recently saved first" is
 * a ranking concept this feature deliberately does not have.
 */
export async function listFavourites(
  db: Db,
  userId: string,
): Promise<{ favourites: PublicPlayWithMeCardView[]; characterIds: string[] }> {
  const characterIds = await listFavouriteCharacterIds(db, userId);
  return { favourites: await playWithMeCardsFor(db, characterIds), characterIds };
}
