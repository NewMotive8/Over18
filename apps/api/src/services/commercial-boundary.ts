import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  characters,
  characterVisualAssets,
  contentOffers,
  type CharacterVisualAssetRow,
  type ContentOfferRow,
} from '../db/schema.js';
import { assetRoleOf } from './asset-lifecycle.js';
import { mediaTypeOf } from './content-review-service.js';

/**
 * THE COMMERCIAL BOUNDARY (P0.8) -- where content will meet the economy, and
 * the contract that keeps them apart until then.
 *
 * ── THE SHAPE ────────────────────────────────────────────────────────────────
 *
 *   Asset -> OFFER -> [future] Entitlement -> user access
 *
 * An OFFER is the join point: it says what commercial condition applies to one
 * piece of content, and it carries the durable identity a future entitlement
 * will point at. Everything commercial hangs off the offer; nothing commercial
 * is written onto the asset.
 *
 * ── FOUR AXES, STILL SEPARATE ────────────────────────────────────────────────
 *
 *   role          what it is                (P0.3, `kind`)
 *   workflow      whether it passed review  (P0.4, `status`)
 *   distribution  where customers meet it   (P0.5, Posts/Hero/Category/Discovery)
 *   commercial    what it costs to access   (HERE, and only here)
 *
 * A locked clip is still approved, still released, still on Home. Locking is a
 * condition on ACCESS, not a way of hiding something -- which is precisely why
 * it must not be expressed as an unapproval or a withdrawal. Equally, archiving
 * a clip does not refund anybody: it leaves the offer alone.
 *
 * ── NOTHING IS ON ────────────────────────────────────────────────────────────
 *
 * The economy is dark (`ECONOMY_ENABLED`, off by default). No public route, no
 * admin screen and no read model consults an offer, and `assertCommercialWrite`
 * refuses to write one while the flag is off. Every asset without an offer is
 * `free`, which is the entire library today, so this phase changes nothing an
 * operator or a customer can see.
 *
 * ── WHAT P2 / P3 / P8 ATTACH HERE ────────────────────────────────────────────
 *
 * A future `entitlements` table references `content_offers.id` -- never an
 * asset id, never a character id. That is what lets a purchase outlive the
 * content: deleting an asset (or a character, permanently, under P9.4) sets the
 * offer's links to NULL and leaves the row, its state and its snapshot intact,
 * so "what did this customer buy, and may they still download it?" stays
 * answerable when the media is gone.
 *
 * Prices live in economy configuration (P1.1) and are resolved at an instant
 * (P1.2). An offer names the configuration through `economyRef` and never keeps
 * a copy, so changing a price is a configuration decision, not an edit to every
 * asset that used it.
 */

/** Mirrors the `commercial_state` enum. */
export type ContentCommercialState = ContentOfferRow['state'];

/**
 * Content nobody has priced is FREE. There is no backfill and no migration of
 * existing content: absence of an offer is the answer, not missing data.
 */
export const DEFAULT_COMMERCIAL_STATE: ContentCommercialState = 'free';

/** Thrown when a write would break the boundary's rules. */
export class CommercialBoundaryError extends Error {
  constructor(
    public readonly kind:
      | 'economy_disabled'
      | 'asset_not_found'
      | 'not_content'
      | 'invalid_state',
    message: string,
  ) {
    super(message);
    this.name = 'CommercialBoundaryError';
  }
}

/** One asset's commercial standing, as any future reader will ask for it. */
export interface AssetCommercialView {
  /** The live offer's id -- what an entitlement would reference. Null when free by default. */
  offerId: string | null;
  state: ContentCommercialState;
  /** True when this is merely the default, with no offer written. */
  implicit: boolean;
  /** Economy configuration reference, when the offer names one. */
  economyRef: Record<string, unknown> | null;
}

const IMPLICIT_FREE: AssetCommercialView = {
  offerId: null,
  state: DEFAULT_COMMERCIAL_STATE,
  implicit: true,
  economyRef: null,
};

/**
 * THE FLAG GATE. Commercial state may not be written while the economy is off,
 * so nothing can quietly accumulate in production before the phase that owns it
 * is deliberately switched on.
 */
export function assertCommercialWrite(commerce: { enabled: boolean }): void {
  if (!commerce.enabled) {
    throw new CommercialBoundaryError(
      'economy_disabled',
      'the economy is off (ECONOMY_ENABLED); commercial state cannot be written yet',
    );
  }
}

