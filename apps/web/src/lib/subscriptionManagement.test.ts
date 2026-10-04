import { describe, expect, it } from 'vitest';
import type { CustomerSubscriptionDetail } from '@over18/shared';
import {
  cancelWarning,
  managesSubscription,
  formatSubscriptionDate,
  periodEndLine,
  planWithdrawn,
  statusExplanation,
  statusLabel,
} from './subscriptionManagement';

/**
 * The wording of subscription management.
 *
 * These are not cosmetic assertions. Each one pins a sentence that tells a
 * paying customer whether they still have what they paid for and when it stops,
 * and the words were chosen against what the billing system can actually do --
 * so a future change that makes one of these claims untrue should fail here
 * rather than on someone's account.
 */

const detail = (over: Partial<CustomerSubscriptionDetail> = {}): CustomerSubscriptionDetail => ({
  plan: {
    code: 'premium_annual',
    version: 1,
    displayName: 'Premium Annual',
    priceMinor: 8999,
    currency: 'USD',
    billingPeriodMonths: 12,
    monthlyIncludedCredits: 200,
    live: true,
  },
  status: 'active',
  currentPeriodEnd: '2027-09-12T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  startedAt: '2026-09-12T10:30:00.000Z',
  lastPayment: { amountMinor: 8999, currency: 'USD', paidAt: '2026-09-12T10:30:00.000Z' },
  canCancel: true,
  ...over,
});

describe('formatSubscriptionDate', () => {
  it('writes the month in words, so 12/09 cannot be read as 9 December', () => {
    expect(formatSubscriptionDate('2027-09-12T00:00:00.000Z')).toBe('12 September 2027');
  });

  /**
   * The regression this guards: formatting in the viewer's timezone turned a
   * midnight-UTC period end into the previous day for everyone west of UTC,
   * which understates how long their Premium lasts.
   */
  it('reads the instant in UTC, not the viewer’s timezone', () => {
    expect(formatSubscriptionDate('2027-01-01T00:00:00.000Z')).toBe('1 January 2027');
    expect(formatSubscriptionDate('2027-01-01T23:59:59.000Z')).toBe('1 January 2027');
  });

  it('says it does not know rather than printing "Invalid Date"', () => {
    expect(formatSubscriptionDate('not a date')).toBe('an unknown date');
  });
});

describe('statusLabel', () => {
  it('never shows the raw enum to a customer', () => {
    expect(statusLabel('active')).toBe('Active');
    expect(statusLabel('past_due')).toBe('Payment overdue');
    expect(statusLabel('grace')).toBe('Grace period');
    expect(statusLabel('cancelled')).toBe('Cancelled');
    expect(statusLabel('expired')).toBe('Expired');
  });
});

describe('periodEndLine', () => {
  /**
   * THE POINT OF THIS WHOLE MODULE. Nothing renews a subscription, so a date
   * labelled "Renews" promises a charge that nothing in the system makes. The
   * old card said exactly that.
   */
  it('never labels the period end "Renews"', () => {
    for (const status of ['active', 'past_due', 'grace', 'cancelled', 'expired'] as const) {
      expect(periodEndLine(detail({ status })).label).not.toMatch(/renew/i);
    }
  });

  it('tells a cancelling customer when Premium stops', () => {
    expect(periodEndLine(detail({ status: 'cancelled' }))).toEqual({
      label: 'Premium until',
      date: '12 September 2027',
    });
  });

  it('describes an active period as paid for, which is what is true of it', () => {
    expect(periodEndLine(detail({ status: 'active' })).label).toBe('Paid through');
  });

  it('puts an expired subscription in the past', () => {
    expect(periodEndLine(detail({ status: 'expired' })).label).toBe('Ended');
  });
});

describe('statusExplanation', () => {
  /** "Cancelled" alone leaves the only question that matters unanswered. */
  it('answers "do I still have Premium?" when cancelled, with the date', () => {
    const text = statusExplanation(detail({ status: 'cancelled' }));
    expect(text).toContain('12 September 2027');
    expect(text).toContain('will not continue');
    expect(text).toContain('not be charged again');
  });

  it('reassures a past-due customer that Premium has not been cut off', () => {
    // UC-15: no hard lockout on the first failed payment, so the wording must
    // not imply one.
    expect(statusExplanation(detail({ status: 'past_due' }))).toContain('still on');
  });

  it('states the paid period for an active subscription', () => {
    expect(statusExplanation(detail({ status: 'active' }))).toContain('12 September 2027');
  });
});

describe('cancelWarning', () => {
  it('names the date before anyone confirms, and promises no refund', () => {
    const text = cancelWarning(detail());
    expect(text).toContain('12 September 2027');
    expect(text).toContain('nothing is refunded');
  });

  /** Cancelling takes nothing away before the period ends; the verb says so. */
  it('leads with what the customer keeps', () => {
    expect(cancelWarning(detail())).toMatch(/^You keep Premium until/);
  });
});

describe('planWithdrawn', () => {
  it('flags a plan version that is no longer published', () => {
    expect(planWithdrawn(detail())).toBe(false);
    expect(planWithdrawn(detail({ plan: { ...detail().plan, live: false } }))).toBe(true);
  });
});

describe('managesSubscription — who gets the management screen', () => {
  const overview = (commercial: unknown) =>
    ({ catalog: { asOf: '2026-10-04T00:00:00.000Z', plans: [], packs: [] }, commercial, actions: [] }) as never;

  it('a Premium customer manages, rather than shops', () => {
    expect(
      managesSubscription(
        overview({
          tier: { available: true, value: 'premium' },
          subscription: { available: true, value: { status: 'active' } },
        }),
      ),
    ).toBe(true);
  });

  it('a customer with no subscription is shopping', () => {
    expect(
      managesSubscription(
        overview({ tier: { available: true, value: 'free' }, subscription: { available: true, value: null } }),
      ),
    ).toBe(false);
  });

  /**
   * The case `premium` alone gets wrong: the plan version was withdrawn, so the
   * server reports no tier and no subscription -- but the customer still holds
   * one, and the plan selector would offer them a second the server refuses.
   */
  it('a subscription whose plan was withdrawn still manages', () => {
    expect(
      managesSubscription(
        overview({
          tier: { available: false, reason: 'subscription_unresolvable' },
          subscription: { available: false, reason: 'subscription_unresolvable' },
        }),
      ),
    ).toBe(true);
  });

  it('an unavailable wallet is not a subscription and changes nothing', () => {
    expect(
      managesSubscription(
        overview({
          tier: { available: true, value: 'free' },
          subscription: { available: false, reason: 'subscriptions_not_supported' },
        }),
      ),
    ).toBe(false);
  });

  it('says nothing when there is no overview yet', () => {
    expect(managesSubscription(null)).toBe(false);
    expect(managesSubscription(undefined)).toBe(false);
  });
});
