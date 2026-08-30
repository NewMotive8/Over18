import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  appCategories,
  appCategoryAssets,
  characters,
  characterVisualAssets,
  homeHeroClips,
  homePlayWithMeCharacters,
} from '../db/schema.js';
import { PUBLISHABLE_STATUS, assetPreviewUrl } from './app-merchandising-service.js';
import { mediaTypeOf } from './content-review-service.js';
import { PUBLIC_CONTENT_KINDS } from './asset-kinds.js';
/**
 * The public rail, reused rather than re-derived. One direction only:
 * home-composition-service imports nothing from here, so this cannot cycle.
 */
import { listPlayWithMe } from './home-composition-service.js';

/**
 * Home composition — the ADMIN side (US-102.4).
 *
 * Everything an operator changes about Home lives here: which categories are
 * published to it and in what order, and which clips are in the Hero. The
 * public read is home-composition-service; the two are separate modules for the
 * same reason US-102.2 split its two reads — so a public caller cannot reach an
 * admin shape by forgetting an argument.
 *
 * PLAY WITH ME IS HERE AGAIN, and Recently Added is not. The rail's automatic
 * rule is unchanged and is still what runs by default; what returns is the
 * OVERRIDE that `home_play_with_me_characters` was always shaped to hold —
 * empty means automatic, rows mean those characters in that order. Recently
 * Added stays removed outright.
 *
 * ADMIN VIEWS CARRY ADMIN FACTS. These rows include `publishable`, `status` and
 * an admin-gated preview URL, because an operator has to see that a Hero clip
 * they assigned has since lost approval. The public projection has none of it.
 *
 * NOTHING HERE WRITES TO THE LIBRARY. The only tables written are
 * `app_categories` (two Home columns) and `home_hero_clips`. There is no
 * UPDATE or DELETE against
 * `character_visual_assets` or `characters` in this file, which is what makes
 * "composing Home never modifies content" a property of the module.
 */

export class HomeAdminValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'HomeAdminValidationError';
  }
}

