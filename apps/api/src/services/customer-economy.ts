import type {
  CustomerCommercialState,
  CustomerEconomyCatalog,
  CustomerPackOffer,
  CustomerPlanOffer,
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
 * NO PLACEHOLDERS. The backend has no subscription, wallet or age-verification
 * persistence yet (P2/P3). The phase-zero `resolveEntitlement` answers "free,
 * zero Credits, unverified" for everyone, which is a placeholder rather than a
 * fact, so it is deliberately NOT used here: each of those facts is reported
 * as unavailable, with the reason, until something authoritative exists.
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

function toPackOffer(pack: PackVersionView): CustomerPackOffer {
  return {
    code: pack.ref.code,
    version: pack.ref.version,
    versionId: pack.ref.id,
    displayName: pack.displayName,
    credits: pack.credits,
    priceMinor: pack.priceMinor,
    currency: pack.currency,
    sortOrder: pack.sortOrder,
    isBestValue: pack.isBestValue,
    isPurchasable: pack.isPurchasable,
    effectiveFrom: pack.effectiveFrom,
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
  return { asOf: asOf.iso, plans: plans.map(toPlanOffer), packs: packs.map(toPackOffer) };
}

/**
 * The signed-in customer's commercial state, limited to what is authoritative
 * today: who they are, and that the economy is on (the caller only asks while
 * it is). Tier and subscription, wallet and age verification have no
 * persistence yet, so each says so.
 */
export function readCustomerCommercialState(user: SafeUser): CustomerCommercialState {
  return {
    viewer: { userId: user.id },
    economyEnabled: true,
    tier: { available: false, reason: 'subscriptions_not_supported' },
    subscription: { available: false, reason: 'subscriptions_not_supported' },
    wallet: { available: false, reason: 'wallet_not_supported' },
    age: { available: false, reason: 'age_verification_not_supported' },
  };
}
