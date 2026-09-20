import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { contentEntitlements, type ContentEntitlementRow } from '../db/schema.js';
import { offerHistoryForAssets } from './commercial-boundary.js';

/**
 * WHAT A CUSTOMER OWNS (P8.2) -- the one module that reads or writes
 * `content_entitlements`.
 *
 * It is deliberately small and deliberately alone. The P4.2 resolver asks it
 * what a customer owns; the unlock service asks it to record a purchase. Both
 * go through here, so ownership has exactly one definition, in the same way the
 * wallet service is the only module that writes a balance.
 *
 * AN ENTITLEMENT NAMES AN OFFER, AND OWNERSHIP IS ASKED OF AN ASSET'S WHOLE
 * OFFER HISTORY. P0.8 made offers outlive the content they describe, so an
 * entitlement can survive a deleted character; the price of that is that one
 * asset may have several offers over its life. A customer owns an asset when
 * they hold a live entitlement to ANY of them -- otherwise re-pricing content
 * would silently charge someone twice for the same clip.
 *
 * NOTHING HERE DECIDES ACCESS, and nothing here grants ownership for free:
 * `grantEntitlement` records a purchase that a paid action has already been
 * made for, and takes the transaction it is part of.
 */

/** This customer's live entitlements among these offers. */
async function liveAmong(db: Pick<Db, 'select'>, userId: string, offerIds: string[]): Promise<ContentEntitlementRow[]> {
  if (offerIds.length === 0) return [];
  return db
    .select()
    .from(contentEntitlements)
    .where(
      and(
        eq(contentEntitlements.userId, userId),
        inArray(contentEntitlements.offerId, offerIds),
        isNull(contentEntitlements.revokedAt),
      ),
    );
}

/** Which of these assets this customer owns. */
export async function readOwnedAssetIds(
  db: Pick<Db, 'select'>,
  userId: string,
  assetIds: readonly string[],
): Promise<Set<string>> {
  const owned = new Set<string>();
  if (assetIds.length === 0) return owned;

  const history = await offerHistoryForAssets(db, assetIds);
  const held = new Set((await liveAmong(db, userId, [...new Set([...history.values()].flat())])).map((row) => row.offerId));
  if (held.size === 0) return owned;
  for (const [assetId, offers] of history) {
    if (offers.some((id) => held.has(id))) owned.add(assetId);
  }
  return owned;
}

/** This customer's live entitlement to any offer of this asset, if they have one. */
export async function readEntitlementFor(
  db: Pick<Db, 'select'>,
  userId: string,
  assetId: string,
): Promise<ContentEntitlementRow | null> {
  const offerIds = (await offerHistoryForAssets(db, [assetId])).get(assetId) ?? [];
  return (await liveAmong(db, userId, offerIds))[0] ?? null;
}

/**
 * The LIVE entitlement a given paid action bought, if it still holds one.
 *
 * A revoked row is deliberately not returned. Once a purchase is refunded the
 * customer no longer owns the content, and answering a retry of the original
 * request with that row would tell them they own something the access resolver
 * says they do not.
 */
export async function readEntitlementForPaidAction(
  db: Pick<Db, 'select'>,
  paidActionId: string,
): Promise<ContentEntitlementRow | null> {
  const [row] = await db
    .select()
    .from(contentEntitlements)
    .where(and(eq(contentEntitlements.paidActionId, paidActionId), isNull(contentEntitlements.revokedAt)));
  return row ?? null;
}

/**
 * Records a purchase. The caller passes the transaction that also made the
 * payment, so ownership and payment commit together or not at all.
 *
 * A second live entitlement for the same customer and offer is refused by the
 * database, not by a check here: that is what makes concurrent unlocks safe.
 */
export async function grantEntitlement(
  db: Pick<Db, 'insert'>,
  input: { userId: string; offerId: string; paidActionId: string; creditPrice: number },
): Promise<ContentEntitlementRow> {
  const [row] = await db.insert(contentEntitlements).values(input).returning();
  return row!;
}

/**
 * Takes ownership back, when its purchase is refunded. The row stays, carrying
 * why -- a purchase and its reversal are both history -- and the customer is
 * free to buy the content again later.
 */
export async function revokeEntitlement(
  db: Pick<Db, 'update'>,
  entitlementId: string,
  reason: string,
): Promise<ContentEntitlementRow | null> {
  const [row] = await db
    .update(contentEntitlements)
    .set({ revokedAt: sql`now()`, revokeReason: reason })
    .where(and(eq(contentEntitlements.id, entitlementId), isNull(contentEntitlements.revokedAt)))
    .returning();
  return row ?? null;
}
