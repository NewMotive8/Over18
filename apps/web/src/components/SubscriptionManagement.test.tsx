import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CustomerSubscriptionDetail } from '@over18/shared';
import { SubscriptionDetailView } from './SubscriptionManagement';

/**
 * The subscription MANAGEMENT screen, in every state the server can produce.
 *
 * What these pin is the thing the redesign was for: a customer who has already
 * paid is shown what they hold and one honest action, never a plan selector.
 * The view is pure and takes the server's own answer as a prop, so each state is
 * reachable in a static render -- the repo has no DOM test stack on purpose.
 *
 * What they cannot cover: the fetch and the cancel request themselves, which
 * need effects. Those are covered by the API suite against the real endpoints.
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

const render = (props: Parameters<typeof SubscriptionDetailView>[0]) =>
  renderToStaticMarkup(<SubscriptionDetailView {...props} />);

/** `&`, `’` and friends come back escaped; compare against what a reader sees. */
const decode = (html: string) =>
  html
    .replace(/&amp;/g, '&')
    .replace(/&middot;/g, '·')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

describe('an active subscriber sees what they hold', () => {
  const html = decode(render({ detail: detail() }));

  it('names the plan, its price and its billing period', () => {
    expect(html).toContain('Premium Annual');
    expect(html).toContain('$89.99 / year');
    expect(html).toContain('Annual');
  });

  it('states the status in words', () => {
    expect(html).toContain('Active');
  });

  it('states the paid period, the included Credits, the start and what was paid', () => {
    expect(html).toContain('Paid through');
    expect(html).toContain('12 September 2027');
    expect(html).toContain('200 each billing cycle');
    expect(html).toContain('12 September 2026');
    expect(html).toContain('$89.99 on 12 September 2026');
  });

  /**
   * THE BUG THE REDESIGN EXISTS TO FIX. The old card labelled this date
   * "Renews", and nothing in the system renews a subscription.
   */
  it('never claims the subscription renews', () => {
    expect(html).not.toMatch(/renew/i);
  });

  it('offers cancelling, and nothing else', () => {
    expect(html).toContain('Cancel Premium');
    // The two capabilities the backend does not have must not be implied.
    expect(html).not.toMatch(/change plan|change your plan|switch plan/i);
    expect(html).not.toMatch(/resume/i);
  });

  /** A management screen is not a shop: no selector, no price ladder, no CTA to buy. */
  it('shows no plan selector and nothing to buy', () => {
    expect(html).not.toContain('radiogroup');
    expect(html).not.toMatch(/Best value|Save \d+%|Choose /);
  });
});

describe('cancelling', () => {
  it('names the exact date and the no-refund rule before anything is confirmed', () => {
    const html = decode(render({ detail: detail(), cancelling: { status: 'confirming' } }));
    expect(html).toContain('You keep Premium until 12 September 2027');
    expect(html).toContain('nothing is refunded');
    expect(html).toContain('Yes, cancel Premium');
    expect(html).toContain('No, keep my subscription');
  });

  /** Two buttons that both cancel would be a trap; the confirm replaces the trigger. */
  it('hides the trigger while the confirmation is open', () => {
    const html = render({ detail: detail(), cancelling: { status: 'confirming' } });
    expect(html).toContain('cancel-confirm-yes');
    expect(html).not.toContain('data-testid="cancel-premium"');
  });

  it('says nothing changed when the request failed', () => {
    const html = render({ detail: detail(), cancelling: { status: 'failed', message: 'Nope, nothing changed.' } });
    expect(html).toContain('Nope, nothing changed.');
  });
});

describe('an already-cancelled subscription', () => {
  const cancelled = detail({ status: 'cancelled', cancelAtPeriodEnd: true, canCancel: false });
  const html = decode(render({ detail: cancelled }));

  it('says when Premium stops rather than that it is simply off', () => {
    expect(html).toContain('Premium until');
    expect(html).toContain('12 September 2027');
    expect(html).toContain('will not continue');
  });

  it('does not offer cancelling twice', () => {
    expect(html).not.toContain('Cancel Premium');
  });

  /**
   * Resuming is not offered because `subscriptionActions` has no transition from
   * cancelled back to active. A "Keep Premium" button here would do nothing.
   */
  it('offers no resume, because the backend has none', () => {
    expect(html).not.toMatch(/resume|reactivate|keep premium/i);
  });
});

describe('a withdrawn plan', () => {
  it('tells the customer their plan is no longer offered', () => {
    const html = decode(render({ detail: detail({ plan: { ...detail().plan, live: false } }) }));
    expect(html).toContain('no longer offered');
    expect(html).toContain('contact support');
  });
});

describe('facts the server does not have', () => {
  /** An absent fact is reported as absent, never guessed at or silently dropped. */
  it('says so instead of leaving the row blank', () => {
    const html = render({ detail: detail({ startedAt: null, lastPayment: null }) });
    expect(html).toContain('Not recorded');
    expect(html).toContain('No payment recorded');
  });
});
