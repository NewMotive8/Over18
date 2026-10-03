import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CustomerEconomyOverview, CustomerEconomyState } from '../../lib/customerEconomy';
import { FunnelIntro, FunnelPlans } from './PremiumFunnel';

/**
 * The Premium feed funnel: Step 1 (the Premium moment) and Step 2 (the plans,
 * in place), built from the EXISTING plan selector, payment sheet and checkout.
 */

const render = (node: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const src = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(join(src, rel), 'utf8');

const plan = (code: string, months: number, priceMinor: number) => ({
  code, version: 1, versionId: code, displayName: `Premium ${code}`, billingPeriodMonths: months, priceMinor,
  currency: 'USD', monthlyIncludedCredits: 200, isPurchasable: true, effectiveFrom: '',
});
const overview = (tier: 'free' | 'premium' = 'free') =>
  ({
    commercial: { viewer: { userId: 'u' }, tier: { available: true, value: tier }, subscription: { available: true, value: null } },
    catalog: { asOf: '', plans: [plan('premium_monthly', 1, 1299), plan('premium_quarterly', 3, 2999), plan('premium_annual', 12, 8999)], packs: [] },
    actions: [],
  }) as unknown as CustomerEconomyOverview;
const ready = (tier: 'free' | 'premium' = 'free'): CustomerEconomyState => ({ status: 'ready', overview: overview(tier) });
const noop = () => undefined;

describe('Step 1 -- the Premium moment', () => {
  const html = render(<FunnelIntro overview={overview()} onUnlock={noop} onClose={noop} />);

  it('a strong headline, a short explanation and one primary action', () => {
    expect(html).toContain('Premium only');
    expect(html).toMatch(/This feed is for .*Premium.* eyes only/);
    expect(html).toContain('You&rsquo;ve met your 10 free companions'.replace('&rsquo;', '’'));
    expect(html).toMatch(/data-testid="premium-funnel-unlock"[^>]*>.*Unlock Premium Now/);
    expect(html).toContain('Not now');
  });

  it("Premium's benefits are the product's own facts, with the catalog's Credits figure", () => {
    expect(html).toContain('Unlimited text chat');
    expect(html).toContain('200 Credits every billing cycle');
  });

  it('no link anywhere -- and never to /subscription', () => {
    expect(html).not.toMatch(/href=/);
  });

  it('no invented urgency or social proof', () => {
    expect(html).not.toMatch(/watching|% off|ends in|hurry|left at this price/i);
  });
});

describe('Step 2 -- the Premium offer, in place', () => {
  const offer = () => render(<FunnelPlans state={ready()} onBack={noop} onClose={noop} onChoose={noop} />);

  it('a Premium visual, an exciting headline and a short value proposition -- not a settings form', () => {
    const html = offer();
    expect(html).toMatch(/<img[^>]*src="\/media\/store\/default-hero-poster\.jpg"/);
    expect(html).toMatch(/Unlock .*everything/);
    expect(html).toContain('Every companion, every Premium post and conversations without limits.');
    expect(html).not.toMatch(/Choose your plan|type="radio"|Billing period/);
  });

  it("a checklist of the product's real Premium benefits", () => {
    const html = offer();
    expect(html).toContain('data-testid="premium-offer-benefits"');
    for (const fact of ['Unlimited text chat', 'Premium content included while your plan is active', '200 Credits every billing cycle', 'Spend Credits on anything priced in Credits']) {
      expect(html).toContain(fact);
    }
  });

  it('the three real plans as offer cards, shortest first, with the per-month price big and the billed price small', () => {
    const html = offer();
    const order = ['premium_monthly', 'premium_quarterly', 'premium_annual'].map((code) => html.indexOf(`data-testid="offer-${code}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const label of ['1 month', '3 months', '12 months']) expect(html).toContain(label);
    // Per month (derived from the catalog price) and what is actually billed.
    expect(html).toContain('$12.99');
    expect(html).toContain('$10.00');
    expect(html).toContain('$7.50');
    for (const billed of ['$12.99 / month', '$29.99 / 3 months', '$89.99 / year']) expect(html).toContain(billed);
    expect(html).toContain('Save 23%');
    expect(html).toContain('Save 42%');
  });

  it('the best-value plan is obvious and chosen by default; ONE CTA carries its terms', () => {
    const html = offer();
    expect(html.match(/data-testid="offer-best"/g)).toHaveLength(1);
    expect(html).toMatch(/data-testid="offer-premium_annual"[^>]*data-best="true"|data-best="true"[^>]*data-testid="offer-premium_annual"/);
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="offer-premium_annual"/);
    expect(html.match(/data-testid="premium-offer-continue"/g)).toHaveLength(1);
    expect(html).toMatch(/Continue · 12 months for \$89\.99/);
  });

  it('a way back to Step 1, and a way out', () => {
    const html = offer();
    expect(html).toContain('data-testid="premium-funnel-back"');
    expect(html).toContain('aria-label="Close"');
  });

  it('never a link to /subscription', () => {
    expect(offer()).not.toContain('/subscription');
  });

  it('no invented urgency, social proof or discount', () => {
    expect(offer()).not.toMatch(/watching|% off|ends in|hurry|limited time|only today/i);
  });

  it('a Premium customer is not sold Premium (as on the Premium page)', () => {
    const html = render(<FunnelPlans state={ready('premium')} onBack={noop} onClose={noop} onChoose={noop} />);
    expect(html).toContain('data-testid="already-premium"');
    expect(html).not.toMatch(/premium-offer-continue|data-testid="offer-/);
  });

  it('while the plans load or fail, the existing notice -- no invented plan', () => {
    expect(render(<FunnelPlans state={{ status: 'loading' }} onBack={noop} onClose={noop} onChoose={noop} />)).not.toMatch(/data-testid="offer-|premium-offer-continue/);
  });
});

describe('one checkout, not two', () => {
  const funnel = read('components/premium/PremiumFunnel.tsx');

  it("the offer is built from the existing catalog and the same selectors the Premium page's PlanCatalog uses", () => {
    for (const selector of ['offeredPlans(overview)', 'bestValuePlan(plans)', 'savingsPercent(plans, plan)', 'monthlyEquivalentMinor(plan)', 'formatPlanPrice(plan)', 'premiumBenefitFacts(overview)']) {
      expect(funnel).toContain(selector);
    }
  });

  it('reuses the payment-method sheet and the existing checkout hook', () => {
    expect(funnel).toMatch(/<PaymentMethodSheet/);
    expect(funnel).toMatch(/const checkout = useCheckout\(\);/);
    expect(funnel).toMatch(/checkout\.start\(plan\.code, method\)/);
    // No payments API call of its own, no price sent, no second implementation.
    expect(funnel).not.toMatch(/paymentsApi|startCheckout\(|priceMinor:/);
  });

  it('the Premium page keeps its own selector, unchanged', () => {
    expect(read('pages/SubscriptionPage.tsx')).toMatch(/<PlanCatalog/);
  });

  it('never navigates to /subscription itself', () => {
    // No string literal names the route (the doc comment's prose mention is not code).
    expect(funnel).not.toMatch(/['"]\/subscription/);
    expect(funnel).not.toMatch(/navigate\(\s*`\/subscription/);
  });
});

describe('wired into both surfaces', () => {
  it('Home: the gated feed, the locked end card and the funnel', () => {
    const lobby = read('pages/LobbyPage.tsx');
    expect(lobby).toMatch(/usePremiumGate\('home_feed'\)/);
    expect(lobby).toMatch(/feedWindow\(gridClips, gate\.seen\)/);
    expect(lobby).toMatch(/<FeedGate onContinue=\{openFunnel\} \/>/);
    expect(lobby).toMatch(/<PremiumFunnel open=\{funnelOpen\} surface="home_feed"/);
  });

  it('Swipe: the card on screen counts, #11 is never shown -- not even as the peek -- and the funnel opens', () => {
    const swipe = read('pages/SwipePage.tsx');
    expect(swipe).toMatch(/usePremiumGate\('swipe'\)/);
    expect(swipe).toMatch(/gate\.record\(\[current\.id\]\)/);
    expect(swipe).toMatch(/canMeet\(metWithCurrent, upcoming\.id\)/);
    expect(swipe).toMatch(/if \(blocked\) setFunnelOpen\(true\)/);
    expect(swipe).toMatch(/<PremiumFunnel open=\{funnelOpen\} surface="swipe"/);
  });

  it('both wait (skeleton) while it is not yet known whether the gate applies', () => {
    expect(read('pages/LobbyPage.tsx')).toMatch(/gate\.pending \?/);
    expect(read('pages/SwipePage.tsx')).toMatch(/state\.status === 'loading' \|\| gate\.pending/);
  });
});
