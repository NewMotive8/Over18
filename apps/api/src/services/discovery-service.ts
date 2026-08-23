import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  assetKeywords,
  characters,
  characterVisualAssets,
  contentKeywords,
  discoveryCategories,
  discoveryCategoryKeywords,
} from '../db/schema.js';
import { PUBLISHABLE_STATUS, assetPreviewUrl } from './app-merchandising-service.js';
import { mediaTypeOf } from './content-review-service.js';
import { publicAssetUrl, publiclyReachableCondition } from './public-media-service.js';

/**
 * Keyword-driven Discovery (US-102.4).
 *
 * A DIFFERENT SYSTEM FROM APP CATEGORIES, deliberately sharing nothing.
 *
 *   App Categories (US-102.1/.2) are editorial collections. An operator picks
 *   individual assets, arranges them by hand, and publishes the collection to
 *   Home. Membership is a list someone wrote.
 *
 *   Discovery categories are QUERIES. A category is a named set of keywords and
 *   its membership is every approved asset carrying at least one of them —
 *   "Sexy = sexy OR lingerie OR seductive". Membership is derived per read.
 *
 * They share no table, no route and no ordering. Renaming, reordering or
 * deleting on either side cannot affect the other, and neither can affect the
 * content itself.
 *
 * OR, NOT AND. One matching keyword is enough. That is the product rule, and it
 * is why membership is an `inArray` over the category's keyword ids rather than
 * a count-matching join.
 *
 * DELETING A DISCOVERY CATEGORY CANNOT REACH CONTENT. The cascade runs from the
 * category to its keyword links and stops. Keywords survive, every
 * asset_keywords row survives, no asset is touched — enforced by the foreign
 * keys, not by remembering to be careful here.
 *
 * SEARCH IS NOT A CATEGORY. `listDiscoveryClips` takes an optional category and
 * an optional query and applies them as two independent filters. Selecting a
 * category never clears a search and searching never clears a category, which
 * is what "Categories and Search remain separate concepts" means in code.
 */

export class DiscoveryValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'DiscoveryValidationError';
  }
}

export class DiscoverySlugTakenError extends Error {
  constructor(public readonly slug: string) {
    super(`A discovery category with the slug "${slug}" already exists.`);
    this.name = 'DiscoverySlugTakenError';
  }
}

