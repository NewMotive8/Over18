import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  appCategories,
  appCategoryAssets,
  assetKeywords,
  characters,
  characterVisualAssets,
  characterVisualIdentities,
  contentKeywords,
  discoveryCategories,
  discoveryCategoryKeywords,
  homeHeroClips,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { PUBLIC_CONTENT_KINDS, PUBLICLY_REACHABLE_KINDS } from './asset-kinds.js';
import { assetWorkflowOf } from './asset-lifecycle.js';

/**
 * DISTRIBUTION (P0.5) -- where an asset is exposed to customers, as one model.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 *
 * The product has four legitimate distribution surfaces, each owned by its own
 * screen, each recording its decision in its own table. That is right, and P0.5
 * does not merge them. What was missing is a single VOCABULARY for the question
 * they all answer -- "is this asset in front of customers, and where?" -- so the
 * rule was restated per reader, and the admin could not answer it at all.
 *
 * ── THE MODEL: TWO GATES, THEN A CHANNEL ─────────────────────────────────────
 *
 * An asset reaches customers only when BOTH hold:
 *
 *   1. It is DISTRIBUTABLE -- a property of the asset itself:
 *        workflow = approved   (P0.4: pending, rejected and archived are out,
 *                               by the same rule, everywhere)
 *        role     = content    (chat is private, a reference is identity)
 *        media    present      (a row with no bytes renders nothing)
 *        character active      (retiring her takes her content with her)
 *
 *   2. It has a record in at least one CHANNEL:
 *
 *        posts      `published_at`          released to her Posts tab
 *        hero       `home_hero_clips`       assigned to the Home Hero
 *        category   `app_category_assets`   in a category that is enabled AND
 *                                           published to Home
 *        discovery  `asset_keywords`        carries a keyword an ENABLED
 *                                           discovery category queries
 *
 * MODERATION IS NOT DISTRIBUTION. Approving something puts it in no channel;
 * archiving it removes it from all of them without touching a single channel
 * record; unarchiving (P0.4) clears those records rather than restoring them.
 * Commercial state, when it arrives, is a third axis and belongs in neither.
 *
 * THE CANONICAL GALLERY IS NOT A CHANNEL. A character's primary portrait is
 * public because it IS her identity, not because anyone merchandised it, so it
 * is reachable through its own arm below and never appears as distribution.
 */

/** The four customer-facing channels. Order is the order an operator reads. */
export const DISTRIBUTION_CHANNELS = ['posts', 'hero', 'category', 'discovery'] as const;
export type DistributionChannel = (typeof DISTRIBUTION_CHANNELS)[number];

/**
 * The single workflow state in which an asset may be distributed at all.
 *
 * Named here, and derived from the P0.4 workflow rather than a status literal,
 * so "archived content is never public" is the same fact as "only approved
 * content is distributed" instead of a second rule that could drift.
 */
export const DISTRIBUTABLE_STATUS = 'approved' as const;

/** Why an asset cannot be live anywhere, whatever it is placed in. */
export type DistributionBlocker =
  | 'pending_review'
  | 'rejected'
  | 'archived'
  | 'not_content'
  | 'no_media'
  | 'character_inactive';

/**
 * The asset-level gate, evaluated per row. The SQL below asks the same four
 * questions in the same order; this one names WHICH it failed, so an operator
 * is told "she is not published" rather than shown a tile that never renders.
 */
export function distributionBlockerOf(row: {
  status: string;
  kind: string;
  storageKey: string | null;
  characterStatus: string;
}): DistributionBlocker | null {
  if (row.status !== DISTRIBUTABLE_STATUS) {
    const workflow = assetWorkflowOf(row.status as CharacterVisualAssetRow['status']);
    return workflow === 'pending_review'
      ? 'pending_review'
      : workflow === 'rejected'
        ? 'rejected'
        : 'archived';
  }
  if (!(PUBLIC_CONTENT_KINDS as readonly string[]).includes(row.kind)) return 'not_content';
  if (row.storageKey === null || row.storageKey === '') return 'no_media';
  if (row.characterStatus !== 'active') return 'character_inactive';
  return null;
}

