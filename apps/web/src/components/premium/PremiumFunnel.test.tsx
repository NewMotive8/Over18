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

describe('Step 2 -- the plans, in place', () => {
  it('the existing plan selector: every offered plan, the best value marked, one clear action', () => {
    const html = render(<FunnelPlans state={ready()} onBack={noop} onClose={noop} onChoose={noop} />);
    for (const code of ['premium_monthly', 'premium_quarterly', 'premium_annual']) expect(html).toContain(`data-testid="plan-${code}"`);
    expect(html).toContain('Best value');
    expect(html).toContain('$12.99 / month');
    expect(html).toMatch(/data-testid="buy-premium_[a-z]+"/);
    expect(html).toContain('Choose your plan');
  });

  it('a way back to Step 1, and a way out', () => {
    const html = render(<FunnelPlans state={ready()} onBack={noop} onClose={noop} onChoose={noop} />);
    expect(html).toContain('data-testid="premium-funnel-back"');
    expect(html).toContain('aria-label="Close"');
  });

  it('never a link to /subscription', () => {
    expect(render(<FunnelPlans state={ready()} onBack={noop} onClose={noop} onChoose={noop} />)).not.toContain('/subscription');
  });

  it('a Premium customer is not sold Premium (the selector refuses, as on the Premium page)', () => {
    const html = render(<FunnelPlans state={ready('premium')} onBack={noop} onClose={noop} onChoose={noop} />);
    expect(html).toContain('data-testid="already-premium"');
    expect(html).not.toMatch(/data-testid="buy-/);
  });

  it('while the plans load or fail, the existing notice -- no invented plan', () => {
    expect(render(<FunnelPlans state={{ status: 'loading' }} onBack={noop} onClose={noop} onChoose={noop} />)).not.toMatch(/plan-premium/);
  });
});

describe('one checkout, not two', () => {
  const funnel = read('components/premium/PremiumFunnel.tsx');

  it('reuses the plan selector, the payment-method sheet and the existing checkout hook', () => {
    expect(funnel).toMatch(/<PlanCatalog overview=\{state\.overview\} onBuy=\{onChoose\} \/>/);
    expect(funnel).toMatch(/<PaymentMethodSheet/);
    expect(funnel).toMatch(/const checkout = useCheckout\(\);/);
    expect(funnel).toMatch(/checkout\.start\(plan\.code, method\)/);
    // No payments API call of its own, no price sent, no second implementation.
    expect(funnel).not.toMatch(/paymentsApi|startCheckout\(|priceMinor:/);
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
