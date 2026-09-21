import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { CONTENT_ACCESS_STATES, type ContentAccessState } from '@over18/shared';
import type { Db } from '../db/client.js';
import {
  characterClipAllocation,
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
 * ── THE ACCESS TERMS (P4.1, PRD §10, §32.1) ─────────────────────────────────
 *
 * An offer's terms are its access STATE -- free, premium, credit or
 * unavailable -- a whole-Credit PRICE for credit content, and an optional AGE
 * FLOOR. Locked photos and videos are priced per asset, here, not in the
 * economy configuration's action costs (P1, `ECONOMY_ACTION_CATALOGUE`); plan
 * prices and money never are. `economyRef` still names any configuration an
 * offer relies on. The age floor is recorded here and enforced by P5.
 *
 * These are TERMS, not access decisions: whether a particular user may open a
 * piece of content (their subscription, an unlock, their verified age) is the
 * later access phases' to decide (P4/P5/P8), and nothing here charges,
 * unlocks or checks anyone.
 */

/** A database or a transaction: applying an allocation writes several offers at once. */
type Reader = Pick<Db, 'select'>;
type Writer = Reader & Pick<Db, 'insert' | 'update' | 'delete'>;

/** The `commercial_state` enum: the P4.1 access states. */
export type ContentCommercialState = ContentAccessState;

/**
 * Content nobody has priced is FREE, with no age floor. There is no backfill
 * and no migration of existing content: absence of an offer is the answer, not
 * missing data.
 *
 * ONE EXCEPTION, AND THE OPERATOR CHOOSES IT (P4.D2). A character given a clip
 * allocation is opted in to Free/Premium: from then on HER un-offered clips
 * read PREMIUM instead, which is what makes a clip uploaded tomorrow Premium
 * without the upload workflow knowing anything about the economy. Every other
 * character, and the whole library until an operator says otherwise, is
 * unchanged.
 */
export const DEFAULT_COMMERCIAL_STATE: ContentCommercialState = 'free';
/** What an un-offered clip of an allocated character reads as. */
export const ALLOCATED_DEFAULT_STATE: ContentCommercialState = 'premium';

/** The age-floor bounds, in years, the database also holds (`content_offers_age_floor`). */
export const AGE_FLOOR_MIN = 18;
export const AGE_FLOOR_MAX = 99;
/** The largest price the column holds (a Postgres integer). */
const CREDIT_PRICE_MAX = 2 ** 31 - 1;

/** Thrown when a write would break the boundary's rules. */
export class CommercialBoundaryError extends Error {
  constructor(
    public readonly kind:
      | 'economy_disabled'
      | 'asset_not_found'
      | 'not_content'
      | 'invalid_state'
      | 'invalid_price'
      | 'invalid_age_floor',
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
  /** Whole Credits to unlock, exactly when `state` is `credit`. */
  creditPrice: number | null;
  /** Minimum age in years, or null for none. */
  ageFloor: number | null;
  /** True when this is merely the default, with no offer written. */
  implicit: boolean;
  /** Economy configuration reference, when the offer names one. */
  economyRef: Record<string, unknown> | null;
}

const IMPLICIT_FREE: AssetCommercialView = {
  offerId: null,
  state: DEFAULT_COMMERCIAL_STATE,
  creditPrice: null,
  ageFloor: null,
  implicit: true,
  economyRef: null,
};

/** The same, for a clip of a character whose clips are Premium by default (P4.D2). */
const IMPLICIT_PREMIUM: AssetCommercialView = { ...IMPLICIT_FREE, state: ALLOCATED_DEFAULT_STATE };

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
  db: Reader,
  assetIds: readonly string[],
): Promise<Map<string, AssetCommercialView>> {
  const out = new Map<string, AssetCommercialView>();
  for (const id of assetIds) out.set(id, IMPLICIT_FREE);
  if (assetIds.length === 0) return out;

  /**
   * P4.D2: EVERY CLIP IS PREMIUM BY DEFAULT -- "for each character, all clips
   * are Premium by default", with no opt-in of any kind.
   *
   * The default used to depend on the character having a free-clip allocation
   * row, so a character nobody had configured read Free. That inverted the
   * decision: it made Premium the exception and required an operator to opt in
   * before the product behaved as specified.
   *
   * ONLY CONTENT. An identity reference is not merchandise and chat media is
   * private, so neither may carry an offer (see `setContentOffer`) and neither
   * may acquire a default that would lock it -- a Premium-by-default portrait
   * would put a padlock on the character's own face. They stay Free here, which
   * for a non-merchandise asset means "access is not this module's business".
   *
   * The allocation row still exists and still remembers the configured number
   * of Free clips; it simply no longer decides what an unclassified clip is.
   */
  const assets = await db
    .select({ id: characterVisualAssets.id, kind: characterVisualAssets.kind })
    .from(characterVisualAssets)
    .where(inArray(characterVisualAssets.id, [...assetIds]));
  for (const asset of assets) {
    if (assetRoleOf(asset.kind) === 'content') out.set(asset.id, IMPLICIT_PREMIUM);
  }

  // An offer always wins over a default: it is what an operator actually said.
  const rows = await db
    .select()
    .from(contentOffers)
    .where(and(inArray(contentOffers.assetId, [...assetIds]), isNull(contentOffers.retiredAt)));

  for (const row of rows) {
    if (!row.assetId) continue;
    out.set(row.assetId, {
      offerId: row.id,
      state: row.state,
      creditPrice: row.creditPrice,
      ageFloor: row.ageFloor,
      implicit: false,
      economyRef: row.economyRef ?? null,
    });
  }
  return out;
}

export async function getAssetCommercial(db: Reader, assetId: string): Promise<AssetCommercialView> {
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
  state: ContentCommercialState;
  /** Whole Credits: required for `credit`, and only for `credit`. */
  creditPrice?: number | null;
  /** Minimum age in years (18-99), or null / absent for none. */
  ageFloor?: number | null;
  /** Economy configuration this offer resolves against (codes only). */
  economyRef?: Record<string, unknown> | null;
}

/** The terms, checked. The database holds the same rules; this says what is wrong in words. */
function checkTerms(input: SetContentOfferInput): { creditPrice: number | null; ageFloor: number | null } {
  if (!(CONTENT_ACCESS_STATES as readonly unknown[]).includes(input.state)) {
    throw new CommercialBoundaryError('invalid_state', `state must be one of: ${CONTENT_ACCESS_STATES.join(', ')}.`);
  }
  const price = input.creditPrice ?? null;
  if (input.state === 'credit') {
    if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 1 || price > CREDIT_PRICE_MAX) {
      throw new CommercialBoundaryError('invalid_price', 'Credit content needs a price: a whole number of Credits, 1 or more.');
    }
  } else if (price !== null) {
    throw new CommercialBoundaryError('invalid_price', `Only credit content has a Credit price; ${input.state} content has none.`);
  }
  const ageFloor = input.ageFloor ?? null;
  if (ageFloor !== null && (typeof ageFloor !== 'number' || !Number.isInteger(ageFloor) || ageFloor < AGE_FLOOR_MIN || ageFloor > AGE_FLOOR_MAX)) {
    throw new CommercialBoundaryError('invalid_age_floor', `The age floor must be a whole number of years from ${AGE_FLOOR_MIN} to ${AGE_FLOOR_MAX}, or none.`);
  }
  return { creditPrice: price, ageFloor };
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
  db: Writer,
  commerce: { enabled: boolean },
  input: SetContentOfferInput,
): Promise<ContentOfferRow> {
  assertCommercialWrite(commerce);
  const terms = checkTerms(input);

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
        creditPrice: terms.creditPrice,
        ageFloor: terms.ageFloor,
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
      creditPrice: terms.creditPrice,
      ageFloor: terms.ageFloor,
      economyRef: input.economyRef ?? null,
      snapshot,
    })
    .returning();
  return created!;
}