export class HomeAdminOrderError extends Error {
  constructor(
    public readonly reason: 'unknown_id' | 'incomplete' | 'duplicate',
    message: string,
  ) {
    super(message);
    this.name = 'HomeAdminOrderError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape-checks an id before it reaches a uuid column — a clean 400, not a 500. */
function assertUuid(value: string, field: string, noun: string): string {
  if (!UUID_RE.test(value)) {
    throw new HomeAdminValidationError(field, `That is not a valid ${noun}.`);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Category publication to Home
 * ------------------------------------------------------------------ */

export interface HomeCategoryView {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  /** Category-level availability across the whole CMS (US-102.1). */
  enabled: boolean;
  /** Whether it appears on Home. INDEPENDENT of `enabled`. */
  homePublished: boolean;
  homePosition: number;
  /** How many of its assets are currently publishable — what Home would show. */
  publishableAssetCount: number;
  /** Total assignments, publishable or not, so an operator sees the gap. */
  assetCount: number;
  /**
   * True when this category is published to Home but would render nothing —
   * either because it is disabled, or because none of its content is approved.
   * Derived, never stored.
   */
  wouldRenderEmpty: boolean;
}

export async function listHomeCategories(db: Db): Promise<HomeCategoryView[]> {
  const rows = await db
    .select({
      category: appCategories,
      /**
       * BOTH SUBQUERIES ALIAS THEIR TABLES, and that is not stylistic.
       *
       * Drizzle interpolates a column reference as a BARE name, so
       * `${appCategories.id}` inside a subquery emits `"id"` and correlates by
       * whatever `id` happens to be in scope. `publishableAssetCount` joins
       * `character_visual_assets`, which HAS an `id` — so the intended outer
       * correlation was captured by the asset's own id and the predicate became
       * `app_category_assets.category_id = character_visual_assets.id`,
       * comparing a category id against an asset id. It never matched, so the
       * count was structurally ALWAYS ZERO and `wouldRenderEmpty` was therefore
       * always true: the composer warned "no content yet" on every published
       * category, including ones rendering perfectly, so the one signal that
       * tells an operator a category will render nothing said nothing at all.
       *
       * `assetCount` escaped it only by luck — `app_category_assets` has no
       * `id` column (its key is category_id + asset_id), so there was nothing
       * inner to capture. It is written the same way here, because that is an
       * accident of the schema rather than a property anyone should rely on.
       *
       * THE OUTER CORRELATION IS QUALIFIED, not merely the inner tables.
       * Aliasing the subquery's tables does not help on its own: `asset.id` is
       * still visible as an unqualified `id`, so a bare reference would be
       * captured exactly as before. `${appCategories}.id` names the outer table
       * explicitly, which is the part that makes this unambiguous.
       */
      assetCount: sql<number>`(
        select count(*)::int from ${appCategoryAssets} link
        where link.category_id = ${appCategories}.id
      )`,
      publishableAssetCount: sql<number>`(
        select count(*)::int
        from ${appCategoryAssets} link
        join ${characterVisualAssets} asset on asset.id = link.asset_id
        where link.category_id = ${appCategories}.id
          and asset.status = ${PUBLISHABLE_STATUS}
      )`,
    })
    .from(appCategories)
    .orderBy(asc(appCategories.homePosition), asc(appCategories.position), asc(appCategories.id));

  return rows.map(({ category, assetCount, publishableAssetCount }) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    tagline: category.tagline,
    enabled: category.enabled,
    homePublished: category.homePublished,
    homePosition: category.homePosition,
    assetCount: Number(assetCount),
    publishableAssetCount: Number(publishableAssetCount),
    wouldRenderEmpty:
      category.homePublished && (!category.enabled || Number(publishableAssetCount) === 0),
  }));
}

/**
 * Publishes or unpublishes ONE category to Home.
 *
 * Per category and independent of `enabled`, both of which are product
 * requirements rather than implementation convenience: publishing does not
 * enable a disabled category, and disabling one does not unpublish it. The two
 * flags are read together at composition time and neither silently rewrites the
 * other, so every change is exactly reversible by undoing it.
 *
 * Newly published categories append to the end of the Home order, so turning
 * one on never renumbers the arrangement already there.
 */
export async function setCategoryHomePublication(
  db: Db,
  categoryId: string,
  homePublished: boolean,
): Promise<HomeCategoryView | null> {
  assertUuid(categoryId, 'categoryId', 'category');
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(appCategories)
      .where(eq(appCategories.id, categoryId))
      .limit(1);
    if (!existing) return null;
    if (existing.homePublished === homePublished) {
      const all = await listHomeCategories(db);
      return all.find((c) => c.id === categoryId) ?? null;
    }

    let homePosition = existing.homePosition;
    if (homePublished) {
      const [{ next } = { next: 0 }] = await tx
        .select({ next: sql<number>`coalesce(max(${appCategories.homePosition}), -1) + 1` })
        .from(appCategories)
        .where(eq(appCategories.homePublished, true));
      homePosition = Number(next);
    }

    await tx
      .update(appCategories)
      .set({ homePublished, homePosition, updatedAt: new Date() })
      .where(eq(appCategories.id, categoryId));
    const all = await listHomeCategories(db);
    return all.find((c) => c.id === categoryId) ?? null;
  });
}

/**
 * Sets the Home order. Exact permutation of the PUBLISHED categories or refuse,
 * matching the contract US-102.1/.2/.3 all use.
 *
 * Scoped to published categories because unpublished ones have no place in the
 * arrangement — requiring the operator to list them would make the order go
 * stale every time an unrelated category was created.
 */
