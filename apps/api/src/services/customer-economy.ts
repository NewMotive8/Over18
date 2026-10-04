import type {
  CustomerCommercialState,
  CustomerEconomyCatalog,
  CustomerPackOffer,
  CustomerPlanOffer,
  CustomerSubscriptionDetail,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import type { SafeUser } from './auth-service.js';
import {
  economyNow,
  resolvePackCatalog,
  resolvePlanCatalog,
  type PackVersionView,
  type PlanVersionView,
} from './economy-resolver.js';
import { effectivePackTerms } from './pack-terms.js';
import { lastSettledSubscriptionPayment } from './payment-service.js';
import {
  readSubscriptionRecord,
  resolveSubscription,
  subscriptionActions,
  subscriptionStartedAt,
} from './subscription-service.js';
import { CREDITS_CURRENCY, readCommercialWallet } from './wallet-service.js';

/**
 * The customer economy READ boundary: what a signed-in customer may see of the
 * economy, and nothing else.
 *
 * PUBLISHED AND IN EFFECT, FROM THE RESOLVER ONLY. The catalog is exactly what
 * the P1.2 resolver serves at the database clock's "now" -- never a draft, a
 * future-scheduled version, a preview input or a value computed here. Nothing
 * in this module chooses a version or prices anything; it projects.
 *
 * AN EXPLICIT ALLOW-LIST. Each offer is built field by field rather than by
 * spreading the resolver's view, so a field added to the view later (an
 * internal note, an audit column) is not published to customers by accident.
 *
 * NO PLACEHOLDERS. The subscription and tier come from the subscription
 * service (P3.1) and the Credits from the ledger (P2); age verification has no
 * persistence yet and is reported as unavailable, with the reason. The
 * phase-zero `resolveEntitlement` answers "free, zero Credits, unverified" for
 * everyone, which is a placeholder rather than a fact, so it is deliberately
 * NOT used here. A fact that cannot be resolved safely is reported as
 * unavailable -- never defaulted, and never as Premium.
 *
 * READ-ONLY: no write, no lock, no reservation.
 */

function toPlanOffer(plan: PlanVersionView): CustomerPlanOffer {
  return {
    code: plan.ref.code,
    version: plan.ref.version,
    versionId: plan.ref.id,
    displayName: plan.displayName,
    billingPeriodMonths: plan.billingPeriodMonths,
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    monthlyIncludedCredits: plan.monthlyIncludedCredits,
    // `features` are machine rules for server-side entitlement decisions, not
    // customer-facing benefits: deliberately never projected here.
    isPurchasable: plan.isPurchasable,
    effectiveFrom: plan.effectiveFrom,
  };
}

/**
 * A pack as the customer may buy it at `asOfIso`: the price and promotion are
 * the ones in effect then (`pack-terms.ts`), the same rule the checkout charges
 * by. An ended promotion is not shown at all -- not as a countdown at zero,
 * not as a struck-through price.
 */
function toPackOffer(pack: PackVersionView, asOfIso: string): CustomerPackOffer {
  const terms = effectivePackTerms(pack, asOfIso);
  return {
    code: pack.ref.code,
    version: pack.ref.version,
    versionId: pack.ref.id,
    displayName: pack.displayName,
    credits: terms.credits,
    priceMinor: terms.priceMinor,
    currency: pack.currency,
    sortOrder: pack.sortOrder,
    isBestValue: pack.isBestValue,
    isPurchasable: pack.isPurchasable,
    effectiveFrom: pack.effectiveFrom,
    badge: pack.badge,
    bonusCredits: terms.bonusCredits,
    totalCredits: terms.totalCredits,
    wasPriceMinor: terms.wasPriceMinor,
    promotionEndsAt: terms.promotionEndsAt,
  };
}

/**
 * Every plan and pack in effect now, from ONE database instant so a plan and a
 * pack can never come from two different moments. A parent with no effective
 * version is absent; an empty list is the true answer when nothing is
 * published. Retired versions are included with `isPurchasable: false` -- a
 * client must not offer them.
 */
export async function readCustomerCatalog(db: Db): Promise<CustomerEconomyCatalog> {
  const asOf = await economyNow(db);
  const [{ plans }, { packs }] = await Promise.all([resolvePlanCatalog(db, asOf), resolvePackCatalog(db, asOf)]);
  return { asOf: asOf.iso, plans: plans.map(toPlanOffer), packs: packs.map((pack) => toPackOffer(pack, asOf.iso)) };
}

/**
 * The signed-in customer's commercial state, as far as it is authoritative:
 * who they are, that the economy is on (the caller only asks while it is),
 * their tier and subscription as the server resolves them, and their Credits.
 * A subscription whose plan cannot be resolved gives neither a tier nor a
 * subscription -- so never Premium. Age verification has no persistence yet.
 */
export async function readCustomerCommercialState(db: Db, user: SafeUser): Promise<CustomerCommercialState> {
  const [subscription, wallet] = await Promise.all([
    resolveSubscription(db, user.id),
    readCommercialWallet(db, user.id, CREDITS_CURRENCY),
  ]);
  const unresolvable = { available: false, reason: 'subscription_unresolvable' } as const;
  return {
    viewer: { userId: user.id },
    economyEnabled: true,
    tier: subscription.ok ? { available: true, value: subscription.tier } : unresolvable,
    subscription: subscription.ok ? { available: true, value: subscription.subscription } : unresolvable,
    wallet: wallet ? { available: true, value: wallet } : { available: false, reason: 'wallet_unresolvable' },
    age: { available: false, reason: 'age_verification_not_supported' },
  };
}

/* ------------------------------------------------------------------ *
 * A subscriber's own subscription, for managing it
 * ------------------------------------------------------------------ */

/**
 * The subscriber's own subscription as the management screen needs it: the exact
 * plan version they hold, the status they are told, the period already paid for,
 * when it began, what they last paid, and whether cancelling is available.
 *
 * THE PLAN COMES FROM THE SUBSCRIPTION, NOT THE CATALOGUE. `readSubscriptionRecord`
 * loads the exact version the subscription names, so a subscriber on a withdrawn
 * plan is still shown what they hold -- the catalogue offers only purchasable
 * plans and would show them nothing. `live` says whether that version is still
 * the published one, which is also the only way the status can be Premium.
 *
 * `canCancel` IS THE SERVER'S ANSWER. It comes from the same `subscriptionActions`
 * the change path enforces, so the page can never offer a cancellation the
 * server would refuse, nor hide one it would allow.
 */
export async function readCustomerSubscriptionDetail(
  db: Db,
  userId: string,
): Promise<CustomerSubscriptionDetail | null> {
  const { current } = await readSubscriptionRecord(db, userId);
  if (!current) return null;

  const [startedAt, lastPayment] = await Promise.all([
    subscriptionStartedAt(db, userId),
    lastSettledSubscriptionPayment(db, userId),
  ]);

  const plan = current.plan;
  return {
    plan: {
      code: plan.ref.code,
      version: plan.ref.version,
      displayName: plan.displayName,
      priceMinor: plan.priceMinor,
      currency: plan.currency,
      billingPeriodMonths: plan.billingPeriodMonths,
      monthlyIncludedCredits: plan.monthlyIncludedCredits,
      live: plan.status === 'published',
    },
    status: current.status,
    currentPeriodEnd: current.currentPeriodEnd,
    cancelAtPeriodEnd: current.status === 'cancelled',
    startedAt,
    lastPayment,
    canCancel: subscriptionActions(current).includes('cancel'),
  };
}