/**
 * Stop offering this content. The row stays, with the terms it had -- state,
 * price, age floor: entitlements already granted against it remain valid, and
 * a retired offer is how that history is kept. The content reads as FREE again
 * until a new offer for it is written.
 */
export async function retireContentOffer(
  db: Writer,
  commerce: { enabled: boolean },
  offerId: string,
): Promise<ContentOfferRow | null> {
  assertCommercialWrite(commerce);
  const [updated] = await db
    .update(contentOffers)
    .set({ retiredAt: new Date(), updatedAt: new Date() })
    .where(and(eq(contentOffers.id, offerId), isNull(contentOffers.retiredAt)))
    .returning();
  return updated ?? null;
}

export async function liveOfferFor(db: Reader, assetId: string): Promise<ContentOfferRow | null> {
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
  db: Reader,
  characterId: string,
): Promise<ContentOfferRow[]> {
  return db.select().from(contentOffers).where(eq(contentOffers.characterId, characterId));
}

/**
 * EVERY offer ever written for these assets, live and retired alike, by asset
 * id (P8.2).
 *
 * Retired ones are included deliberately, and that is the whole point of this
 * function. An entitlement names the offer it was bought under, so a customer
 * who unlocked a clip holds THAT offer -- and an operator who later retires it
 * and writes a new one at a new price must not thereby make the customer pay
 * again. Ownership is therefore asked of an asset's whole offer history, never
 * only of its live offer.
 *
 * An asset with no offer at all is absent, not an empty list: there is nothing
 * anyone could own.
 */