export class DiscoveryOrderError extends Error {
  constructor(
    public readonly reason: 'unknown_id' | 'incomplete' | 'duplicate',
    message: string,
  ) {
    super(message);
    this.name = 'DiscoveryOrderError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 60;
const KEYWORD_MAX = 60;
export const DISCOVERY_CLIPS_MAX_LIMIT = 60;

function assertUuid(value: string, field: string, noun: string): string {
  if (!UUID_RE.test(value)) {
    throw new DiscoveryValidationError(field, `That is not a valid ${noun}.`);
  }
  return value;
}

/**
 * The normalised form of a keyword — its stable identity.
 *
 * "Lingerie", "lingerie" and " LINGERIE " are one keyword, because an operator
 * typing a term twice with different capitalisation must not create two terms
 * that then behave differently. Same discipline as slugFromName in US-102.1.
 */
export function keywordKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function discoverySlugFromName(raw: string): string {
  return keywordKey(raw);
}

/* ------------------------------------------------------------------ *
 * Keywords
 * ------------------------------------------------------------------ */

export interface KeywordView {
  id: string;
  key: string;
  label: string;
  /** How many assets carry it — an operator needs to see an unused term. */
  assetCount: number;
}

export async function listKeywords(db: Db): Promise<KeywordView[]> {
  const rows = await db
    .select({
      id: contentKeywords.id,
      key: contentKeywords.key,
      label: contentKeywords.label,
      assetCount: sql<number>`(
        select count(*)::int from ${assetKeywords}
        where ${assetKeywords.keywordId} = ${contentKeywords.id}
      )`,
    })
    .from(contentKeywords)
    .orderBy(asc(contentKeywords.key));
  return rows.map((row) => ({ ...row, assetCount: Number(row.assetCount) }));
}

/**
 * Finds or creates a keyword by its normalised key.
 *
 * Idempotent on purpose: tagging content and defining a category both need "the
 * keyword for this word", and neither should care whether it already existed.
 */
export async function ensureKeyword(db: Db, raw: string): Promise<KeywordView> {
  const label = raw.trim().slice(0, KEYWORD_MAX);
  const key = keywordKey(label);
  if (key.length === 0) {
    throw new DiscoveryValidationError('keyword', 'A keyword needs at least one letter or number.');
  }
  const [existing] = await db
    .select()
    .from(contentKeywords)
    .where(eq(contentKeywords.key, key))
    .limit(1);
  if (existing) {
    return { id: existing.id, key: existing.key, label: existing.label, assetCount: 0 };
  }
  // onConflictDoNothing rather than a bare insert: two operators tagging with
  // the same new keyword at once would otherwise race the unique index and the
  // loser would get a 500 naming the constraint. On conflict the insert returns
  // nothing and the row is re-read — the other writer's row is the right answer.
  const [created] = await db
    .insert(contentKeywords)
    .values({ key, label })
    .onConflictDoNothing()
    .returning();
  if (created) {
    return { id: created.id, key: created.key, label: created.label, assetCount: 0 };
  }
  const [raced] = await db
    .select()
    .from(contentKeywords)
    .where(eq(contentKeywords.key, key))
    .limit(1);
  if (!raced) {
    throw new DiscoveryValidationError('keyword', 'That keyword could not be saved. Try again.');
  }
  return { id: raced.id, key: raced.key, label: raced.label, assetCount: 0 };
}

/** The keywords carried by one asset. */
export async function listAssetKeywords(db: Db, assetId: string): Promise<KeywordView[]> {
  assertUuid(assetId, 'assetId', 'asset id');
  const rows = await db
    .select({ id: contentKeywords.id, key: contentKeywords.key, label: contentKeywords.label })
    .from(assetKeywords)
    .innerJoin(contentKeywords, eq(contentKeywords.id, assetKeywords.keywordId))
    .where(eq(assetKeywords.assetId, assetId))
    .orderBy(asc(contentKeywords.key));
  return rows.map((row) => ({ ...row, assetCount: 0 }));
}

/**
 * Replaces an asset's keywords with exactly this set.
 *
 * Writes only `asset_keywords`. The asset's status, bytes, provenance, rating
 * and review history are never read for a decision here and never written —
 * tagging cannot approve, reject, retire or regenerate anything.
 *
 * IT IS NOT INERT, THOUGH. A keyword that an enabled discovery category queries
 * makes the clip reachable from the strip, and therefore publicly fetchable —
 * that is what a discovery category IS. So tagging is a distribution decision,
 * not a private label, and the admin screen says so.
 */
export async function setAssetKeywords(
  db: Db,
  assetId: string,
  rawKeywords: string[],
): Promise<KeywordView[]> {
  assertUuid(assetId, 'assetId', 'asset id');
  const [asset] = await db
    .select({ id: characterVisualAssets.id })
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.id, assetId))
    .limit(1);
  if (!asset) {
    throw new DiscoveryValidationError('assetId', 'That content no longer exists.');
  }

  const keywords: KeywordView[] = [];
  for (const raw of rawKeywords) {
    if (keywordKey(raw).length === 0) continue;
    keywords.push(await ensureKeyword(db, raw));
  }
  const wanted = Array.from(new Set(keywords.map((k) => k.id)));

  await db.transaction(async (tx) => {
    await tx.delete(assetKeywords).where(eq(assetKeywords.assetId, assetId));
    if (wanted.length > 0) {
      await tx
        .insert(assetKeywords)
        .values(wanted.map((keywordId) => ({ assetId, keywordId })))
        .onConflictDoNothing();
    }
  });
  return listAssetKeywords(db, assetId);
}

/* ------------------------------------------------------------------ *
 * Discovery categories
 * ------------------------------------------------------------------ */

export interface DiscoveryCategoryView {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  position: number;
  keywords: KeywordView[];
  /** How many approved assets currently match. Derived, never stored. */
  matchCount: number;
}

async function keywordsByCategory(db: Db, categoryIds: string[]) {
  const map = new Map<string, KeywordView[]>();
  if (categoryIds.length === 0) return map;
  const rows = await db
    .select({
      categoryId: discoveryCategoryKeywords.discoveryCategoryId,
      id: contentKeywords.id,
      key: contentKeywords.key,
      label: contentKeywords.label,
    })
    .from(discoveryCategoryKeywords)
    .innerJoin(contentKeywords, eq(contentKeywords.id, discoveryCategoryKeywords.keywordId))
    .where(inArray(discoveryCategoryKeywords.discoveryCategoryId, categoryIds))
    .orderBy(asc(contentKeywords.key));
  for (const row of rows) {
    const list = map.get(row.categoryId) ?? [];
    list.push({ id: row.id, key: row.key, label: row.label, assetCount: 0 });
    map.set(row.categoryId, list);
  }
  return map;
}

