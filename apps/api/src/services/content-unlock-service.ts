import type { CustomerContentUnlock } from '@over18/shared';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import type { ContentEntitlementRow } from '../db/schema.js';
import type { SafeUser } from './auth-service.js';
import { liveOfferFor } from './commercial-boundary.js';
import { readContentAccess } from './content-access.js';
import { grantEntitlement, readEntitlementFor, readEntitlementForPaidAction, revokeEntitlement } from './content-ownership.js';
import {
  PaidActionError,
  beginPaidAction,
  capturePaidAction,
  refundPaidAction,
  type PaidActionRecord,
} from './paid-action-service.js';
import { WalletError } from './wallet-service.js';

/**
 * ATOMIC CONTENT UNLOCK (P8.2, PRD §10, UC-08/09/16).
 *
 * A customer pays the content's own Credit price and keeps the content.
 *
 * ── IT ADDS NO RULE OF ITS OWN ───────────────────────────────────────────────
 *
 * Whether the content can be unlocked is the P4.2 resolver's answer, not a
 * second opinion formed here. What it costs is the P4.1 offer's price, read
 * through the commercial boundary. What happens to the Credits is P2's, through
 * the P7.1 paid-action framework. Ownership is `content-ownership.ts`'s. This
 * module only puts them in the right order, atomically.
 *
 * ── ATOMIC MEANS ONE TRANSACTION ─────────────────────────────────────────────
 *
 * Reserving the Credits, recording the ownership and consuming the Credits all
 * happen in a SINGLE database transaction. There is no provider to wait for --
 * an unlock is a database fact, not an errand -- so nothing is left in flight
 * between the steps, and there is no instant at which a customer has paid
 * without owning the content or owns it without having paid. A failure
 * anywhere rolls back the hold, the ownership and the capture together: for
 * work that never leaves the database, that IS P2's release semantics, and it
 * is why an unlock can never strand a reservation.
 *
 * The Credits are still HELD first rather than charged outright, because that
 * is what makes the ledger tell the truth -- reserved at this price, then
 * consumed -- and it is the same shape a provider-backed unlock would need.
 *
 * ── THE PRICE IS READ AT THE MOMENT OF THE CHARGE ────────────────────────────
 *
 * A request says WHICH content, never what it costs. The price is read from the
 * live offer INSIDE the charging transaction, through the pricing resolver
 * P7.1 takes, and that offer's id is pinned on the paid action. An offer that
 * has stopped being Credit-priced by then prices nothing, and the unlock fails
 * rather than charging a remembered number.
 *
 * ── IDEMPOTENT, THREE TIMES OVER ─────────────────────────────────────────────
 *
 * A retry must never charge twice or create a second entitlement:
 *
 *   1. ALREADY OWNED wins before anything else. A customer who owns the content
 *      is told so and charged nothing, whatever key they retry with.
 *   2. THE PAID ACTION'S KEY. The same key replays P7.1's action, so the
 *      Credits move once, and the entitlement it bought is returned with it.
 *   3. THE DATABASE. One live entitlement per customer per offer. Two different
 *      keys racing for the same content leave one winner; the loser's whole
 *      transaction rolls back -- charging nothing -- and it is answered with
 *      the ownership that won.
 *
 * NOT HERE: checkout, payment providers, age verification, and any way to come
 * to own content without paying for it.
 */

/** The action name a content unlock is recorded under, and what priced it. */
export const CONTENT_UNLOCK_ACTION = 'content_unlock';
export const CONTENT_OFFER_PRICE_SOURCE = 'content_offer';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_MAX = 200;
const REASON_MAX = 500;

export type ContentUnlockErrorCode =
  | 'invalid_request'
  | 'economy_disabled'
  /** Withdrawn, unknown, or not something this customer could reach at all. */
  | 'unavailable'
  /** The content states an age floor. P5 owns meeting it; until then nobody does. */
  | 'age_restricted'
  /** Free content, or Premium content a subscriber already sees: there is nothing to buy. */
  | 'not_purchasable'
  /** Premium content: a subscription is the way in, not Credits. */
  | 'premium_required'
  /** The offer stopped being Credit-priced between the decision and the charge. */
  | 'price_changed'
  /** This request was already made and then refunded: its key is spent. */
  | 'purchase_reversed'
  | 'insufficient_credits'
  | 'not_owned';

