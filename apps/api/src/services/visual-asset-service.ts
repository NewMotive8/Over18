import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  appCategoryAssets,
  assetKeywords,
  characterVisualAssets,
  characterVisualIdentities,
  homeHeroClips,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { checkTransition, type AssetAction } from './asset-lifecycle.js';

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

/**
 * Mirrors the `visual_asset_kind` enum. `chat` is Chat Content — media a
 * character may send in a private conversation and which no public surface
 * will serve. See `services/asset-kinds.ts` for which surfaces admit which.
 */
export type VisualAssetKind = 'reference' | 'generated' | 'chat';
export type VisualAssetOrigin = 'generated' | 'manual' | 'imported' | 'legacy';
export type VisualAssetStatus = 'generated' | 'under_review' | 'approved' | 'rejected' | 'archived';
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
  /**
   * Where the asset came from (P0.3). Every application writer states it. When
   * omitted it is recorded as `legacy` -- "not stated" -- never guessed from
   * `kind`, `status` or provenance.
   */
  origin?: VisualAssetOrigin;
  /** Optional explicit initial status; defaults by kind (see below). */
  status?: VisualAssetStatus;
  provenance?: Record<string, unknown>;
  contentRating?: ContentRating;
  position?: number | null;
  storageKey?: string | null;
  /**
   * Optional join point to a content requirement (see schema.ts). Never
   * defaulted here: an asset no caller labelled stays unlabelled, so no
   * requirement vocabulary is baked into this service.
   */
  requirementKey?: string | null;
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
      origin: input.origin ?? 'legacy',
      status,
      isCanonical: false, // never canonical on creation
      position: input.position ?? null,
      storageKey: input.storageKey ?? null,
      provenance: input.provenance ?? {},
      contentRating: input.contentRating ?? 'sfw',
      requirementKey: input.requirementKey ?? null,
    })
    .returning();

  return row!;
}

/**
 * Runs one lifecycle transition: locks the row, asks `asset-lifecycle` whether
 * the action is allowed from the state it is ACTUALLY in, and only then writes.
 * A refusal throws `VisualAssetTransitionError` with the rule's own reason; an
 * action that would change nothing returns the row untouched.
 *
 * The lock matters because two operators can act on one tile at once -- an
 * archive racing an approve must see the other's result, not a stale read.
 */
async function transition(
  db: Db,
  assetId: string,
  action: AssetAction,
  write: (asset: CharacterVisualAssetRow) => Partial<typeof characterVisualAssets.$inferInsert>,
  /** Further writes that must land in the SAME transaction as the status. */
  also?: (tx: Parameters<Parameters<Db['transaction']>[0]>[0], assetId: string) => Promise<void>,
): Promise<CharacterVisualAssetRow> {
  return db.transaction(async (tx) => {
    const [asset] = await tx
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, assetId))
      .limit(1)
      .for('update');
    if (!asset) throw new VisualAssetNotFoundError();

    const check = checkTransition(asset, action);
    if (!check.allowed) throw new VisualAssetTransitionError(check.reason);
    if (check.noop) return asset;

    const [updated] = await tx
      .update(characterVisualAssets)
      .set({ ...write(asset), updatedAt: new Date() })
      .where(eq(characterVisualAssets.id, assetId))
      .returning();
    if (also) await also(tx, assetId);
    return updated!;
  });
}

/**
 * Approves an asset. This is the ONLY path to canonical status: approving a
 * `reference` asset promotes it to canonical (is_canonical = true) and records
 * the approver; approving a `generated` asset marks it approved but NEVER
 * canonical. Cannot approve a rejected or archived asset. Idempotent when
 * already approved.
 */
export async function approveVisualAsset(
  db: Db,
  assetId: string,
  approvedBy?: string,
): Promise<CharacterVisualAssetRow> {
  // Approval exposes nothing: `published_at` is never written here.
  return transition(db, assetId, 'approve', (asset) => ({
    status: 'approved',
    // Canonical promotion happens here, and ONLY for references.
    isCanonical: asset.kind === 'reference',
    approvedBy: approvedBy ?? null,
    approvedAt: new Date(),
  }));
}

/**
 * Rejects an asset. A rejected asset can never be canonical. Rejection is not
 * deletion: the row, its file and its provenance all remain.
 */
export async function rejectVisualAsset(
  db: Db,
  assetId: string,
): Promise<CharacterVisualAssetRow> {
  return transition(db, assetId, 'reject', () => ({
    status: 'rejected',
    isCanonical: false,
    // Leaving the archived state (if it was in it) clears the archive record,
    // which the table's check requires.
    archivedAt: null,
    archivedBy: null,
  }));
}

/**
 * ARCHIVES an approved (or approved and released) asset: it leaves every
 * surface, and nothing about it is lost.
 *
 * Only `status`, `archived_at` and `archived_by` are written. Approval
 * (`approved_at`/`approved_by`), release (`published_at`), `is_canonical`,
 * provenance, origin, identity version, the file on disk and every placement
 * row (Hero, categories, keywords) are left exactly as they were -- which is
 * what makes unarchiving a restoration rather than a rebuild.
 *
 * It is hidden because every public reader requires `status = 'approved'`, not
 * because anything was taken down. References are refused: the primary set is
 * managed from Visual identity.
 */
export async function archiveVisualAsset(
  db: Db,
  assetId: string,
  archivedBy?: string,
): Promise<CharacterVisualAssetRow> {
  return transition(db, assetId, 'archive', () => ({
    status: 'archived',
    archivedAt: new Date(),
    archivedBy: archivedBy ?? null,
  }));
}

/**
 * UNARCHIVES an asset back to APPROVED -- and no further.
 *
 * IT DOES NOT PUT ANYTHING BACK IN FRONT OF CUSTOMERS. Restoring the release
 * and placements an asset had before it was archived would make one click
 * re-publish content to her Posts tab, the Home Hero, a published category and
 * Discovery all at once, with nobody deciding to. So unarchiving clears the
 * four records that can make an asset publicly reachable:
 *
 *   published_at          her Posts tab
 *   home_hero_clips       the Home Hero
 *   app_category_assets   a published category
 *   asset_keywords        a keyword an enabled Discovery category queries
 *
 * and the operator releases or places it again, deliberately. Everything that
 * is NOT distribution survives untouched: the file, provenance, origin,
 * identity version, requirement key, rating and the original approval.
 *
 * Restoring a previous distribution as an explicit, reviewable act belongs to
 * the P0.5 distribution model; it is deliberately not attempted here.
 */
export async function unarchiveVisualAsset(
  db: Db,
  assetId: string,
): Promise<CharacterVisualAssetRow> {
  return transition(
    db,
    assetId,
    'unarchive',
    () => ({
      status: 'approved',
      archivedAt: null,
      archivedBy: null,
      // Approved, and not released. Releasing is a separate decision, as ever.
      publishedAt: null,
    }),
    async (tx, id) => {
      await tx.delete(homeHeroClips).where(eq(homeHeroClips.assetId, id));
      await tx.delete(appCategoryAssets).where(eq(appCategoryAssets.assetId, id));
      await tx.delete(assetKeywords).where(eq(assetKeywords.assetId, id));
    },
  );
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