export async function reorderHomeCategories(db: Db, orderedIds: string[]): Promise<void> {
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new HomeAdminOrderError('duplicate', 'The same category was listed more than once.');
  }
  await db.transaction(async (tx) => {
    const published = await tx
      .select({ id: appCategories.id, position: appCategories.position })
      .from(appCategories)
      .where(eq(appCategories.homePublished, true))
      .orderBy(asc(appCategories.position), asc(appCategories.createdAt));
    const ids = new Set(published.map((row) => row.id));
    for (const id of orderedIds) {
      if (!ids.has(id)) {
        throw new HomeAdminOrderError('unknown_id', 'That category is not published to Home.');
      }
    }
    if (orderedIds.length !== ids.size) {
      throw new HomeAdminOrderError(
        'incomplete',
        'The order is out of date — it does not list every published category. Reload and try again.',
      );
    }
    /**
     * WRITES `position`, THE ONE ORDER, not a Home-only one.
     *
     * This screen arranges a SUBSET — only the categories published to Home —
     * so it cannot renumber 0..n-1 without inventing slots for the unpublished
     * ones. Instead it redistributes the `position` values the published
     * categories ALREADY occupy, in the new sequence. An unpublished category
     * keeps its own slot untouched, and the relative order of everything else
     * survives.
     *
     * It used to write `home_position`. That column is no longer read: the
     * rails follow `position`, so continuing to write it would have made this
     * button do nothing at all — the exact failure this change exists to fix.
     */
    const slots = published.map((row) => row.position);
    const now = new Date();
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(appCategories)
        .set({ position: slots[index]!, updatedAt: now })
        .where(eq(appCategories.id, id));
    }
  });
}

/* ------------------------------------------------------------------ *
 * Hero clips
 * ------------------------------------------------------------------ */

export interface HeroClipAdminView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  status: string;
  /** False when the clip is assigned but no longer approved — Home skips it. */
  publishable: boolean;
  position: number;
  previewUrl: string | null;
}

export async function listHeroClipsForAdmin(db: Db): Promise<HeroClipAdminView[]> {
  const rows = await db
    .select({
      assetId: homeHeroClips.assetId,
      position: homeHeroClips.position,
      characterId: characterVisualAssets.characterId,
      characterName: characters.displayName,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      status: characterVisualAssets.status,
    })
    .from(homeHeroClips)
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, homeHeroClips.assetId))
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .orderBy(asc(homeHeroClips.position), asc(homeHeroClips.assetId));

  return rows.map((row) => ({
    assetId: row.assetId,
    characterId: row.characterId,
    characterName: row.characterName,
    mediaType: mediaTypeOf(row.storageKey, row.provenance) === 'video' ? 'video' : 'image',
    status: row.status,
    publishable: row.status === PUBLISHABLE_STATUS,
    position: row.position,
    previewUrl: assetPreviewUrl(row.assetId, row.storageKey),
  }));
}

export type HeroAddRejection =
  | 'not_found'
  | 'not_approved'
  | 'already_present'
  | 'not_content';

export interface HeroAddOutcome {
  assetId: string;
  added: boolean;
  reason?: HeroAddRejection;
  status?: string;
}

/**
 * Adds clips to the Hero.
 *
 * Only approved content can be newly assigned — the same write-side rule
 * US-102.2 applies to category assignment, refused per asset rather than as a
 * batch failure so one bad id does not discard nine good ones.
 */
export async function addHeroClips(db: Db, assetIds: string[]): Promise<HeroAddOutcome[]> {
  const requested = Array.from(new Set(assetIds));
  // A malformed id is reported per asset, like every other rejection reason —
  // throwing here would discard nine good ids because of one typo, which is
  // exactly what this function's contract says it will not do.
  const malformed = requested.filter((id) => !UUID_RE.test(id));
  const unique = requested.filter((id) => UUID_RE.test(id));
  const rejected: HeroAddOutcome[] = malformed.map((assetId) => ({
    assetId,
    added: false,
    reason: 'not_found' as const,
  }));
  if (unique.length === 0) return rejected;

  const assets = await db
    .select({
      id: characterVisualAssets.id,
      status: characterVisualAssets.status,
      kind: characterVisualAssets.kind,
    })
    .from(characterVisualAssets)
    .where(inArray(characterVisualAssets.id, unique));
  const byId = new Map(assets.map((a) => [a.id, a]));

  const present = await db
    .select({ assetId: homeHeroClips.assetId })
    .from(homeHeroClips)
    .where(inArray(homeHeroClips.assetId, unique));
  const already = new Set(present.map((p) => p.assetId));

  const [{ next } = { next: 0 }] = await db
    .select({ next: sql<number>`coalesce(max(${homeHeroClips.position}), -1) + 1` })
    .from(homeHeroClips);
  let position = Number(next);

  const outcomes: HeroAddOutcome[] = [...rejected];
  for (const assetId of unique) {
    const asset = byId.get(assetId);
    if (!asset) {
      outcomes.push({ assetId, added: false, reason: 'not_found' });
      continue;
    }
    if (already.has(assetId)) {
      outcomes.push({ assetId, added: false, reason: 'already_present' });
      continue;
    }
    /**
     * The write-side half of the picker's kind rule. `listHeroClips` reads
     * `home_hero_clips` directly and applies no kind filter of its own, so a
     * row that gets in here is on the front page — this is the gate.
     */
    if (!(PUBLIC_CONTENT_KINDS as readonly string[]).includes(asset.kind)) {
      outcomes.push({ assetId, added: false, reason: 'not_content', status: asset.status });
      continue;
    }
    if (asset.status !== PUBLISHABLE_STATUS) {
      outcomes.push({ assetId, added: false, reason: 'not_approved', status: asset.status });
      continue;
    }
    await db.insert(homeHeroClips).values({ assetId, position: position++ });
    outcomes.push({ assetId, added: true });
  }
  return outcomes;
}