export class ContentUnlockError extends Error {
  constructor(
    public readonly code: ContentUnlockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContentUnlockError';
  }
}

function invalid(message: string): never {
  throw new ContentUnlockError('invalid_request', message);
}

const PRICE_CHANGED = 'The price of this content changed; nothing was charged. Try again.';

export interface ContentUnlockRequest {
  assetId: string;
  /** One key, one purchase. A retry under the same key charges once. */
  idempotencyKey: string;
  requestId?: string | null;
}

function parse(request: ContentUnlockRequest): { assetId: string; idempotencyKey: string; requestId: string | null } {
  if (!request || typeof request !== 'object') invalid('The unlock must be described by an object.');
  if (typeof request.assetId !== 'string' || !UUID.test(request.assetId)) invalid('assetId must be an asset id.');
  const key = request.idempotencyKey;
  if (typeof key !== 'string' || key.trim() === '' || key.length > KEY_MAX) {
    invalid(`idempotencyKey must be non-blank text of at most ${KEY_MAX} characters.`);
  }
  return { assetId: request.assetId.toLowerCase(), idempotencyKey: key, requestId: request.requestId ?? null };
}

/** What a P4.2 decision means for an unlock, when it does not mean "go ahead". */
const REFUSALS: Partial<Record<string, { code: ContentUnlockErrorCode; message: string }>> = {
  unavailable: { code: 'unavailable', message: "This content isn't available." },
  age_restricted: { code: 'age_restricted', message: 'This content needs age confirmation, which is not available yet.' },
  open: { code: 'not_purchasable', message: 'This content is already open to you: there is nothing to unlock.' },
  premium_required: { code: 'premium_required', message: 'This content is included with Premium, not unlocked with Credits.' },
};

/** A unique-violation on the one-live-entitlement index: another request won. */
function isDuplicateEntitlement(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === 'content_entitlements_live_idx') return true;
    current = candidate.cause;
  }
  return false;
}

const toUnlock = (assetId: string, row: ContentEntitlementRow, replayed: boolean): CustomerContentUnlock => ({
  assetId,
  entitlementId: row.id,
  offerId: row.offerId,
  creditPrice: row.creditPrice,
  acquiredAt: row.acquiredAt.toISOString(),
  replayed,
});

/**
 * Unlocks one piece of Credit-priced content for this customer.
 *
 * Returns the ownership, with `replayed` saying whether this request had
 * already been applied. A customer who already owns the content is answered
 * exactly the same way, having been charged nothing.
 */