/* ------------------------------------------------------------------ *
 * The gate, and each channel, in SQL
 *
 * Conditions rather than id sets so they compose into any query and cannot
 * drift from the reads that use them. Every caller of a condition naming
 * `characters` must join that table -- the join is the reminder.
 * ------------------------------------------------------------------ */

/** Approved, and nothing else. The one line that keeps archived content out. */
export function distributableWorkflowCondition() {
  return eq(characterVisualAssets.status, DISTRIBUTABLE_STATUS);
}

/** The asset-level gate MINUS her publication state (see below). */
export function distributableAssetConditions() {
  return [
    distributableWorkflowCondition(),
    inArray(characterVisualAssets.kind, [...PUBLIC_CONTENT_KINDS]),
    sql`${characterVisualAssets.storageKey} is not null and ${characterVisualAssets.storageKey} <> ''`,
  ];
}

/**
 * The full asset-level gate, including her being active.
 *
 * SPLIT FROM THE ABOVE ON PURPOSE. A character is built before she is
 * published, so merchandising her clips while she is inactive is the ordinary
 * journey: the picker offers them with a warning and the rails exclude them
 * until she is live. Assignment therefore uses the narrower list; every
 * customer-facing read uses this one.
 */
export function distributableConditions() {
  return [...distributableAssetConditions(), eq(characters.status, 'active')];
}

/** Released to her Posts tab. */
export function postsChannelCondition() {
  return sql`${characterVisualAssets.publishedAt} is not null`;
}

/** Assigned to the Home Hero. */
export function heroChannelCondition() {
  return sql`exists (select 1 from ${homeHeroClips} where ${homeHeroClips.assetId} = ${characterVisualAssets.id})`;
}

/** In a category that is enabled AND published to Home. */
export function categoryChannelCondition() {
  return sql`exists (
    select 1
    from ${appCategoryAssets}
    join ${appCategories} on ${appCategories.id} = ${appCategoryAssets.categoryId}
    where ${appCategoryAssets.assetId} = ${characterVisualAssets.id}
      and ${appCategories.enabled} = true
      and ${appCategories.homePublished} = true
  )`;
}

/**
 * Carries a keyword an ENABLED discovery category queries.
 *
 * Deliberately narrow: "has any keyword" would turn an operator's private
 * organisational vocabulary into a publication switch. Disabling the last
 * category that uses a keyword closes its content again.
 */
export function discoveryChannelCondition() {
  return sql`exists (
    select 1
    from ${assetKeywords}
    join ${discoveryCategoryKeywords}
      on ${discoveryCategoryKeywords.keywordId} = ${assetKeywords.keywordId}
    join ${discoveryCategories}
      on ${discoveryCategories.id} = ${discoveryCategoryKeywords.discoveryCategoryId}
    where ${assetKeywords.assetId} = ${characterVisualAssets.id}
      and ${discoveryCategories.enabled} = true
  )`;
}

/** A canonical portrait of her ACTIVE identity version. Identity, not a channel. */
export function canonicalGalleryCondition() {
  return and(
    eq(characterVisualAssets.isCanonical, true),
    eq(characterVisualAssets.kind, 'reference'),
    sql`exists (
      select 1 from ${characterVisualIdentities}
      where ${characterVisualIdentities.id} = ${characterVisualAssets.visualIdentityId}
        and ${characterVisualIdentities.characterId} = ${characterVisualAssets.characterId}
        and ${characterVisualIdentities.status} = 'active'
    )`,
  );
}

/**
 * IN A PLACEMENT CHANNEL -- Hero, a published category, or Discovery.
 *
 * Posts is deliberately absent. A placement is an editorial decision to put a
 * clip somewhere shared; her Posts tab is her own collection, reached only by
 * someone already looking at her. Home, Play with me, Swipe, Favourites and the
 * search grid all ask the PLACEMENT question, and adding Posts here would have
 * silently changed every one of them.
 */
export function placementChannelCondition() {
  return or(heroChannelCondition(), categoryChannelCondition(), discoveryChannelCondition());
}

