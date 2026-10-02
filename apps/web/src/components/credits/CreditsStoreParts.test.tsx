import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CustomerPackOffer, CustomerPaymentView } from '@over18/shared';
import { balanceState, packView, purchasablePacks, recommendedPack, returnTarget } from '../../lib/creditsStore';
import {
  BalanceCard,
  ContextNotice,
  DEFAULT_HERO,
  PackCard,
  PremiumNote,
  PurchaseResult,
  StoreHero,
} from './CreditsStoreParts';

/**
 * Credits Store PR 2 -- what the store's pieces show, rendered statically.
 * Every value is handed in, as the page hands in what the server said.
 */

const render = (node: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const NOW = Date.parse('2026-10-02T12:00:00Z');
const ASSET = '22c28c89-c759-4e03-a449-67aee69a04e3';
const CHARACTER = '6c904827-ba3b-4993-8d8f-454a2091fa83';

function pack(over: Partial<CustomerPackOffer> & { code: string }): CustomerPackOffer {
  const credits = over.credits ?? 100;
  const bonusCredits = over.bonusCredits ?? 0;
  return {
    version: 1, versionId: 'v', displayName: over.code, credits, priceMinor: 999, currency: 'USD', sortOrder: 0,
    isBestValue: false, isPurchasable: true, effectiveFrom: '2026-10-01T00:00:00.000000Z', badge: null,
    bonusCredits, totalCredits: credits + bonusCredits, wasPriceMinor: null, promotionEndsAt: null, ...over,
  };
}
const card = (p: CustomerPackOffer, recommended: CustomerPackOffer | null = null) =>
  render(<PackCard view={packView(p, NOW, recommended)} onSelect={() => undefined} />);

describe('the packs', () => {
  it('render only purchasable packs: a retired one never reaches the page', () => {
    const offered = purchasablePacks({ asOf: '', plans: [], packs: [pack({ code: 'starter' }), pack({ code: 'qa_plain', isPurchasable: false })] });
    const html = render(<>{offered.map((p) => <PackCard key={p.code} view={packView(p, NOW)} onSelect={() => undefined} />)}</>);
    expect(html).toContain('data-testid="pack-starter"');
    expect(html).not.toContain('qa_plain');
  });

  it('a CTA that says what is received, the price, and the bonus shown clearly', () => {
    const html = card(pack({ code: 'plus', displayName: 'Plus', credits: 750, bonusCredits: 100, priceMinor: 4999 }));
    expect(html).toContain('Get 850 Credits');
    expect(html).toContain('$49.99');
    expect(html).toContain('data-testid="pack-bonus"');
    expect(html).toContain('+100 bonus');
    expect(html).toContain('750 + 100 bonus');
    expect(html).not.toMatch(/>Buy</);
  });

  it('no bonus, no badge, no promotion: none of their marks', () => {
    const html = card(pack({ code: 'starter' }));
    for (const id of ['pack-bonus', 'pack-badge', 'pack-was-price', 'pack-countdown']) expect(html).not.toContain(`data-testid="${id}"`);
  });

  it('the badge the catalog configured -- never one of its own', () => {
    expect(card(pack({ code: 'plus', badge: 'Most popular' }))).toContain('Most popular');
    expect(card(pack({ code: 'plus' }))).not.toMatch(/most popular|best value/i);
  });

  it('a running promotion: struck-through regular price and a countdown', () => {
    const html = card(pack({ code: 'promo', priceMinor: 4999, wasPriceMinor: 7999, promotionEndsAt: '2026-10-02T14:14:37Z' }));
    expect(html).toMatch(/<s[^>]*data-testid="pack-was-price"[^>]*>\$79\.99<\/s>/);
    expect(html).toContain('$49.99');
    expect(html).toContain('Offer ends in 02:14:37');
  });

  it('an ended promotion: the regular price, nothing struck through, no countdown', () => {
    const html = card(pack({ code: 'ended', priceMinor: 4999, wasPriceMinor: 7999, promotionEndsAt: '2026-10-02T11:00:00Z' }));
    expect(html).toContain('$79.99');
    expect(html).not.toContain('pack-was-price');
    expect(html).not.toContain('Offer ends');
  });

  it('the recommended pack is highlighted; the others are not', () => {
    const plus = pack({ code: 'plus', isBestValue: true });
    const rec = recommendedPack([pack({ code: 'starter' }), plus]);
    expect(card(plus, rec)).toContain('data-recommended="true"');
    expect(card(pack({ code: 'starter' }), rec)).not.toContain('data-recommended');
  });
});

describe('the balance', () => {
  it.each([
    [0, 'zero', 're out of Credits'],
    [7, 'low', '7 Credits remaining'],
    [347, 'normal', 'Available to use now'],
  ] as const)('%i Credits reads as %s', (n, kind, text) => {
    const html = render(<BalanceCard balance={balanceState(n)} premium={false} />);
    expect(html).toContain(`data-balance="${kind}"`);
    expect(html).toContain(text);
  });

  it('a normal balance shows the one combined number, never the sources', () => {
    const html = render(<BalanceCard balance={balanceState(347)} premium />);
    expect(html).toContain('347');
    expect(html).not.toMatch(/bonus|purchased|included|earned/i);
  });

  it('Premium is a quiet chip on the balance -- for a subscriber only', () => {
    expect(render(<BalanceCard balance={balanceState(347)} premium />)).toContain('Premium');
    expect(render(<BalanceCard balance={balanceState(347)} premium={false} />)).not.toContain('Premium');
  });
});

describe('Premium and the Credit shortage', () => {
  it('the Premium note offers to view Premium -- secondary, and never "Subscribe"', () => {
    const html = render(<PremiumNote />);
    expect(html).toContain('Want unlimited conversations?');
    expect(html).toContain('href="/subscription"');
    expect(html).toContain('View Premium');
    expect(html).not.toMatch(/subscribe/i);
  });

  it('arriving short of Credits says why, and offers Credits -- not a subscription', () => {
    const html = render(<ContextNotice context={{ origin: 'profile', originAction: 'content_unlock', assetId: ASSET, conversationId: null, characterId: CHARACTER }} />);
    expect(html).toContain('You need a few more Credits');
    expect(html).not.toMatch(/subscribe|premium/i);
    expect(render(<ContextNotice context={null} />)).toBe('');
  });
});

describe('after the payment', () => {
  const payment = (over: Partial<CustomerPaymentView> = {}): CustomerPaymentView => ({
    id: 'f640d9f8-80a5-4e58-9d32-767c0382156b', status: 'succeeded', kind: 'credit_pack', productRef: 'plus', amountMinor: 4999,
    currency: 'USD', methodHint: 'apple_pay', provider: 'fake', createdAt: '', settledAt: '',
    pack: { packCode: 'plus', packVersion: 1, displayName: 'Plus', credits: 750, bonusCredits: 100, totalCredits: 850 },
    context: { origin: 'profile', originAction: 'content_unlock', assetId: ASSET, conversationId: null, characterId: CHARACTER },
    ...over,
  });

  it('Credits added: how many, the new balance, and the way back to what they were doing', () => {
    const p = payment();
    const html = render(<PurchaseResult outcome={{ kind: 'added', payment: p, balance: 1197 }} continueTo={returnTarget(p.context)} continueLabel="Continue to unlock" onDismiss={() => undefined} />);
    expect(html).toContain('Credits added!');
    expect(html).toContain('+850');
    expect(html).toContain('New balance: <strong class="text-white">1,197 Credits</strong>');
    expect(html).toContain(`href="/characters/${CHARACTER}?tab=posts&amp;unlock=${ASSET}"`);
    expect(html).toContain('Continue to unlock');
  });

  it('with nowhere to go back to, Continue stays in the store', () => {
    const html = render(<PurchaseResult outcome={{ kind: 'added', payment: payment({ context: null }), balance: 850 }} continueTo={null} continueLabel="Continue" onDismiss={() => undefined} />);
    expect(html).toContain('data-testid="purchase-continue"');
    expect(html).not.toContain('href=');
  });

  it('a payment that did not complete adds nothing, and says so', () => {
    const html = render(<PurchaseResult outcome={{ kind: 'not_completed', payment: payment({ status: 'failed' }) }} continueTo={null} continueLabel="Continue" onDismiss={() => undefined} />);
    expect(html).toContain('No payment was completed, so no Credits were added');
    expect(html).not.toContain('Credits added');
  });

  it('a payment still being confirmed is not called a success', () => {
    const html = render(<PurchaseResult outcome={{ kind: 'pending', payment: payment({ status: 'pending' }) }} continueTo={null} continueLabel="Continue" onDismiss={() => undefined} />);
    expect(html).toContain('still being confirmed');
    expect(html).not.toContain('Credits added');
  });
});

describe('the hero', () => {
  it('the approved default clip when there is no character to show, muted and looping', () => {
    const html = render(<StoreHero media={{ imageUrl: null, name: null }} />);
    expect(html).toContain(`src="${DEFAULT_HERO.video}"`);
    expect(html).toContain(`poster="${DEFAULT_HERO.poster}"`);
    expect(html).toMatch(/muted/);
    expect(html).toContain('Keep the experience going');
  });

  it('the character they came from, when there is one', () => {
    const html = render(<StoreHero media={{ imageUrl: 'https://api.example/media/camila.png', name: 'Camila' }} />);
    expect(html).toContain('data-testid="store-hero-image"');
    expect(html).toContain('alt="Camila"');
    expect(html).not.toContain(DEFAULT_HERO.video);
  });
});
