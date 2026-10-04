import type { CustomerActionCost } from '@over18/shared';
import type { CustomerEconomyOverview } from './customerEconomy.models';

/**
 * WHAT THINGS COST, FOR THE INTERFACE TO SAY OUT LOUD.
 *
 * Every number here comes from the published ruleset, by way of the customer
 * catalogue. NOTHING IN THIS FILE KNOWS A PRICE. There is deliberately no
 * default, no fallback and no constant: if the economy has not published a cost
 * for an action, these return null and the caller shows nothing. An interface
 * that invents a price is worse than one that stays quiet, because the number it
 * invents will be wrong on the day somebody changes the real one.
 *
 * THE COSTS ARE THE SERVER'S, AND SO IS THE ARITHMETIC THAT MATTERS. These
 * helpers multiply a published cost by a whole number of messages or minutes,
 * which is exactly what `priceOn` does for `per_action` and `per_minute`. They
 * do NOT attempt duration-tiered actions (`video`), whose price is not linear --
 * see `canIllustrate`.
 */

/** The standard tier: what an ordinary customer is quoted. */
const STANDARD = 'standard';

export const TEXT_MESSAGE = 'text_message';
export const VOICE_CALL = 'voice_call';

/**
 * The published cost of one action, or null.
 *
 * Null covers every way the answer can be unknown -- no ruleset, the action not
 * priced, the cost disabled -- because to a screen they are the same situation:
 * there is no number to show.
 */
export function actionCost(
  overview: Pick<CustomerEconomyOverview, 'catalog'> | null | undefined,
  actionType: string,
): CustomerActionCost | null {
  const costs = overview?.catalog?.actionCosts;
  if (!Array.isArray(costs)) return null;
  return (
    costs.find(
      (cost) =>
        cost?.actionType === actionType &&
        cost.qualityTier === STANDARD &&
        // A tiered cost is one of several for the same action and cannot stand
        // for "what it costs"; those actions are not illustrated at all.
        cost.maxDurationSeconds === null,
    ) ?? null
  );
}

/** Just the number, when there is one. */
export function creditsFor(
  overview: Pick<CustomerEconomyOverview, 'catalog'> | null | undefined,
  actionType: string,
): number | null {
  return actionCost(overview, actionType)?.creditCost ?? null;
}

/**
 * Whether a published cost can be multiplied out into an example.
 *
 * Per action and per started minute are linear, so ten of them cost ten times
 * one. A duration-tiered action is not, and showing "10 videos = 10 x the first
 * tier" would be a confident lie.
 */
export function canIllustrate(cost: CustomerActionCost | null): cost is CustomerActionCost {
  return cost !== null && (cost.unit === 'per_action' || cost.unit === 'per_minute') && cost.maxDurationSeconds === null;
}

/** "1 Credit", "2 Credits" — the unit a person reads, never "1 Credits". */
export function credits(amount: number): string {
  return `${amount} Credit${amount === 1 ? '' : 's'}`;
}

/**
 * The per-unit label shown beside the thing it prices: "1 Credit / message",
 * "2 Credits / minute". Null when nothing is published.
 */
export function perUnitLabel(
  overview: Pick<CustomerEconomyOverview, 'catalog'> | null | undefined,
  actionType: string,
): string | null {
  const cost = actionCost(overview, actionType);
  if (!cost) return null;
  return `${credits(cost.creditCost)} / ${cost.unit === 'per_minute' ? 'minute' : 'message'}`;
}

/** What `quantity` of an action costs, or null when it cannot be illustrated. */
export function costOf(
  overview: Pick<CustomerEconomyOverview, 'catalog'> | null | undefined,
  actionType: string,
  quantity: number,
): number | null {
  const cost = actionCost(overview, actionType);
  if (!canIllustrate(cost)) return null;
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  return cost.creditCost * Math.floor(quantity);
}

/**
 * How many of an action a balance covers.
 *
 * Floored, because a part of a message or a part of a minute buys nothing. Null
 * when the action is unpriced, and null for a free action rather than Infinity:
 * "unlimited" is a claim this screen should not make on the economy's behalf.
 */
export function howManyFor(
  overview: Pick<CustomerEconomyOverview, 'catalog'> | null | undefined,
  actionType: string,
  balance: number | null,
): number | null {
  const cost = actionCost(overview, actionType);
  if (!canIllustrate(cost) || cost.creditCost <= 0) return null;
  if (balance === null || !Number.isFinite(balance) || balance < 0) return null;
  return Math.floor(balance / cost.creditCost);
}
