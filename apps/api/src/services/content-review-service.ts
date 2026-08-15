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
