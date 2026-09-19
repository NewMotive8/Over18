import type { CommercialTier, CustomerEconomyCatalog, CustomerPlanOffer } from '@over18/shared';
import type { CustomerAction, CustomerActionSlot, CustomerEconomyOverview } from './customerEconomy.models';

/**
 * Pure reads over the customer economy overview. Each answers `null` when the
 * server has not said something, rather than substituting a default: no
 * balance becomes 0, no tier becomes "free", no plan is invented.
 */

type Maybe<T> = T | null | undefined;

/** A catalog plan by its stable code -- never by tier; several plans can share one. */
export function getPlan(catalog: Maybe<CustomerEconomyCatalog>, code: Maybe<string>): CustomerPlanOffer | null {
  if (!catalog || !code || !Array.isArray(catalog.plans)) return null;
  return catalog.plans.find((plan) => plan.code === code) ?? null;
}

/**
 * The plan the customer is subscribed to. `null` when the subscription is
 * unknown, when there is none, or when its plan is not an offered plan in the
 * catalog (unknown or retired). There is no "Free" catalog plan: having no
 * subscription is not a plan.
 */
export function getCurrentPlan(overview: Maybe<CustomerEconomyOverview>): CustomerPlanOffer | null {
  if (!overview) return null;
  const subscription = overview.commercial?.subscription;
  if (!subscription || !subscription.available || !subscription.value) return null;
  const plan = getPlan(overview.catalog, subscription.value.planCode);
  return plan?.isPurchasable ? plan : null;
}

/** Plans a customer may be offered: purchasable ones only, in server order. */
export function offeredPlans(overview: Maybe<CustomerEconomyOverview>): CustomerPlanOffer[] {
  const plans = overview?.catalog?.plans;
  return Array.isArray(plans) ? plans.filter((plan) => plan.isPurchasable) : [];
}

/** The server's quote for a presentation slot, or `null`. Never throws. */
export function getAction(overview: Maybe<CustomerEconomyOverview>, slot: Maybe<CustomerActionSlot>): CustomerAction | null {
  const actions = overview?.actions;
  if (!slot || !Array.isArray(actions)) return null;
  return actions.find((action) => action?.slot === slot) ?? null;
}

/** The server's tier, or `null` while it is not available. */
export function commercialTier(overview: Maybe<CustomerEconomyOverview>): CommercialTier | null {
  const tier = overview?.commercial?.tier;
  return tier?.available ? tier.value : null;
}

/** The server's spendable balance, or `null` while the wallet is not available. */
export function spendableCredits(overview: Maybe<CustomerEconomyOverview>): number | null {
  const wallet = overview?.commercial?.wallet;
  return wallet?.available ? wallet.value.spendable : null;
}

/**
 * A plan's price for display. Presentation only: the amount is the server's
 * `priceMinor`, shown in its currency's standard number of decimals.
 */
export function formatPlanPrice(plan: Pick<CustomerPlanOffer, 'priceMinor' | 'currency' | 'billingPeriodMonths'>): string {
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: plan.currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  const amount = format.format(plan.priceMinor / 10 ** digits);
  const months = plan.billingPeriodMonths;
  const period = months === 1 ? 'month' : months === 12 ? 'year' : `${months} months`;
  return `${amount} / ${period}`;
}
