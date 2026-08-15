import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { characters, characterVisualAssets, type CharacterVisualAssetRow } from '../db/schema.js';
import type { ContentRating, VisualAssetStatus } from './visual-asset-service.js';

/**
 * US-106 — read model for the content-review workflow.
 *
 * Deliberately a THIN read layer over the existing tables. It introduces no new
 * lifecycle: approve/reject remain `visual-asset-service`'s job, and the
 * statuses are EPIC 7's (`generated | under_review | approved | rejected`).
 *
 * `listVisualAssets` in visual-asset-service is scoped to one character AND one
 * identity version, which is right for identity work but too narrow for a
 * morning review queue that spans characters. These queries fill that gap
 * without touching that module.
 */

/** Statuses that still need an operator decision. */
export const PENDING_STATUSES = ['generated', 'under_review'] as const satisfies readonly VisualAssetStatus[];

export type MediaType = 'image' | 'video';

/**
 * Media type is derived from the stored file extension. The schema has no
 * media_type column, and inventing one would be a schema change this ticket
 * does not need — so the derivation is explicit and in one place.
 */
export function mediaTypeOf(storageKey: string | null): MediaType {
  return /\.(mp4|webm|mov|m4v)$/i.test(storageKey ?? '') ? 'video' : 'image';
}

export interface ReviewQueueFilter {
  characterId?: string;
  status?: VisualAssetStatus;
  mediaType?: MediaType;
  limit?: number;
}

export interface ReviewAsset extends CharacterVisualAssetRow {
  characterName: string;
  mediaType: MediaType;
}

/** Newest first — the operator wants what was just produced. */
export async function listReviewQueue(
  db: Db,
  filter: ReviewQueueFilter = {},
): Promise<ReviewAsset[]> {
  const conditions = [eq(characterVisualAssets.kind, 'generated')];
  if (filter.characterId) conditions.push(eq(characterVisualAssets.characterId, filter.characterId));
  if (filter.status) conditions.push(eq(characterVisualAssets.status, filter.status));
  else conditions.push(inArray(characterVisualAssets.status, [...PENDING_STATUSES]));

  const rows = await db
    .select({ asset: characterVisualAssets, characterName: characters.name })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(and(...conditions))
    .orderBy(desc(characterVisualAssets.createdAt))
    .limit(Math.min(filter.limit ?? 100, 200));

  return rows
    .map((r) => ({ ...r.asset, characterName: r.characterName, mediaType: mediaTypeOf(r.asset.storageKey) }))
    .filter((a) => !filter.mediaType || a.mediaType === filter.mediaType);
}

export interface CharacterReviewSummary {
  characterId: string;
  characterName: string;
  pendingCount: number;
}

/** Character-first entry: who has work waiting, and how much. */
export async function summariseReviewByCharacter(db: Db): Promise<CharacterReviewSummary[]> {
  const rows = await db
    .select({
      characterId: characterVisualAssets.characterId,
      characterName: characters.name,
      pendingCount: sql<number>`count(*)::int`,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(
      and(
        eq(characterVisualAssets.kind, 'generated'),
        inArray(characterVisualAssets.status, [...PENDING_STATUSES]),
      ),
    )
    .groupBy(characterVisualAssets.characterId, characters.name)
    .orderBy(desc(sql`count(*)`));
  return rows;
}

export async function getReviewAsset(db: Db, assetId: string): Promise<ReviewAsset | null> {
  const [row] = await db
    .select({ asset: characterVisualAssets, characterName: characters.name })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(eq(characterVisualAssets.id, assetId));
  if (!row) return null;
  return { ...row.asset, characterName: row.characterName, mediaType: mediaTypeOf(row.asset.storageKey) };
}

/**
 * The ONLY metadata this ticket lets an operator change. Deliberately narrow:
 * everything else on the row is provenance or lifecycle state that review must
 * not rewrite. There is no media editor here and none is implied.
 */
export interface AssetMetadataPatch {
  contentRating?: ContentRating;
  position?: number | null;
}

export async function updateAssetMetadata(
  db: Db,
  assetId: string,
  patch: AssetMetadataPatch,
): Promise<CharacterVisualAssetRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.contentRating !== undefined) set.contentRating = patch.contentRating;
  if (patch.position !== undefined) set.position = patch.position;

  const [updated] = await db
    .update(characterVisualAssets)
    .set(set)
    .where(eq(characterVisualAssets.id, assetId))
    .returning();
  return updated ?? null;
}

