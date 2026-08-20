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
 * Media type, resolved in one place. The schema has no media_type column, and
 * inventing one would be a schema change this ticket does not need.
 *
 * Provenance FIRST, extension second. A manual upload's storage_key is a route
 * path ending in `/file` with no extension, so extension sniffing classified
 * every upload as an image — an uploaded video then vanished from the video
 * filter and rendered through the <img> branch. The upload service already
 * records `provenance.mediaType` from the VALIDATED MIME type, which is
 * authoritative; it was simply never read.
 *
 * The extension fallback is unchanged, so generated assets (whose keys do end
 * in .mp4/.png) behave exactly as before, and any row without a recorded
 * mediaType keeps the old behaviour. Existing uploads already carry the
 * provenance field, so they reclassify correctly with no migration or backfill.
 */
export function mediaTypeOf(
  storageKey: string | null,
  provenance?: Record<string, unknown> | null,
): MediaType {
  const recorded = provenance?.mediaType;
  if (recorded === 'video' || recorded === 'image') return recorded;
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
    .map((r) => ({ ...r.asset, characterName: r.characterName, mediaType: mediaTypeOf(r.asset.storageKey, r.asset.provenance) }))
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
  return { ...row.asset, characterName: row.characterName, mediaType: mediaTypeOf(row.asset.storageKey, row.asset.provenance) };
}

/**
 * The ONLY metadata this ticket lets an operator change. Deliberately narrow:
 * everything else on the row is provenance or lifecycle state that review must
 * not rewrite. There is no media editor here and none is implied.
 */
export interface AssetMetadataPatch {
  contentRating?: ContentRating;
  position?: number | null;
  /**
   * Which configured requirement this item satisfies. Filing an item under a
   * category is a review decision — it is how the board gets populated by hand
   * — and `null` un-files it back to triage. The route validates the key
   * against the configured set before it reaches here.
   */
  requirementKey?: string | null;
}

export async function updateAssetMetadata(
  db: Db,
  assetId: string,
  patch: AssetMetadataPatch,
): Promise<CharacterVisualAssetRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.contentRating !== undefined) set.contentRating = patch.contentRating;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.requirementKey !== undefined) set.requirementKey = patch.requirementKey;

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
 * The ACTIVE Content Library begins at approval.
 *
 * Content awaiting review is not library content — it belongs to the US-106
 * review queue — and rejected content has left the active workflow entirely.
 * Keeping pre-approval statuses out is what stops an upstream generation term
 * like "Generated" ever surfacing as the status of a library item.
 *
 * An explicit ?status= filter still reaches other states for auditing.
 */
export const LIBRARY_STATUSES = ['approved'] as const satisfies readonly VisualAssetStatus[];

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
  // Approval is what puts an item in the library, so approvedAt is its library
  // event. The 'added' basis stays for any future non-approval addition (e.g. a
  // direct upload), which would legitimately be recent by createdAt.
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
        mediaType: mediaTypeOf(r.asset.storageKey, r.asset.provenance),
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