/**
 * PUBLICLY REACHABLE BY ID: the union the media route serves.
 *
 * Approval alone must never make an asset fetchable -- that would expose the
 * whole approved Library to id guessing -- so a channel (or the identity
 * gallery) is always required. A published portrait and a released clip are
 * both legitimately reachable; an approved, unplaced, unreleased clip is a 404.
 */
export function publiclyReachableCondition() {
  return and(
    distributableWorkflowCondition(),
    // An ALLOW-LIST: a kind added later is excluded until admitted deliberately.
    inArray(characterVisualAssets.kind, [...PUBLICLY_REACHABLE_KINDS]),
    sql`exists (
      select 1 from ${characters}
      where ${characters.id} = ${characterVisualAssets.characterId}
        and ${characters.status} = 'active'
    )`,
    or(canonicalGalleryCondition(), placementChannelCondition()),
  );
}

/** Her Posts tab: distributable content that an operator RELEASED. */
export function characterPostsCondition() {
  return and(
    distributableWorkflowCondition(),
    postsChannelCondition(),
    inArray(characterVisualAssets.kind, [...PUBLIC_CONTENT_KINDS]),
    sql`exists (
      select 1 from ${characters}
      where ${characters.id} = ${characterVisualAssets.characterId}
        and ${characters.status} = 'active'
    )`,
  );
}

/* ------------------------------------------------------------------ *
 * The admin read model
 * ------------------------------------------------------------------ */

export interface PostsDistribution {
  /** An operator released it. It may still not be LIVE -- see `live`. */
  released: boolean;
  releasedAt: string | null;
  live: boolean;
}

export interface HeroDistribution {
  placed: boolean;
  /** Zero-based, as stored. The UI adds one. */
  position: number | null;
  live: boolean;
}

export interface CategoryDistribution {
  id: string;
  slug: string;
  name: string;
  position: number;
  live: boolean;
  /** Why this membership shows nothing, when the category itself is the reason. */
  reason: 'category_disabled' | 'category_unpublished' | null;
}

export interface DiscoveryDistribution {
  keyword: string;
  /** Enabled discovery categories that query this keyword. */
  categories: string[];
  live: boolean;
}

/**
 * Where ONE asset stands on every channel, plus the asset-level reason nothing
 * of it can be live. The Character page and Review render this and decide
 * nothing themselves.
 */
export interface AssetDistribution {
  blocker: DistributionBlocker | null;
  /** True when at least one channel is actually showing it right now. */
  liveAnywhere: boolean;
  /** True when a channel record exists, live or not. */
  placedAnywhere: boolean;
  posts: PostsDistribution;
  hero: HeroDistribution;
  categories: CategoryDistribution[];
  discovery: DiscoveryDistribution[];
}

const EMPTY_DISTRIBUTION = (blocker: DistributionBlocker | null): AssetDistribution => ({
  blocker,
  liveAnywhere: false,
  placedAnywhere: false,
  posts: { released: false, releasedAt: null, live: false },
  hero: { placed: false, position: null, live: false },
  categories: [],
  discovery: [],
});

/**
 * The distribution of many assets in three queries, keyed by asset id.
 *
 * Three rather than one because the channels are independent tables owned by
 * independent screens; joining them into a single row would multiply results
 * and force the caller to de-duplicate what it just asked for.
 */