/* ------------------------------------------------------------------ *
 * US-100 — Content Library
 * ------------------------------------------------------------------ */

/**
 * Content that has passed review and lives in the library. Rejected content is
 * excluded by default because the EPIC 7 lifecycle treats it as removed from
 * the active workflow — the same rule US-106's queue relies on.
 */
export const LIBRARY_STATUSES = ['generated', 'under_review', 'approved'] as const satisfies readonly VisualAssetStatus[];

export interface LibraryFilter {
  characterId?: string;
  status?: VisualAssetStatus;
  mediaType?: MediaType;
  /** Free-text match on character name — the only search the model supports cheaply. */
  search?: string;
  limit?: number;
}

/**
 * Why an item is "recent", so the UI can say "Approved 2h ago" rather than
 * conflating it with when the file was produced. approvedAt and createdAt are
 * genuinely different events and the ticket asks for both.
 */
export type RecencyBasis = 'approved' | 'added';

export interface LibraryAsset extends ReviewAsset {
  recencyBasis: RecencyBasis;
  /** The timestamp the recency ordering actually used. */
  recentAt: Date;
}

function toLibraryAsset(asset: ReviewAsset): LibraryAsset {
  // An approved asset is "recently approved"; anything else is "recently added".
  const approved = asset.status === 'approved' && asset.approvedAt !== null;
  return {
    ...asset,
    recencyBasis: approved ? 'approved' : 'added',
    recentAt: approved ? asset.approvedAt! : asset.createdAt,
  };
}

/** Deterministic ordering: newest recency event first, id as a stable tiebreak. */
export function orderByRecency(assets: readonly LibraryAsset[]): LibraryAsset[] {
  return [...assets].sort((a, b) => {
    const diff = b.recentAt.getTime() - a.recentAt.getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

async function selectLibrary(db: Db, filter: LibraryFilter): Promise<LibraryAsset[]> {
  const conditions = [eq(characterVisualAssets.kind, 'generated')];
  if (filter.characterId) conditions.push(eq(characterVisualAssets.characterId, filter.characterId));
  if (filter.status) {
    // An explicit status filter is honoured even for rejected, so an operator
    // can still audit it — it simply never appears by default.
    conditions.push(eq(characterVisualAssets.status, filter.status));
  } else {
    conditions.push(inArray(characterVisualAssets.status, [...LIBRARY_STATUSES]));
  }

  const rows = await db
    .select({ asset: characterVisualAssets, characterName: characters.name })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(and(...conditions))
    .limit(Math.min(filter.limit ?? 200, 500));

  const search = filter.search?.trim().toLowerCase();
  return rows
    .map((r) =>
      toLibraryAsset({
        ...r.asset,
        characterName: r.characterName,
        mediaType: mediaTypeOf(r.asset.storageKey),
      }),
    )
    .filter((a) => !filter.mediaType || a.mediaType === filter.mediaType)
    .filter((a) => !search || a.characterName.toLowerCase().includes(search));
}

/** The full library, newest recency event first. */
export async function listLibrary(db: Db, filter: LibraryFilter = {}): Promise<LibraryAsset[]> {
  return orderByRecency(await selectLibrary(db, filter));
}

/**
 * What changed lately — the first thing the operator sees on entering the
 * library, so newly approved content never has to be searched for.
 */
export async function listRecentLibrary(db: Db, limit = 12): Promise<LibraryAsset[]> {
  return orderByRecency(await selectLibrary(db, {})).slice(0, limit);
}
