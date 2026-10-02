import type { SubscriptionStatus } from '@over18/shared';
import type { CustomerEconomyState } from './customerEconomy';
import { commercialTier, getPlan } from './customerEconomy.selectors';

/**
 * WHAT THE PROFILE'S MEMBERSHIP CARD SAYS -- decided from the server's facts only.
 *
 * Premium is the server's `tier` (it counts active, past_due, grace and
 * cancelled as Premium; expired is Free). The plan's name is the catalog's;
 * the date is the subscription's `currentPeriodEnd`; "cancelling" is the
 * subscription's own `cancelAtPeriodEnd` / `cancelled` status. Nothing here
 * assumes a tier, a plan, a date or a state the server did not state: a fact
 * that is missing is left out, never filled in.
 */

/** The one line Premium is sold with -- the Premium page's own subtitle. */
export const PREMIUM_SUMMARY = 'Unlimited text chat, Premium content, and Credits every billing cycle.';

export type MembershipView =
  | { kind: 'loading' }
  /** The economy is off, signed out, or the tier is not stated: say nothing about a plan. */
  | { kind: 'unavailable' }
  | { kind: 'free' }
  | {
      kind: 'premium';
      /** The catalog's name for the plan, or plain "Premium" when the plan cannot be named. */
      planName: string;
      /** The subscription's state, when the server stated one. */
      status: SubscriptionStatus | null;
      /** Whether the plan is set to end at the close of the period. */
      cancelling: boolean;
      /** What the date means, and the date -- only when the server gave one. */
      dateLine: string | null;
      /** A payment problem the customer should know about, said plainly. */
      notice: string | null;
    };

/** "Nov 2, 2026" -- the customer's own time zone, unambiguous month. */
export function formatPlanDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function membershipView(state: CustomerEconomyState): MembershipView {
  if (state.status === 'loading') return { kind: 'loading' };
  if (state.status !== 'ready') return { kind: 'unavailable' };
  const overview = state.overview;
  const tier = commercialTier(overview);
  if (tier === null) return { kind: 'unavailable' };
  if (tier !== 'premium') return { kind: 'free' };

  const fact = overview.commercial?.subscription;
  const subscription = fact?.available ? fact.value : null;
  const planName = (subscription && getPlan(overview.catalog, subscription.planCode)?.displayName) || 'Premium';
  if (!subscription) {
    return { kind: 'premium', planName, status: null, cancelling: false, dateLine: null, notice: null };
  }

  const date = formatPlanDate(subscription.currentPeriodEnd);
  const cancelling = subscription.cancelAtPeriodEnd || subscription.status === 'cancelled';
  let dateLine: string | null = null;
  let notice: string | null = null;
  if (date) {
    if (cancelling) dateLine = `Premium until ${date}`;
    else if (subscription.status === 'active') dateLine = `Renews ${date}`;
    else dateLine = `Current period ends ${date}`;
  }
  if (subscription.status === 'past_due') notice = 'Your last payment did not go through.';
  else if (subscription.status === 'grace') notice = 'Your payment is overdue; Premium continues for now.';
  return { kind: 'premium', planName, status: subscription.status, cancelling, dateLine, notice };
}