/** Removes a clip from the Hero. The asset itself is never touched. */
export async function removeHeroClip(db: Db, assetId: string): Promise<boolean> {
  assertUuid(assetId, 'assetId', 'asset id');
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ assetId: homeHeroClips.assetId })
      .from(homeHeroClips)
      .where(eq(homeHeroClips.assetId, assetId))
      .limit(1);
    if (!existing) return false;
    await tx.delete(homeHeroClips).where(eq(homeHeroClips.assetId, assetId));
    const rows = await tx
      .select({ assetId: homeHeroClips.assetId })
      .from(homeHeroClips)
      .orderBy(asc(homeHeroClips.position), asc(homeHeroClips.assetId));
    for (const [index, row] of rows.entries()) {
      await tx
        .update(homeHeroClips)
        .set({ position: index })
        .where(eq(homeHeroClips.assetId, row.assetId));
    }
    return true;
  });
}

export async function reorderHeroClips(db: Db, orderedAssetIds: string[]): Promise<void> {
  if (new Set(orderedAssetIds).size !== orderedAssetIds.length) {
    throw new HomeAdminOrderError('duplicate', 'The same clip was listed more than once.');
  }
  await db.transaction(async (tx) => {
    const existing = await tx.select({ assetId: homeHeroClips.assetId }).from(homeHeroClips);
    const ids = new Set(existing.map((row) => row.assetId));
    for (const id of orderedAssetIds) {
      if (!ids.has(id)) {
        throw new HomeAdminOrderError('unknown_id', 'That clip is no longer in the Hero.');
      }
    }
    if (orderedAssetIds.length !== ids.size) {
      throw new HomeAdminOrderError(
        'incomplete',
        'The order is out of date — it does not list every Hero clip. Reload and try again.',
      );
    }
    for (const [index, assetId] of orderedAssetIds.entries()) {
      await tx.update(homeHeroClips).set({ position: index }).where(eq(homeHeroClips.assetId, assetId));
    }
  });
}

/**
 * Approved clips an operator may add to the Hero, newest first.
 *
 * Approved-only by query construction, so the picker cannot offer something the
 * write path would then refuse.
 *
 * THE WHOLE ELIGIBLE LIBRARY, NOT A PAGE OF IT. `limit` is optional and
 * unbounded when omitted, because a picker that silently stops at a boundary is
 * a picker an operator cannot trust: reported from production as clips missing
 * from "Add clips", with no paging control, no "load more" and nothing on
 * screen to say a cap existed. Anything past the cut simply could not be put on
 * the Hero at all.
 *
 * IT WAS NEVER A PRODUCT DECISION. `listAssignmentCandidates` — the category
 * picker, doing the same job over the same table in the same admin — has never
 * had a cap, and the route's `boundedLimit` exists to stop `?limit=-5` reaching
 * Postgres rather than to bound the library. This was the odd one out.
 *
 * The parameter is KEPT so a caller can still ask for a bounded list, and the
 * route still clamps whatever it is given.
 */