/** How many approved assets each category matches (OR over its keywords). */
async function matchCounts(db: Db, categoryIds: string[]) {
  const counts = new Map<string, number>();
  if (categoryIds.length === 0) return counts;
  const rows = await db
    .select({
      categoryId: discoveryCategoryKeywords.discoveryCategoryId,
      // DISTINCT: an asset carrying two of the category's keywords is one item.
      count: sql<number>`count(distinct ${assetKeywords.assetId})::int`,
    })
    .from(discoveryCategoryKeywords)
    .innerJoin(assetKeywords, eq(assetKeywords.keywordId, discoveryCategoryKeywords.keywordId))
    .innerJoin(
      characterVisualAssets,
      eq(characterVisualAssets.id, assetKeywords.assetId),
    )
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(
      and(
        inArray(discoveryCategoryKeywords.discoveryCategoryId, categoryIds),
        // Counted exactly as listDiscoveryClips filters, so the number an
        // operator sees is the number the app returns.
        eq(characterVisualAssets.status, PUBLISHABLE_STATUS),
        eq(characters.status, 'active'),
      ),
    )
    .groupBy(discoveryCategoryKeywords.discoveryCategoryId);
  for (const row of rows) counts.set(row.categoryId, Number(row.count));
  return counts;
}

export async function listDiscoveryCategories(
  db: Db,
  options: { enabledOnly?: boolean } = {},
): Promise<DiscoveryCategoryView[]> {
  const rows = await db
    .select()
    .from(discoveryCategories)
    .where(options.enabledOnly ? eq(discoveryCategories.enabled, true) : undefined)
    .orderBy(asc(discoveryCategories.position), asc(discoveryCategories.id));

  const ids = rows.map((row) => row.id);
  const [keywords, counts] = await Promise.all([
    keywordsByCategory(db, ids),
    matchCounts(db, ids),
  ]);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    keywords: keywords.get(row.id) ?? [],
    matchCount: counts.get(row.id) ?? 0,
  }));
}

export interface DiscoveryCategoryInput {
  name: string;
  slug?: string;
  keywords?: string[];
  enabled?: boolean;
}

export async function createDiscoveryCategory(
  db: Db,
  input: DiscoveryCategoryInput,
): Promise<DiscoveryCategoryView> {
  const name = (input.name ?? '').trim().slice(0, NAME_MAX);
  if (name.length === 0) {
    throw new DiscoveryValidationError('name', 'A discovery category needs a name.');
  }
  const slug = discoverySlugFromName(input.slug?.trim() || name);
  if (slug.length === 0) {
    throw new DiscoveryValidationError('slug', 'That name does not produce a usable slug.');
  }
  const [clash] = await db
    .select({ id: discoveryCategories.id })
    .from(discoveryCategories)
    .where(eq(discoveryCategories.slug, slug))
    .limit(1);
  if (clash) throw new DiscoverySlugTakenError(slug);

  const [{ next } = { next: 0 }] = await db
    .select({ next: sql<number>`coalesce(max(${discoveryCategories.position}), -1) + 1` })
    .from(discoveryCategories);

  // Same race as ensureKeyword: the slug has a unique index, so a concurrent
  // create must surface as the ordinary 409 rather than a constraint-named 500.
  const [created] = await db
    .insert(discoveryCategories)
    .values({
      slug,
      name,
      enabled: input.enabled ?? true,
      position: Number(next),
    })
    .onConflictDoNothing()
    .returning();
  if (!created) throw new DiscoverySlugTakenError(slug);

  if (input.keywords?.length) {
    await setDiscoveryCategoryKeywords(db, created!.id, input.keywords);
  }
  const all = await listDiscoveryCategories(db);
  return all.find((c) => c.id === created!.id)!;
}

/** Renames or enables/disables. The slug is IMMUTABLE, as in US-102.1. */
export async function updateDiscoveryCategory(
  db: Db,
  id: string,
  changes: { name?: string; enabled?: boolean },
): Promise<DiscoveryCategoryView | null> {
  assertUuid(id, 'id', 'discovery category id');
  const values: Record<string, unknown> = {};
  if (changes.name !== undefined) {
    const name = changes.name.trim().slice(0, NAME_MAX);
    if (name.length === 0) {
      throw new DiscoveryValidationError('name', 'A discovery category needs a name.');
    }
    values.name = name;
  }
  if (changes.enabled !== undefined) values.enabled = changes.enabled;
  if (Object.keys(values).length > 0) {
    const [row] = await db
      .update(discoveryCategories)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(discoveryCategories.id, id))
      .returning();
    if (!row) return null;
  }
  const all = await listDiscoveryCategories(db);
  return all.find((c) => c.id === id) ?? null;
}

