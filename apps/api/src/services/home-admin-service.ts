import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  appCategories,
  appCategoryAssets,
  characters,
  characterVisualAssets,
  homeHeroClips,
} from '../db/schema.js';
import { PUBLISHABLE_STATUS, assetPreviewUrl } from './app-merchandising-service.js';
import { mediaTypeOf } from './content-review-service.js';

/**
 * Home composition — the ADMIN side (US-102.4).
 *
 * Everything an operator changes about Home lives here: which categories are
 * published to it and in what order, and which clips are in the Hero. The
 * public read is home-composition-service; the two are separate modules for the
 * same reason US-102.2 split its two reads — so a public caller cannot reach an
 * admin shape by forgetting an argument.
 *
 * PLAY WITH ME IS NOT HERE, and neither is Recently Added. Both were rails an
 * operator arranged by hand; both are now either deterministic from the content
 * (Play with Me) or removed outright (Recently Added).
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
      assetCount: sql<number>`(
        select count(*)::int from ${appCategoryAssets}
        where ${appCategoryAssets.categoryId} = ${appCategories.id}
      )`,
      publishableAssetCount: sql<number>`(
        select count(*)::int
        from ${appCategoryAssets}
        join ${characterVisualAssets} on ${characterVisualAssets.id} = ${appCategoryAssets.assetId}
        where ${appCategoryAssets.categoryId} = ${appCategories.id}
          and ${characterVisualAssets.status} = ${PUBLISHABLE_STATUS}
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
      .select({ id: appCategories.id })
      .from(appCategories)
      .where(eq(appCategories.homePublished, true));
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
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(appCategories)
        .set({ homePosition: index, updatedAt: new Date() })
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

export type HeroAddRejection = 'not_found' | 'not_approved' | 'already_present';

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
    .select({ id: characterVisualAssets.id, status: characterVisualAssets.status })
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
 */
export async function listHeroCandidates(db: Db, limit = 100) {
  const rows = await db
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
      ),
    )
    .orderBy(desc(characterVisualAssets.approvedAt), asc(characterVisualAssets.id))
    .limit(limit);

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
 * Play with me has NO ADMIN SURFACE
 *
 * The rail is one deterministic rule — active character, her newest publicly
 * reachable video, one card — computed in home-composition-service. There is
 * nothing here to configure, so there is nothing here.
 *
 * WHY THE CURATION WAS DELETED RATHER THAN FIXED. It was "automatic unless
 * overridden", and in the automatic state the rail already contained every
 * candidate — so the Add picker had nothing left to offer and an operator could
 * not put a character back. Keeping it meant maintaining two modes, a
 * materialise-on-first-edit step and a reset, to arrange a list the video rule
 * already determines. An operator who wants a character on the rail approves
 * and publishes a video of hers; that is the only lever, and it is the same one
 * that makes her content public at all.
 *
 * `home_play_with_me_characters` is retained in the schema and read by nothing,
 * so this removal needed no migration.
 * ------------------------------------------------------------------ */