export async function describeAssetDistribution(
  db: Db,
  assets: ReadonlyArray<
    Pick<CharacterVisualAssetRow, 'id' | 'status' | 'kind' | 'storageKey' | 'publishedAt'> & {
      characterStatus: string;
    }
  >,
): Promise<Map<string, AssetDistribution>> {
  const out = new Map<string, AssetDistribution>();
  if (assets.length === 0) return out;
  const ids = assets.map((a) => a.id);

  const [categoryRows, heroRows, keywordRows] = await Promise.all([
    db
      .select({
        assetId: appCategoryAssets.assetId,
        position: appCategoryAssets.position,
        id: appCategories.id,
        slug: appCategories.slug,
        name: appCategories.name,
        enabled: appCategories.enabled,
        homePublished: appCategories.homePublished,
      })
      .from(appCategoryAssets)
      .innerJoin(appCategories, eq(appCategories.id, appCategoryAssets.categoryId))
      .where(inArray(appCategoryAssets.assetId, ids)),
    db
      .select({ assetId: homeHeroClips.assetId, position: homeHeroClips.position })
      .from(homeHeroClips)
      .where(inArray(homeHeroClips.assetId, ids)),
    /**
     * Keywords with the ENABLED discovery categories that query them. A left
     * join, so a keyword no category queries is still reported -- it is a tag
     * the operator applied, and saying "not in Discovery" is the answer they
     * need rather than silence.
     */
    db
      .select({
        assetId: assetKeywords.assetId,
        keyword: contentKeywords.key,
        categoryName: discoveryCategories.name,
        categoryEnabled: discoveryCategories.enabled,
      })
      .from(assetKeywords)
      .innerJoin(contentKeywords, eq(contentKeywords.id, assetKeywords.keywordId))
      .leftJoin(
        discoveryCategoryKeywords,
        eq(discoveryCategoryKeywords.keywordId, assetKeywords.keywordId),
      )
      .leftJoin(
        discoveryCategories,
        eq(discoveryCategories.id, discoveryCategoryKeywords.discoveryCategoryId),
      )
      .where(inArray(assetKeywords.assetId, ids)),
  ]);

  const categoriesByAsset = new Map<string, CategoryDistribution[]>();
  for (const row of categoryRows) {
    const list = categoriesByAsset.get(row.assetId) ?? [];
    list.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      position: row.position,
      live: false, // decided below, once the asset-level gate is known
      reason: !row.enabled ? 'category_disabled' : !row.homePublished ? 'category_unpublished' : null,
    });
    categoriesByAsset.set(row.assetId, list);
  }

  const heroByAsset = new Map(heroRows.map((row) => [row.assetId, row.position]));

  const discoveryByAsset = new Map<string, Map<string, Set<string>>>();
  for (const row of keywordRows) {
    const byKeyword = discoveryByAsset.get(row.assetId) ?? new Map<string, Set<string>>();
    const categories = byKeyword.get(row.keyword) ?? new Set<string>();
    if (row.categoryName && row.categoryEnabled) categories.add(row.categoryName);
    byKeyword.set(row.keyword, categories);
    discoveryByAsset.set(row.assetId, byKeyword);
  }

  for (const asset of assets) {
    const blocker = distributionBlockerOf({
      status: asset.status,
      kind: asset.kind,
      storageKey: asset.storageKey,
      characterStatus: asset.characterStatus,
    });
    const distributable = blocker === null;

    const categories = (categoriesByAsset.get(asset.id) ?? [])
      .map((category) => ({ ...category, live: distributable && category.reason === null }))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    const discovery = [...(discoveryByAsset.get(asset.id) ?? new Map<string, Set<string>>())]
      .map(([keyword, categoryNames]) => ({
        keyword,
        categories: [...categoryNames].sort(),
        live: distributable && categoryNames.size > 0,
      }))
      .sort((a, b) => a.keyword.localeCompare(b.keyword));

    const heroPosition = heroByAsset.get(asset.id) ?? null;
    const hero: HeroDistribution = {
      placed: heroPosition !== null,
      position: heroPosition,
      live: distributable && heroPosition !== null,
    };
    const posts: PostsDistribution = {
      released: asset.publishedAt !== null,
      releasedAt: asset.publishedAt ? asset.publishedAt.toISOString() : null,
      live: distributable && asset.publishedAt !== null,
    };

    const distribution: AssetDistribution = {
      ...EMPTY_DISTRIBUTION(blocker),
      posts,
      hero,
      categories,
      discovery,
      placedAnywhere:
        posts.released || hero.placed || categories.length > 0 || discovery.length > 0,
      liveAnywhere:
        posts.live || hero.live || categories.some((c) => c.live) || discovery.some((d) => d.live),
    };
    out.set(asset.id, distribution);
  }

  return out;
}

/** One asset's distribution, for the routes that hold a single row. */
export async function describeOneAssetDistribution(
  db: Db,
  asset: Parameters<typeof describeAssetDistribution>[1][number],
): Promise<AssetDistribution> {
  const map = await describeAssetDistribution(db, [asset]);
  return map.get(asset.id) ?? EMPTY_DISTRIBUTION(null);
}