/** The live (non-retired) offers for these assets, keyed by asset id. */
export async function describeAssetCommercial(
  db: Db,
  assetIds: readonly string[],
): Promise<Map<string, AssetCommercialView>> {
  const out = new Map<string, AssetCommercialView>();
  for (const id of assetIds) out.set(id, IMPLICIT_FREE);
  if (assetIds.length === 0) return out;

  const rows = await db
    .select()
    .from(contentOffers)
    .where(and(inArray(contentOffers.assetId, [...assetIds]), isNull(contentOffers.retiredAt)));

  for (const row of rows) {
    if (!row.assetId) continue;
    out.set(row.assetId, {
      offerId: row.id,
      state: row.state,
      implicit: false,
      economyRef: row.economyRef ?? null,
    });
  }
  return out;
}

export async function getAssetCommercial(db: Db, assetId: string): Promise<AssetCommercialView> {
  return (await describeAssetCommercial(db, [assetId])).get(assetId) ?? IMPLICIT_FREE;
}

/**
 * What was offered, as it was when the offer was written.
 *
 * Deliberately descriptive and deliberately denormalised: it is read after the
 * content may no longer exist, so it copies the few facts a customer's purchase
 * history needs and nothing that would go stale in a misleading way.
 */
function snapshotOf(asset: CharacterVisualAssetRow, characterName: string): Record<string, unknown> {
  return {
    characterName,
    assetKind: asset.kind,
    role: assetRoleOf(asset.kind),
    mediaType: mediaTypeOf(asset.storageKey, asset.provenance),
    contentRating: asset.contentRating,
    capturedAt: new Date().toISOString(),
  };
}

export interface SetContentOfferInput {
  assetId: string;
  state: Exclude<ContentCommercialState, 'retired'>;
  /** Economy configuration this offer resolves against (codes only). */
  economyRef?: Record<string, unknown> | null;
}

/**
 * Write the live commercial state of one piece of content.
 *
 * ONLY CONTENT. An identity reference is not merchandise and chat media is
 * private, so neither may carry an offer -- the same role boundary every other
 * axis respects (`asset-kinds.ts`).
 *
 * The asset row is never touched: no column on `character_visual_assets`
 * changes, so moderation, release and placement are exactly as they were.
 */
export async function setContentOffer(
  db: Db,
  commerce: { enabled: boolean },
  input: SetContentOfferInput,
): Promise<ContentOfferRow> {
  assertCommercialWrite(commerce);

  const [row] = await db
    .select({ asset: characterVisualAssets, characterName: characters.name })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(eq(characterVisualAssets.id, input.assetId))
    .limit(1);
  if (!row) {
    throw new CommercialBoundaryError('asset_not_found', 'no such asset to offer');
  }
  if (assetRoleOf(row.asset.kind) !== 'content') {
    throw new CommercialBoundaryError(
      'not_content',
      'only character content can carry a commercial offer; references are identity and chat media is private',
    );
  }

  const snapshot = snapshotOf(row.asset, row.characterName);
  const existing = await liveOfferFor(db, input.assetId);
  if (existing) {
    const [updated] = await db
      .update(contentOffers)
      .set({
        state: input.state,
        economyRef: input.economyRef ?? null,
        snapshot,
        updatedAt: new Date(),
      })
      .where(eq(contentOffers.id, existing.id))
      .returning();
    return updated!;
  }

  const [created] = await db
    .insert(contentOffers)
    .values({
      assetId: input.assetId,
      characterId: row.asset.characterId,
      state: input.state,
      economyRef: input.economyRef ?? null,
      snapshot,
    })
    .returning();
  return created!;
}

/**
 * Stop offering this content. The row stays: entitlements already granted
 * against it remain valid, and a retired offer is how that history is kept.
 * A new offer for the same asset may then be written.
 */
export async function retireContentOffer(
  db: Db,
  commerce: { enabled: boolean },
  offerId: string,
): Promise<ContentOfferRow | null> {
  assertCommercialWrite(commerce);
  const [updated] = await db
    .update(contentOffers)
    .set({ state: 'retired', retiredAt: new Date(), updatedAt: new Date() })
    .where(and(eq(contentOffers.id, offerId), isNull(contentOffers.retiredAt)))
    .returning();
  return updated ?? null;
}

export async function liveOfferFor(db: Db, assetId: string): Promise<ContentOfferRow | null> {
  const [row] = await db
    .select()
    .from(contentOffers)
    .where(and(eq(contentOffers.assetId, assetId), isNull(contentOffers.retiredAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Every offer ever written for one character, live or retired, including those
 * whose content has since been deleted.
 *
 * This is the shape P9.4's retention rules and a future purchase history read:
 * the offer, its state and its snapshot, with `assetId` null once the media is
 * gone.
 */
export async function listOffersForCharacter(
  db: Db,
  characterId: string,
): Promise<ContentOfferRow[]> {
  return db.select().from(contentOffers).where(eq(contentOffers.characterId, characterId));
}