/**
 * Replaces a category's keyword set.
 *
 * Only `discovery_category_keywords` is rewritten. The keywords themselves are
 * created if new and otherwise reused, and no asset's tags change — removing a
 * keyword from a category does not untag a single clip.
 */
export async function setDiscoveryCategoryKeywords(
  db: Db,
  id: string,
  rawKeywords: string[],
): Promise<DiscoveryCategoryView | null> {
  assertUuid(id, 'id', 'discovery category id');
  const [category] = await db
    .select({ id: discoveryCategories.id })
    .from(discoveryCategories)
    .where(eq(discoveryCategories.id, id))
    .limit(1);
  if (!category) return null;

  const keywords: KeywordView[] = [];
  for (const raw of rawKeywords) {
    if (keywordKey(raw).length === 0) continue;
    keywords.push(await ensureKeyword(db, raw));
  }
  const wanted = Array.from(new Set(keywords.map((k) => k.id)));

  await db.transaction(async (tx) => {
    await tx
      .delete(discoveryCategoryKeywords)
      .where(eq(discoveryCategoryKeywords.discoveryCategoryId, id));
    if (wanted.length > 0) {
      await tx
        .insert(discoveryCategoryKeywords)
        .values(wanted.map((keywordId) => ({ discoveryCategoryId: id, keywordId })))
        .onConflictDoNothing();
    }
  });

  const all = await listDiscoveryCategories(db);
  return all.find((c) => c.id === id) ?? null;
}

export interface DiscoveryDeletion {
  deleted: boolean;
  /** Always 0 — stated explicitly so the guarantee is visible in the response. */
  contentRemoved: number;
  keywordsKept: number;
}

/**
 * Removes a discovery category.
 *
 * THE CONTENT AND ITS KEYWORDS SURVIVE. This deletes the category row; the
 * cascade removes its keyword LINKS and stops there. The reported counts make
 * that visible rather than asking anyone to trust it.
 */
export async function deleteDiscoveryCategory(db: Db, id: string): Promise<DiscoveryDeletion> {
  assertUuid(id, 'id', 'discovery category id');
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: discoveryCategories.id })
      .from(discoveryCategories)
      .where(eq(discoveryCategories.id, id))
      .limit(1);
    if (!existing) return { deleted: false, contentRemoved: 0, keywordsKept: 0 };

    const links = await tx
      .select({ keywordId: discoveryCategoryKeywords.keywordId })
      .from(discoveryCategoryKeywords)
      .where(eq(discoveryCategoryKeywords.discoveryCategoryId, id));

    await tx.delete(discoveryCategories).where(eq(discoveryCategories.id, id));

    const rows = await tx
      .select({ id: discoveryCategories.id })
      .from(discoveryCategories)
      .orderBy(asc(discoveryCategories.position), asc(discoveryCategories.id));
    for (const [index, row] of rows.entries()) {
      await tx.update(discoveryCategories).set({ position: index }).where(eq(discoveryCategories.id, row.id));
    }
    return { deleted: true, contentRemoved: 0, keywordsKept: links.length };
  });
}

export async function reorderDiscoveryCategories(db: Db, orderedIds: string[]): Promise<void> {
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new DiscoveryOrderError('duplicate', 'The same category was listed more than once.');
  }
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: discoveryCategories.id }).from(discoveryCategories);
    const ids = new Set(existing.map((row) => row.id));
    for (const id of orderedIds) {
      if (!ids.has(id)) {
        throw new DiscoveryOrderError('unknown_id', 'That discovery category no longer exists.');
      }
    }
    if (orderedIds.length !== ids.size) {
      throw new DiscoveryOrderError(
        'incomplete',
        'The order is out of date — it does not list every category. Reload and try again.',
      );
    }
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(discoveryCategories)
        .set({ position: index, updatedAt: new Date() })
        .where(eq(discoveryCategories.id, id));
    }
  });
}

/* ------------------------------------------------------------------ *
 * The public discovery read
 * ------------------------------------------------------------------ */

export interface PublicDiscoveryCategoryView {
  id: string;
  slug: string;
  name: string;
}

/** The strip, in order. Position 0 is the default pill — data, not a constant. */
export async function listPublicDiscoveryCategories(
  db: Db,
): Promise<PublicDiscoveryCategoryView[]> {
  const rows = await db
    .select({
      id: discoveryCategories.id,
      slug: discoveryCategories.slug,
      name: discoveryCategories.name,
    })
    .from(discoveryCategories)
    .where(eq(discoveryCategories.enabled, true))
    .orderBy(asc(discoveryCategories.position), asc(discoveryCategories.id));
  return rows;
}

