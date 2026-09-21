import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CustomerPlanOffer } from '@over18/shared';
import { CurrentPlanCard, PlanCatalog, PremiumBenefits } from './CustomerEconomy';
import type { CustomerEconomyOverview } from '../lib/customerEconomy';
import { bestValuePlan, formatMonthlyEquivalent, monthlyEquivalentMinor, savingsPercent } from '../lib/customerEconomy';

/**
 * The Premium screen (P9.3 redesign).
 *
 * The commercial facts are fixed by P1.D1 and are NOT this screen's to decide:
 * $12.99 a month, $29.99 a quarter, $89.99 a year, 200 Credits per cycle. What
 * these pin is that the screen renders those server figures faithfully, derives
 * only what can be derived from them, and never sells Premium to someone who
 * already has it.
 */

const plan = (over: Partial<CustomerPlanOffer>): CustomerPlanOffer =>
  ({
    code: 'premium_monthly',
    version: 1,
    versionId: 'v1',
    displayName: 'Premium Monthly',
    billingPeriodMonths: 1,
    priceMinor: 1299,
    currency: 'USD',
    monthlyIncludedCredits: 200,
    isPurchasable: true,
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    ...over,
  }) as CustomerPlanOffer;

const MONTHLY = plan({});
const QUARTERLY = plan({ code: 'premium_quarterly', displayName: 'Premium Quarterly', billingPeriodMonths: 3, priceMinor: 2999 });
const ANNUAL = plan({ code: 'premium_annual', displayName: 'Premium Annual', billingPeriodMonths: 12, priceMinor: 8999 });
const LADDER = [MONTHLY, QUARTERLY, ANNUAL];

const overviewOf = (over: Partial<CustomerEconomyOverview> = {}): CustomerEconomyOverview =>
  ({
    catalog: { asOf: '2026-09-22T00:00:00.000Z', plans: LADDER, packs: [] },
    commercial: null,
    actions: [],
    ...over,
  }) as unknown as CustomerEconomyOverview;

const freeViewer = overviewOf({
  commercial: {
    economyEnabled: true,
    tier: { available: true, value: 'free' },
    subscription: { available: true, value: null },
    wallet: { available: true, value: { included: 0, earned: 0, purchased: 0, held: 0, spendable: 0 } },
  },
} as unknown as Partial<CustomerEconomyOverview>);

const premiumViewer = overviewOf({
  commercial: {
    economyEnabled: true,
    tier: { available: true, value: 'premium' },
    subscription: {
      available: true,
      value: { status: 'active', planCode: 'premium_quarterly', currentPeriodEnd: '2026-12-21T00:00:00.000Z' },
    },
    wallet: { available: true, value: { included: 200, earned: 0, purchased: 0, held: 0, spendable: 175 } },
  },
} as unknown as Partial<CustomerEconomyOverview>);