export async function unlockContent(
  db: Db,
  commerce: Pick<CommerceEnv, 'enabled'>,
  user: SafeUser,
  request: ContentUnlockRequest,
): Promise<CustomerContentUnlock> {
  if (!commerce.enabled) {
    throw new ContentUnlockError('economy_disabled', 'The economy is switched off: content cannot be unlocked yet.');
  }
  const { assetId, idempotencyKey, requestId } = parse(request);

  // 1. Already owned? Then there is nothing to decide and nothing to charge.
  const already = await readEntitlementFor(db, user.id, assetId);
  if (already) return toUnlock(assetId, already, true);

  // 2. P4.2 decides whether this CAN be unlocked. No rule about reachability,
  //    age, tier or price is restated here.
  const { items } = await readContentAccess(db, user, [assetId]);
  const decision = items[0]!.decision;
  const refusal = REFUSALS[decision];
  if (refusal) throw new ContentUnlockError(refusal.code, refusal.message);
  if (decision === 'owned') {
    const now = await readEntitlementFor(db, user.id, assetId);
    if (now) return toUnlock(assetId, now, true);
  }
  // `credits_required` and `insufficient_credits` both go on: affordability is
  // the wallet's to judge under its own lock, not this read's.

  try {
    return await db.transaction(async (tx) => {
      const started = await beginPaidAction(tx, commerce, {
        userId: user.id,
        actionType: CONTENT_UNLOCK_ACTION,
        idempotencyKey,
        requestId,
        metadata: { assetId },
        pricedBy: {
          source: CONTENT_OFFER_PRICE_SOURCE,
          // The price, read as the Credits move. An offer that is no longer
          // Credit-priced -- retired, re-stated, or given an age floor since
          // the decision -- prices nothing, and nothing is charged.
          resolve: async () => {
            const offer = await liveOfferFor(tx, assetId);
            if (!offer || offer.state !== 'credit' || offer.creditPrice === null || offer.ageFloor !== null) {
              throw new ContentUnlockError('price_changed', PRICE_CHANGED);
            }
            return { amount: offer.creditPrice, refId: offer.id };
          },
        },
      });
      const action = started.action;

      // A replay of the same key: the Credits moved once, and what they bought
      // is what to return.
      if (started.replayed) {
        const bought = await readEntitlementForPaidAction(tx, action.id);
        if (bought) return toUnlock(assetId, bought, true);
        // No live ownership behind a settled action means this purchase was
        // refunded. One key names one purchase for good, so it cannot be used
        // to buy the content a second time -- and claiming ownership here would
        // contradict the resolver. Only an action still HELD can be finished,
        // which a single-transaction unlock never leaves behind.
        if (action.status !== 'held') {
          throw new ContentUnlockError('purchase_reversed', 'That purchase was refunded. Unlock this content again as a new purchase.');
        }
      }

      const entitlement = await grantEntitlement(tx, {
        userId: user.id,
        offerId: action.priceRefId!,
        paidActionId: action.id,
        creditPrice: action.amount,
      });

      // Consume exactly what was reserved, in the same transaction that
      // recorded the ownership: neither can exist without the other.
      await capturePaidAction(tx, commerce, { actionId: action.id });
      return toUnlock(assetId, entitlement, false);
    });
  } catch (error) {
    if (isDuplicateEntitlement(error)) {
      // Another request bought it first. This transaction rolled back whole, so
      // nothing was charged: answer with the ownership that won.
      const won = await readEntitlementFor(db, user.id, assetId);
      if (won) return toUnlock(assetId, won, true);
    }
    if (error instanceof WalletError && error.code === 'insufficient_credits') {
      throw new ContentUnlockError('insufficient_credits', 'You do not have enough Credits to unlock this.');
    }
    if (error instanceof PaidActionError && error.code === 'not_priced') {
      throw new ContentUnlockError('price_changed', PRICE_CHANGED);
    }
    throw error;
  }
}

/**
 * Refunds a purchase and takes the ownership back, together.
 *
 * The Credits go back through P7.1's refund -- to the class they were charged
 * from, as P2 requires -- and the entitlement is revoked rather than deleted,
 * so a purchase and its reversal both stay answerable. Revoking frees the
 * customer to buy the content again later, at whatever it then costs.
 *
 * NOTHING CALLS THIS YET. It is the other half of "release or refund on failure
 * or cancellation": inside a single transaction a failed unlock simply rolls
 * back, and this is what a cancellation AFTER the fact means.
 */
export async function refundContentUnlock(
  db: Db,
  commerce: Pick<CommerceEnv, 'enabled'>,
  input: { userId: string; assetId: string; reason: string },
): Promise<{ entitlementId: string; action: PaidActionRecord }> {
  if (!commerce.enabled) {
    throw new ContentUnlockError('economy_disabled', 'The economy is switched off: nothing can be refunded yet.');
  }
  if (typeof input.userId !== 'string' || !UUID.test(input.userId)) invalid('userId must be a user id.');
  if (typeof input.assetId !== 'string' || !UUID.test(input.assetId)) invalid('assetId must be an asset id.');
  if (typeof input.reason !== 'string' || input.reason.trim() === '' || input.reason.length > REASON_MAX) {
    invalid(`A refund needs a reason of at most ${REASON_MAX} characters.`);
  }
  const reason = input.reason.trim();

  return db.transaction(async (tx) => {
    const held = await readEntitlementFor(tx, input.userId, input.assetId.toLowerCase());
    if (!held) throw new ContentUnlockError('not_owned', 'This customer does not own this content.');

    const refunded = await refundPaidAction(tx, commerce, { actionId: held.paidActionId }, { reason });
    const revoked = await revokeEntitlement(tx, held.id, reason);
    if (!revoked) throw new ContentUnlockError('not_owned', 'This customer does not own this content.');
    return { entitlementId: revoked.id, action: refunded.action };
  });
}