export interface PublicDiscoveryClip {
  id: string;
  mediaType: 'image' | 'video';
  url: string;
  characterId: string;
  characterName: string;
}

/**
 * Clips for the discovery grid / feed.
 *
 * `categorySlug` and `query` are INDEPENDENT filters and compose: a category
 * narrows by keyword, a query narrows by character name, and using one never
 * clears the other.
 *
 * Approved-only is part of the query, not a later filter, so no code path
 * through here can return content that is not publishable.
 */
export async function listDiscoveryClips(
  db: Db,
  options: { categorySlug?: string | null; query?: string | null; limit?: number; offset?: number },
): Promise<{ clips: PublicDiscoveryClip[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 24, 1), DISCOVERY_CLIPS_MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  // ONE definition of public. Using the same predicate the media route enforces
  // is what stops this list from advertising clips whose bytes then 404.
  const conditions = [publiclyReachableCondition()];

  if (options.categorySlug) {
    const slug = discoverySlugFromName(options.categorySlug);
    const keywordRows = await db
      .select({ keywordId: discoveryCategoryKeywords.keywordId })
      .from(discoveryCategoryKeywords)
      .innerJoin(
        discoveryCategories,
        eq(discoveryCategories.id, discoveryCategoryKeywords.discoveryCategoryId),
      )
      .where(and(eq(discoveryCategories.slug, slug), eq(discoveryCategories.enabled, true)));
    const keywordIds = keywordRows.map((row) => row.keywordId);
    // A category with no keywords matches nothing — never everything. An empty
    // definition must not silently become "show the whole library".
    if (keywordIds.length === 0) return { clips: [], total: 0 };
    conditions.push(
      sql`exists (
        select 1 from ${assetKeywords}
        where ${assetKeywords.assetId} = ${characterVisualAssets.id}
          and ${assetKeywords.keywordId} in (${sql.join(
            keywordIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
      )`,
    );
  }

  const trimmed = options.query?.trim();
  if (trimmed) {
    // Escaped so an operator-supplied % or _ is a literal, not a wildcard.
    const pattern = `%${trimmed.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conditions.push(sql`${characters.displayName} ilike ${pattern}`);
  }

  const where = and(...conditions);

  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(where);

  const rows = await db
    .select({
      id: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      characterName: characters.displayName,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(where)
    .orderBy(desc(characterVisualAssets.approvedAt), asc(characterVisualAssets.id))
    .limit(limit)
    .offset(offset);

  const clips: PublicDiscoveryClip[] = [];
  for (const row of rows) {
    const url = publicAssetUrl(row.id, row.storageKey);
    if (!url) continue;
    clips.push({
      id: row.id,
      mediaType: mediaTypeOf(row.storageKey, row.provenance) === 'video' ? 'video' : 'image',
      url,
      characterId: row.characterId,
      characterName: row.characterName,
    });
  }
  return { clips, total: Number(total) };
}

/** Admin content picker for keyword tagging — approved content, newest first. */
export async function listTaggableAssets(db: Db, limit = 100) {
  const rows = await db
    .select({
      assetId: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      characterName: characters.displayName,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      status: characterVisualAssets.status,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(eq(characterVisualAssets.status, PUBLISHABLE_STATUS))
    .orderBy(desc(characterVisualAssets.approvedAt), asc(characterVisualAssets.id))
    .limit(limit);

  const ids = rows.map((row) => row.assetId);
  const tagRows = ids.length
    ? await db
        .select({
          assetId: assetKeywords.assetId,
          id: contentKeywords.id,
          key: contentKeywords.key,
          label: contentKeywords.label,
        })
        .from(assetKeywords)
        .innerJoin(contentKeywords, eq(contentKeywords.id, assetKeywords.keywordId))
        .where(inArray(assetKeywords.assetId, ids))
        .orderBy(asc(contentKeywords.key))
    : [];
  const byAsset = new Map<string, KeywordView[]>();
  for (const row of tagRows) {
    const list = byAsset.get(row.assetId) ?? [];
    list.push({ id: row.id, key: row.key, label: row.label, assetCount: 0 });
    byAsset.set(row.assetId, list);
  }

  return rows.map((row) => ({
    assetId: row.assetId,
    characterId: row.characterId,
    characterName: row.characterName,
    mediaType: (mediaTypeOf(row.storageKey, row.provenance) === 'video' ? 'video' : 'image') as
      | 'image'
      | 'video',
    previewUrl: assetPreviewUrl(row.assetId, row.storageKey),
    keywords: byAsset.get(row.assetId) ?? [],
  }));
}