const render = (node: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

/* ------------------------------------------------------------------ *
 * What can be derived from the server's prices -- and what cannot
 * ------------------------------------------------------------------ */

describe('the monthly equivalent and any saving', () => {
  it('says the same money per month, for each real billing period', () => {
    expect(formatMonthlyEquivalent(MONTHLY)).toBe('$12.99 a month');
    expect(formatMonthlyEquivalent(QUARTERLY)).toBe('$10.00 a month');
    expect(formatMonthlyEquivalent(ANNUAL)).toBe('$7.50 a month');
  });

  it('is arithmetic on the server price, never a second price', () => {
    expect(monthlyEquivalentMinor(QUARTERLY)).toBeCloseTo(2999 / 3, 6);
    expect(monthlyEquivalentMinor(plan({ billingPeriodMonths: 0 }))).toBeNull();
  });

  it('states a saving only where one can actually be computed', () => {
    expect(savingsPercent(LADDER, MONTHLY), 'the baseline cannot save against itself').toBeNull();
    expect(savingsPercent(LADDER, QUARTERLY)).toBe(23);
    expect(savingsPercent(LADDER, ANNUAL)).toBe(42);
    // Nothing to compare against, a different currency, or no saving at all.
    expect(savingsPercent([QUARTERLY], QUARTERLY)).toBeNull();
    expect(savingsPercent(LADDER, plan({ billingPeriodMonths: 12, priceMinor: 20000, currency: 'EUR' }))).toBeNull();
    expect(savingsPercent(LADDER, plan({ code: 'x', billingPeriodMonths: 12, priceMinor: 999999 }))).toBeNull();
  });

  it('features the genuinely cheapest month', () => {
    expect(bestValuePlan(LADDER)?.code).toBe('premium_annual');
    expect(bestValuePlan([])).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The plan selector
 * ------------------------------------------------------------------ */

describe('choosing a billing period', () => {
  it('is one choice with three options, not three competing offers', () => {
    const html = render(<PlanCatalog overview={freeViewer} onBuy={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/data-testid="plan-/g)).toHaveLength(3);
    // Exactly one primary CTA on the whole selector.
    expect(html.match(/Choose /g)).toHaveLength(1);
  });

  it('reads shortest commitment first, whatever order the catalogue returns', () => {
    const jumbled = overviewOf({
      catalog: { asOf: 'x', plans: [ANNUAL, MONTHLY, QUARTERLY], packs: [] },
    } as unknown as Partial<CustomerEconomyOverview>);
    const html = render(<PlanCatalog overview={jumbled} onBuy={() => {}} />);
    const order = [...html.matchAll(/data-testid="plan-([a-z_]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['premium_monthly', 'premium_quarterly', 'premium_annual']);
  });

  it('pre-selects the best value and names it on the button, with its price', () => {
    const html = render(<PlanCatalog overview={freeViewer} onBuy={() => {}} />);
    expect(html).toContain('data-testid="plan-premium_annual" data-selected="true"');
    expect(html).toContain('Choose Annual');
    expect(html).toContain('$89.99 / year');
    expect(html).toContain('Best value');
  });

  it('shows every real price and monthly equivalent from the server', () => {
    const html = render(<PlanCatalog overview={freeViewer} onBuy={() => {}} />);
    for (const fact of ['$12.99 / month', '$29.99 / 3 months', '$89.99 / year', '$12.99 a month', '$10.00 a month', '$7.50 a month']) {
      expect(html, fact).toContain(fact);
    }
    expect(html).toContain('Save 23%');
    expect(html).toContain('Save 42%');
  });

  it('states the included Credits once, not once per plan', () => {
    const html = render(<PlanCatalog overview={freeViewer} onBuy={() => {}} />);
    expect(html.match(/200 Credits/g), 'the same fact three times is noise on a phone').toHaveLength(1);
  });

  it('states them per plan when the plans actually differ', () => {
    const mixed = overviewOf({
      catalog: { asOf: 'x', plans: [MONTHLY, plan({ code: 'premium_annual', billingPeriodMonths: 12, priceMinor: 8999, monthlyIncludedCredits: 500 })], packs: [] },
    } as unknown as Partial<CustomerEconomyOverview>);
    const html = render(<PlanCatalog overview={mixed} onBuy={() => {}} />);
    expect(html).toContain('200 Credits each cycle');
    expect(html).toContain('500 Credits each cycle');
  });

  /**
   * A PREMIUM CUSTOMER IS NOT SOLD PREMIUM. The server refuses a second
   * subscription with 409 `already_subscribed`, so offering one would be an
   * offer that cannot be accepted.
   */
  it('marks the plan a subscriber already has and offers them nothing', () => {
    const html = render(<PlanCatalog overview={premiumViewer} onBuy={() => {}} />);
    expect(html).toContain('data-testid="plan-premium_quarterly" data-selected="true"');
    expect(html).toContain('Your plan');
    expect(html).toContain('data-testid="already-premium"');
    expect(html).not.toContain('Choose ');
    expect(html).not.toContain('Subscribing isn’t available yet');
  });

  it('still says plainly when nobody can buy, which is a different thing', () => {
    const html = render(<PlanCatalog overview={freeViewer} />);
    expect(html).toContain('Subscribing isn’t available yet');
    expect(html).not.toContain('data-testid="already-premium"');
  });

  it('invents no plan when the catalogue is empty', () => {
    const html = render(<PlanCatalog overview={overviewOf({ catalog: { asOf: 'x', plans: [], packs: [] } } as unknown as Partial<CustomerEconomyOverview>)} onBuy={() => {}} />);
    expect(html).toContain('No plans are offered right now.');
    expect(html).not.toMatch(/\$\d/);
  });
});

/* ------------------------------------------------------------------ *
 * Current plan, and the balance shown once
 * ------------------------------------------------------------------ */

describe('the current plan section', () => {
  it('names Free plainly, with the balance once', () => {
    const html = render(<CurrentPlanCard overview={freeViewer} />);
    expect(html).toContain('data-tier="free"');
    expect(html).toContain('Free');
    expect(html.match(/Credits/g)).toHaveLength(1);
  });

  it('names the subscriber plan and when it renews', () => {
    const html = render(<CurrentPlanCard overview={premiumViewer} />);
    expect(html).toContain('data-tier="premium"');
    expect(html).toContain('Premium Quarterly');
    expect(html).toContain('Renews');
    expect(html).toContain('175');
  });

  it('says a cancelled subscription ends rather than renews', () => {
    const cancelled = overviewOf({
      commercial: {
        economyEnabled: true,
        tier: { available: true, value: 'premium' },
        subscription: { available: true, value: { status: 'cancelled', planCode: 'premium_quarterly', currentPeriodEnd: '2026-12-21T00:00:00.000Z' } },
        wallet: { available: false },
      },
    } as unknown as Partial<CustomerEconomyOverview>);
    const html = render(<CurrentPlanCard overview={cancelled} />);
    expect(html).toContain('Premium until');
    expect(html).not.toContain('Renews');
  });

  it('claims neither tier nor balance when the server has not said', () => {
    const html = render(<CurrentPlanCard overview={overviewOf()} />);
    expect(html).toContain('Not available yet');
    expect(html).not.toMatch(/>Free<|>Premium</);
    // No balance at all rather than a zero: the Credits figure is simply absent.
    expect(html, 'an unknown balance is never rendered as zero').not.toContain('Credits');
  });
});

/* ------------------------------------------------------------------ *
 * What Premium includes
 * ------------------------------------------------------------------ */

describe('the benefits list', () => {
  it('states the four supported facts, with the Credits figure from the server', () => {
    const html = render(<PremiumBenefits overview={freeViewer} />);
    expect(html).toContain('Unlimited text chat');
    expect(html).toContain('Premium content included while your plan is active');
    expect(html).toContain('200 Credits every billing cycle');
    expect(html).toContain('Spend Credits on anything priced in Credits');
    expect(html.match(/<li/g)).toHaveLength(4);
  });

  it('follows the server rather than a constant', () => {
    const richer = overviewOf({
      catalog: { asOf: 'x', plans: [plan({ monthlyIncludedCredits: 500 })], packs: [] },
    } as unknown as Partial<CustomerEconomyOverview>);
    expect(render(<PremiumBenefits overview={richer} />)).toContain('500 Credits every billing cycle');
  });

  it('promises nothing at all without a plan to read', () => {
    const html = render(<PremiumBenefits overview={overviewOf({ catalog: { asOf: 'x', plans: [], packs: [] } } as unknown as Partial<CustomerEconomyOverview>)} />);
    expect(html).toBe('');
  });
});