export async function listHeroCandidates(db: Db, limit?: number) {
  const query = db
    .select({
      assetId: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      characterName: characters.displayName,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      approvedAt: characterVisualAssets.approvedAt,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(
      and(
        eq(characterVisualAssets.status, PUBLISHABLE_STATUS),
        eq(characters.status, 'active'),
        /**
         * CONTENT ONLY.
         *
         * This picker had no kind filter at all, so it offered identity
         * portraits alongside content — and would have offered chat media the
         * moment that kind existed. The Hero is the most public surface in the
         * product; an operator should not be able to put a character's private
         * chat clip or her profile portrait on the front page by picking it
         * from a list that never should have shown it.
         *
         * An allow-list, so a future kind is excluded by default.
         */
        inArray(characterVisualAssets.kind, [...PUBLIC_CONTENT_KINDS]),
      ),
    )
    .orderBy(desc(characterVisualAssets.approvedAt), asc(characterVisualAssets.id));

  // The bound, when one is asked for, is applied by the DATABASE rather than by
  // slicing rows it already sent.
  const rows = await (limit === undefined ? query : query.limit(limit));

  const inHero = new Set(
    (await db.select({ assetId: homeHeroClips.assetId }).from(homeHeroClips)).map((r) => r.assetId),
  );

  return rows.map((row) => ({
    assetId: row.assetId,
    characterId: row.characterId,
    characterName: row.characterName,
    mediaType: (mediaTypeOf(row.storageKey, row.provenance) === 'video' ? 'video' : 'image') as
      | 'image'
      | 'video',
    previewUrl: assetPreviewUrl(row.assetId, row.storageKey),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    inHero: inHero.has(row.assetId),
  }));
}

/* ------------------------------------------------------------------ *
 * Play with me — A CATEGORY IN THE ADMIN, WITH DERIVED MEMBERSHIP
 *
 * The rail is presented in Admin like any other category: its real clips, the
 * same board, the same drag gesture, the same exact-permutation-or-409 save.
 * Two things about it are NOT like any other category, and both are the point.
 *
 * MEMBERSHIP IS DERIVED, NOT STORED. There is no add and no remove. A character
 * is on the rail when she is active and has a publicly reachable video, and
 * that rule is untouched. The previous curation was deleted for a reason worth
 * not repeating: it was "automatic unless overridden", so in the automatic
 * state the rail already held every candidate, the Add picker had nothing left
 * to offer, and a removed character could not be put back.
 *
 * ORDER IS KEYED ON THE CHARACTER, NOT THE CLIP, which is why this cannot live
 * in `app_category_assets`. That table's key is `asset_id`, and this rail's
 * asset is DERIVED: `representativeClips` runs a `distinct on (character_id)`
 * whose winner changes the moment a newer video is approved or the current one
 * loses approval. An order keyed on the asset would go stale — or duplicate —
 * every time the content behind a card changed. `home_play_with_me_characters`
 * has been shaped for exactly this since US-102.4: character id, position, and
 * nothing else. NO MIGRATION.
 *
 * The rows say WHERE a card goes, never WHETHER it appears, so nothing here
 * reaps them: a saved character who is not eligible is skipped on read, and an
 * eligible character who was never saved is appended.
 * ------------------------------------------------------------------ */

/** The reserved slug the Admin routes this rail under. Not an app_categories row. */
export const PLAY_WITH_ME_SLUG = 'play-with-me';
export const PLAY_WITH_ME_NAME = 'Play with me';

/**
 * One rail card, in the SAME SHAPE the merchandising board already renders.
 *
 * Deliberately `CategoryAssetView`-compatible so the existing board component
 * needs no changes: it reads assetId, characterName, mediaType, status,
 * position and previewUrl exactly as it does for a real category.
 *
 * `characterId` is the field that matters on the way back out — it is what the
 * save is keyed on. `assetId` is the clip showing RIGHT NOW and is display
 * only; it is never persisted as an ordering key.
 */
export interface PlayWithMeContentView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  status: string;
  publishable: boolean;
  featured: false;
  position: number;
  previewUrl: string | null;
  contentRating: string;
  isPrimary: false;
}

export interface PlayWithMeContentsState {
  /** True when an operator order is saved; false while the rail is alphabetical. */
  ordered: boolean;
  assets: PlayWithMeContentView[];
}

/**
 * The rail exactly as Home composes it, in board shape.
 *
 * It calls `listPlayWithMe` rather than re-deriving membership, so the Admin
 * board can never show a card the app would drop, or drop one the app shows.
 * That drift is what made the old curation screen untrustworthy.
 */
export async function listPlayWithMeContents(db: Db): Promise<PlayWithMeContentsState> {
  const [cards, saved] = await Promise.all([
    listPlayWithMe(db),
    db.select({ characterId: homePlayWithMeCharacters.characterId }).from(homePlayWithMeCharacters),
  ]);

  return {
    ordered: saved.length > 0,
    assets: cards.map((card, index) => ({
      // Non-null by construction: listPlayWithMe drops every card without a
      // video clip before returning.
      assetId: card.clip!.id,
      characterId: card.id,
      characterName: card.displayName,
      mediaType: 'video' as const,
      status: 'approved',
      publishable: true,
      featured: false as const,
      // The rendered slot, not a stored column — the rail's order is the
      // sequence itself, and an unsaved rail still has one.
      position: index,
      previewUrl: card.clip!.url,
      contentRating: 'sfw',
      isPrimary: false as const,
    })),
  };
}

/**
 * Saves the rail's order, keyed on the CHARACTER behind each clip.
 *
 * The board hands back the clips it rendered; the route maps them to their
 * characters before this runs. Same contract as `reorderCategoryAssets`: an
 * exact permutation of what is currently on the rail, or 409 — a stale browser
 * must reload rather than silently reshuffle a rail that has changed.
 *
 * REPLACE, NOT MERGE. Rows are deleted and rewritten in one transaction, so no
 * stale character can survive alongside a new arrangement and there is no
 * partial state to reconcile on the next read.
 */
export async function reorderPlayWithMe(db: Db, orderedCharacterIds: string[]): Promise<void> {
  if (new Set(orderedCharacterIds).size !== orderedCharacterIds.length) {
    throw new HomeAdminOrderError('duplicate', 'The same character was listed more than once.');
  }
  const rail = await listPlayWithMe(db);
  const ids = new Set(rail.map((card) => card.id));
  for (const id of orderedCharacterIds) {
    if (!ids.has(id)) {
      throw new HomeAdminOrderError('unknown_id', 'That character is not on the Play with me rail.');
    }
  }
  if (orderedCharacterIds.length !== ids.size) {
    throw new HomeAdminOrderError(
      'incomplete',
      'The order is out of date — it does not list every card on the rail. Reload and try again.',
    );
  }
  await db.transaction(async (tx) => {
    await tx.delete(homePlayWithMeCharacters);
    for (const [index, characterId] of orderedCharacterIds.entries()) {
      await tx.insert(homePlayWithMeCharacters).values({ characterId, position: index });
    }
  });
}

/**
 * Maps the clips the board sends back to the characters they belong to.
 *
 * Refuses an asset that is not currently ON the rail, using the same 409 the
 * order itself uses: an id the board could not have rendered means the browser
 * is stale, and guessing a character for it would save an order nobody chose.
 */
export async function charactersForRailAssets(db: Db, assetIds: string[]): Promise<string[]> {
  const rail = await listPlayWithMe(db);
  const byAsset = new Map(rail.map((card) => [card.clip!.id, card.id]));
  return assetIds.map((assetId) => {
    const characterId = byAsset.get(assetId);
    if (!characterId) {
      throw new HomeAdminOrderError(
        'unknown_id',
        'That clip is no longer on the Play with me rail. Reload and try again.',
      );
    }
    return characterId;
  });
}

/**
 * Drops the saved order and returns the rail to alphabetical.
 *
 * Deleting the rows IS the reset — the read side treats empty as automatic — so
 * this needs no flag and leaves nothing to go stale. No character, asset or
 * file is touched.
 */
export async function clearPlayWithMeOrder(db: Db): Promise<void> {
  await db.delete(homePlayWithMeCharacters);
}
