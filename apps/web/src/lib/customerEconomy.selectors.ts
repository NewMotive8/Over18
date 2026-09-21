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


/**
 * What one month of a plan costs, in minor units.
 *
 * DERIVED, NOT INVENTED. It is the server's own `priceMinor` divided by the
 * server's own `billingPeriodMonths` -- the same money said per month, so the
 * three billing periods can be compared at all. It is never sent anywhere and
 * never charged: the price the customer pays is always `priceMinor`.
 */
export function monthlyEquivalentMinor(plan: Pick<CustomerPlanOffer, 'priceMinor' | 'billingPeriodMonths'>): number | null {
  const months = plan.billingPeriodMonths;
  if (!Number.isFinite(months) || months <= 0) return null;
  return plan.priceMinor / months;
}

/** `$10.00` -- money only, so a caller can put it in its own sentence. */
export function formatMoneyMinor(minor: number, currency: string): string {
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}

/** `$10.00 a month` for any billing period, or null when it cannot be derived. */
export function formatMonthlyEquivalent(plan: Pick<CustomerPlanOffer, 'priceMinor' | 'billingPeriodMonths' | 'currency'>): string | null {
  const minor = monthlyEquivalentMinor(plan);
  if (minor === null) return null;
  return `${formatMoneyMinor(minor, plan.currency)} a month`;
}

/**
 * How much less per month than the shortest plan on offer, as a whole percent.
 *
 * Null unless there is a genuinely cheaper-per-month comparison to make: no
 * one-month plan to compare against, a different currency, or no saving at
 * all. A saving is a fact about two server prices or it is not shown.
 */
export function savingsPercent(
  plans: readonly CustomerPlanOffer[],
  plan: Pick<CustomerPlanOffer, 'priceMinor' | 'billingPeriodMonths' | 'currency'>,
): number | null {
  const baseline = plans
    .filter((candidate) => candidate.currency === plan.currency)
    .reduce<CustomerPlanOffer | null>(
      (shortest, candidate) =>
        shortest === null || candidate.billingPeriodMonths < shortest.billingPeriodMonths ? candidate : shortest,
      null,
    );
  if (!baseline || baseline.billingPeriodMonths >= plan.billingPeriodMonths) return null;
  const base = monthlyEquivalentMinor(baseline);
  const mine = monthlyEquivalentMinor(plan);
  if (base === null || mine === null || base <= 0 || mine >= base) return null;
  const percent = Math.round(((base - mine) / base) * 100);
  return percent > 0 ? percent : null;
}

/** The plan with the lowest monthly equivalent: the one worth featuring. */
export function bestValuePlan(plans: readonly CustomerPlanOffer[]): CustomerPlanOffer | null {
  return plans.reduce<CustomerPlanOffer | null>((best, candidate) => {
    const mine = monthlyEquivalentMinor(candidate);
    if (mine === null) return best;
    const theirs = best === null ? null : monthlyEquivalentMinor(best);
    return theirs === null || mine < theirs ? candidate : best;
  }, null);
}

/**
 * What to call a billing period in a CTA: "Monthly", "Quarterly", "Annual".
 *
 * Derived from the server's `billingPeriodMonths`, not from the plan's display
 * name, so a renamed plan cannot change what the button promises.
 */
export function billingPeriodLabel(plan: Pick<CustomerPlanOffer, 'billingPeriodMonths'>): string {
  const months = plan.billingPeriodMonths;
  if (months === 1) return 'Monthly';
  if (months === 3) return 'Quarterly';
  if (months === 12) return 'Annual';
  return `${months} months`;
}
