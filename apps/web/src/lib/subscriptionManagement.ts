import type { CustomerSubscriptionDetail, SubscriptionStatus } from '@over18/shared';
import type { CustomerEconomyOverview } from './customerEconomy.models';

type Maybe<T> = T | null | undefined;

/**
 * WORDING FOR MANAGING A SUBSCRIPTION. Pure functions over the server's own
 * detail, kept out of the component so each sentence can be asserted directly.
 *
 * THE ONE THING THIS MODULE REFUSES TO SAY IS "RENEWS". Nothing in the system
 * renews a subscription -- `currentPeriodEnd` is when Premium lapses, not when
 * it bills again -- so a date labelled "Renews" would promise a charge that
 * nothing makes. "Paid through" says exactly what is true: the period has been
 * paid for, and it ends then.
 */

/**
 * A long, unambiguous date. Never a bare numeric one: these are dates people act
 * on, and 12/09 means two different days either side of the Atlantic.
 *
 * RENDERED IN UTC, which is the instant the server stored. A period ending at
 * midnight UTC would otherwise show as the previous day to every viewer west of
 * it -- telling them Premium ends a day earlier than it does.
 */
export function formatSubscriptionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an unknown date';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** The status in plain words. The raw enum is never shown to a customer. */
export function statusLabel(status: SubscriptionStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'past_due':
      return 'Payment overdue';
    case 'grace':
      return 'Grace period';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
  }
}

/**
 * What the period end MEANS to this subscriber, as a label and a date.
 *
 * Cancelled: the date Premium stops, which is the thing they most want to know.
 * Anything else: the period they have paid for. Expired: it already ended.
 */
export function periodEndLine(detail: Pick<CustomerSubscriptionDetail, 'status' | 'currentPeriodEnd'>): {
  label: string;
  date: string;
} {
  const date = formatSubscriptionDate(detail.currentPeriodEnd);
  if (detail.status === 'cancelled') return { label: 'Premium until', date };
  if (detail.status === 'expired') return { label: 'Ended', date };
  return { label: 'Paid through', date };
}

/**
 * The sentence under the status. It states the consequence, because "Cancelled"
 * alone leaves the one question that matters -- do I still have Premium? --
 * unanswered.
 */
export function statusExplanation(
  detail: Pick<CustomerSubscriptionDetail, 'status' | 'currentPeriodEnd' | 'plan'>,
): string {
  const date = formatSubscriptionDate(detail.currentPeriodEnd);
  switch (detail.status) {
    case 'cancelled':
      return `Premium stays on until ${date}. It will not continue after that, and you will not be charged again.`;
    case 'expired':
      return `This subscription ended on ${date}.`;
    case 'past_due':
      return `A payment did not go through. Premium is still on until ${date}.`;
    case 'grace':
      return `Premium is on until ${date} while the payment is sorted out.`;
    case 'active':
      return `Premium is on, and the period you have paid for runs to ${date}.`;
  }
}

/**
 * What cancelling will do, for the confirmation step -- named with the actual
 * date so nobody confirms a vague promise. The verb is deliberately "keep":
 * cancelling here takes nothing away before the period ends.
 */
export function cancelWarning(detail: Pick<CustomerSubscriptionDetail, 'currentPeriodEnd'>): string {
  return `You keep Premium until ${formatSubscriptionDate(
    detail.currentPeriodEnd,
  )}. After that it ends and your included Credits stop. Nothing is charged, and nothing is refunded.`;
}

/**
 * Whether a plan whose version is no longer published needs flagging. Such a
 * subscription resolves to no Premium at all, so saying nothing would leave the
 * customer staring at a plan that is not working.
 */
export function planWithdrawn(detail: Pick<CustomerSubscriptionDetail, 'plan'>): boolean {
  return !detail.plan.live;
}

/**
 * WHETHER THIS CUSTOMER GETS THE MANAGEMENT SCREEN RATHER THAN THE SHOP.
 *
 * Premium, obviously. But also a subscription whose plan version is no longer
 * published: the server then reports no tier and no subscription, so `premium`
 * is false even though the customer holds one and is still being billed for it
 * in their own mind. Sending them to the plan selector would offer a second
 * subscription the server refuses (409 `already_subscribed`) and would hide the
 * one message they need, which is that their plan was withdrawn.
 *
 * Having NO subscription is reported as an available fact with a null value, and
 * is not this case -- that customer is shopping.
 */
export function managesSubscription(overview: Maybe<CustomerEconomyOverview>): boolean {
  const tier = overview?.commercial?.tier;
  if (tier?.available && tier.value === 'premium') return true;
  const subscription = overview?.commercial?.subscription;
  return subscription?.available === false && subscription.reason === 'subscription_unresolvable';
}
