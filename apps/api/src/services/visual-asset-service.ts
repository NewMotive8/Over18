import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  characterVisualAssets,
  characterVisualIdentities,
  type CharacterVisualAssetRow,
} from '../db/schema.js';

/**
 * Visual Asset service (US-16A).
 *
 * First-class visual assets (NOT characters.profile_image). One unified table:
 * `kind` = reference | generated, `status` tracks the lifecycle, `is_canonical`
 * marks the approved canonical reference set. Canonical means, and only means:
 *   kind = 'reference' AND status = 'approved' AND is_canonical = true.
 * A generated asset NEVER auto-promotes; canonical status is reachable only
 * through the explicit approval transition (which records approved_by/at).
 *
 * `provenance` is server-side-only internal metadata and is never returned
 * through any public wire mapper (there are no visual endpoints in US-16A).
 * All reads are scoped by character and identity version — cross-character and
 * cross-version isolation is enforced here.
 */

export type VisualAssetKind = 'reference' | 'generated';
export type VisualAssetStatus = 'generated' | 'under_review' | 'approved' | 'rejected';
export type ContentRating = 'sfw' | 'explicit';

/** Thrown when an asset does not exist. */
export class VisualAssetNotFoundError extends Error {
  constructor(message = 'Visual asset not found.') {
    super(message);
    this.name = 'VisualAssetNotFoundError';
  }
}

/** Thrown when an asset would be created against a mismatched character/identity. */
export class VisualAssetScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualAssetScopeError';
  }
}

/** Thrown on an invalid lifecycle transition. */
export class VisualAssetTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualAssetTransitionError';
  }
}

export interface CreateVisualAssetInput {
  characterId: string;
  visualIdentityId: string;
  kind: VisualAssetKind;
  /** Optional explicit initial status; defaults by kind (see below). */
  status?: VisualAssetStatus;
  provenance?: Record<string, unknown>;
  contentRating?: ContentRating;
  position?: number | null;
  storageKey?: string | null;
}

/**
 * Creates a visual asset. The identity version must belong to the given
 * character (isolation guard). `is_canonical` is ALWAYS false on creation —
 * canonical status can only be reached later via explicit approval. Default
 * status: reference → under_review, generated → generated.
 */
export async function createVisualAsset(
  db: Db,
  input: CreateVisualAssetInput,
): Promise<CharacterVisualAssetRow> {
  const [identity] = await db
    .select({
      id: characterVisualIdentities.id,
      characterId: characterVisualIdentities.characterId,
    })
    .from(characterVisualIdentities)
    .where(eq(characterVisualIdentities.id, input.visualIdentityId))
    .limit(1);

  if (!identity) {
    throw new VisualAssetScopeError('visualIdentityId does not exist.');
  }
  if (identity.characterId !== input.characterId) {
    throw new VisualAssetScopeError(
      'visualIdentityId does not belong to the given character.',
    );
  }

  const status: VisualAssetStatus =
    input.status ?? (input.kind === 'reference' ? 'under_review' : 'generated');

  const [row] = await db
    .insert(characterVisualAssets)
    .values({
      characterId: input.characterId,
      visualIdentityId: input.visualIdentityId,
      kind: input.kind,
      status,
      isCanonical: false, // never canonical on creation
      position: input.position ?? null,
      storageKey: input.storageKey ?? null,
      provenance: input.provenance ?? {},
      contentRating: input.contentRating ?? 'sfw',
    })
    .returning();

  return row!;
}

/**
 * Approves an asset. This is the ONLY path to canonical status: approving a
 * `reference` asset promotes it to canonical (is_canonical = true) and records
 * the approver; approving a `generated` asset marks it approved but NEVER
 * canonical. Cannot approve a rejected asset. Idempotent when already approved.
 */