export async function offerHistoryForAssets(db: Reader, assetIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (assetIds.length === 0) return out;
  const rows = await db
    .select({ id: contentOffers.id, assetId: contentOffers.assetId })
    .from(contentOffers)
    .where(inArray(contentOffers.assetId, [...assetIds]));
  for (const row of rows) {
    if (row.assetId === null) continue;
    const list = out.get(row.assetId);
    if (list) list.push(row.id);
    else out.set(row.assetId, [row.id]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The Free/Premium allocation of one character's clips (P4.D2)
 * ------------------------------------------------------------------ */

/**
 * A character's allocation. Its EXISTENCE opts her clips in to Premium by
 * default; `freeClipCount` records how many Free clips the operator asked for.
 * Which clips are Free is not stored here -- those are ordinary offers, so a
 * clip's access state still has exactly one answer.
 */
export interface ClipAllocation {
  characterId: string;
  freeClipCount: number | null;
  updatedAt: string;
  updatedBy: string | null;
}

const toAllocation = (row: typeof characterClipAllocation.$inferSelect): ClipAllocation => ({
  characterId: row.characterId,
  freeClipCount: row.freeClipCount,
  updatedAt: row.updatedAt.toISOString(),
  updatedBy: row.updatedBy,
});

export async function readClipAllocation(db: Reader, characterId: string): Promise<ClipAllocation | null> {
  const [row] = await db.select().from(characterClipAllocation).where(eq(characterClipAllocation.characterId, characterId));
  return row ? toAllocation(row) : null;
}

/** Opts a character in to Free/Premium, and records how many Free clips she should have. */
export async function setClipAllocation(
  db: Writer,
  commerce: { enabled: boolean },
  input: { characterId: string; freeClipCount: number | null; actorUserId: string | null },
): Promise<ClipAllocation> {
  assertCommercialWrite(commerce);
  if (input.freeClipCount !== null && (!Number.isSafeInteger(input.freeClipCount) || input.freeClipCount < 0)) {
    throw new CommercialBoundaryError('invalid_state', 'The number of Free clips must be a whole number, 0 or more.');
  }
  const [row] = await db
    .insert(characterClipAllocation)
    .values({ characterId: input.characterId, freeClipCount: input.freeClipCount, updatedBy: input.actorUserId })
    .onConflictDoUpdate({
      target: characterClipAllocation.characterId,
      set: { freeClipCount: input.freeClipCount, updatedBy: input.actorUserId, updatedAt: sql`now()` },
    })
    .returning();
  return toAllocation(row!);
}

/**
 * Takes a character back out: her clips read as they did before any of this,
 * which is FREE. The offers themselves are the caller's to retire -- a
 * commercial record is never deleted here.
 */
export async function removeClipAllocation(db: Writer, commerce: { enabled: boolean }, characterId: string): Promise<boolean> {
  assertCommercialWrite(commerce);
  const removed = await db.delete(characterClipAllocation).where(eq(characterClipAllocation.characterId, characterId)).returning();
  return removed.length > 0;
}