export async function approveVisualAsset(
  db: Db,
  assetId: string,
  approvedBy?: string,
): Promise<CharacterVisualAssetRow> {
  return db.transaction(async (tx) => {
    const [asset] = await tx
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, assetId))
      .limit(1);
    if (!asset) throw new VisualAssetNotFoundError();
    if (asset.status === 'rejected') {
      throw new VisualAssetTransitionError('Cannot approve a rejected asset.');
    }
    if (asset.status === 'approved') return asset;

    const [updated] = await tx
      .update(characterVisualAssets)
      .set({
        status: 'approved',
        // Canonical promotion happens here, and ONLY for references.
        isCanonical: asset.kind === 'reference',
        approvedBy: approvedBy ?? null,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(characterVisualAssets.id, assetId))
      .returning();

    return updated!;
  });
}

/** Rejects an asset. A rejected asset can never be canonical. */
export async function rejectVisualAsset(
  db: Db,
  assetId: string,
): Promise<CharacterVisualAssetRow> {
  const [updated] = await db
    .update(characterVisualAssets)
    .set({ status: 'rejected', isCanonical: false, updatedAt: new Date() })
    .where(eq(characterVisualAssets.id, assetId))
    .returning();
  if (!updated) throw new VisualAssetNotFoundError();
  return updated;
}

/** Sets the ordering position of an asset within its canonical set. */
export async function setVisualAssetPosition(
  db: Db,
  assetId: string,
  position: number | null,
): Promise<CharacterVisualAssetRow> {
  const [updated] = await db
    .update(characterVisualAssets)
    .set({ position, updatedAt: new Date() })
    .where(eq(characterVisualAssets.id, assetId))
    .returning();
  if (!updated) throw new VisualAssetNotFoundError();
  return updated;
}

/** A single asset by id, or null. */
export async function getVisualAssetById(
  db: Db,
  assetId: string,
): Promise<CharacterVisualAssetRow | null> {
  const [row] = await db
    .select()
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.id, assetId))
    .limit(1);
  return row ?? null;
}

export interface ListVisualAssetsFilter {
  kind?: VisualAssetKind;
  status?: VisualAssetStatus;
}

/**
 * Lists a character's assets for a specific identity version, oldest first.
 * Scoped by BOTH character and identity version — one character's assets never
 * surface under another character, and one version's never under another.
 */
export async function listVisualAssets(
  db: Db,
  characterId: string,
  visualIdentityId: string,
  filter: ListVisualAssetsFilter = {},
): Promise<CharacterVisualAssetRow[]> {
  const conditions = [
    eq(characterVisualAssets.characterId, characterId),
    eq(characterVisualAssets.visualIdentityId, visualIdentityId),
  ];
  if (filter.kind) conditions.push(eq(characterVisualAssets.kind, filter.kind));
  if (filter.status) conditions.push(eq(characterVisualAssets.status, filter.status));

  return db
    .select()
    .from(characterVisualAssets)
    .where(and(...conditions))
    .orderBy(asc(characterVisualAssets.createdAt), asc(characterVisualAssets.id));
}

/**
 * The canonical reference set for an identity version, in canonical order.
 * Only approved reference assets flagged canonical are returned. Ordered by
 * `position` (nulls last), then creation time.
 */
export async function listCanonicalReferences(
  db: Db,
  characterId: string,
  visualIdentityId: string,
): Promise<CharacterVisualAssetRow[]> {
  const rows = await db
    .select()
    .from(characterVisualAssets)
    .where(
      and(
        eq(characterVisualAssets.characterId, characterId),
        eq(characterVisualAssets.visualIdentityId, visualIdentityId),
        eq(characterVisualAssets.kind, 'reference'),
        eq(characterVisualAssets.status, 'approved'),
        eq(characterVisualAssets.isCanonical, true),
      ),
    );

  // Deterministic canonical order: explicit position first (asc), then the
  // unpositioned by creation time. Done in-memory to keep NULLS-LAST portable.
  return rows.sort((a, b) => {
    if (a.position !== null && b.position !== null) {
      if (a.position !== b.position) return a.position - b.position;
    } else if (a.position !== null) {
      return -1;
    } else if (b.position !== null) {
      return 1;
    }
    const at = a.createdAt.getTime();
    const bt = b.createdAt.getTime();
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
