import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CustomerPackOffer, CustomerPaymentView } from '@over18/shared';
import { balanceState, packView, purchasablePacks, recommendedPack, returnTarget, storeHeroCopy } from '../../lib/creditsStore';
import {
  BalanceLine,
  DEFAULT_HERO,
  PackCard,
  PremiumAnchor,
  PurchaseCta,
  PurchaseResult,
  StickyPurchaseBar,
  StoreHero,
  TrustRow,
} from './CreditsStoreParts';

/**
 * The Credits Store's pieces, rendered statically (PR 2 + store conversion).
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
const card = (p: CustomerPackOffer, extra: { recommended?: CustomerPackOffer | null; selected?: boolean; saving?: number | null; unlocks?: boolean } = {}) =>
  render(
    <PackCard
      view={packView(p, NOW, extra.recommended ?? null)}
      selected={extra.selected ?? false}
      savingPercent={extra.saving ?? null}
      unlocksThis={extra.unlocks ?? false}
      onSelect={() => undefined}
    />,
  );

describe('the packs', () => {
  it('render only purchasable packs: a retired one never reaches the page', () => {
    const offered = purchasablePacks({ asOf: '', plans: [], packs: [pack({ code: 'starter' }), pack({ code: 'qa_plain', isPurchasable: false })] });
    const html = render(<>{offered.map((p) => <PackCard key={p.code} view={packView(p, NOW)} selected={false} onSelect={() => undefined} />)}</>);
    expect(html).toContain('data-testid="pack-starter"');
    expect(html).not.toContain('qa_plain');
  });

  it('a card is a CHOICE (no buy button of its own) and says what is received, the price and the bonus as "+N free"', () => {
    const html = card(pack({ code: 'plus', credits: 750, bonusCredits: 75, priceMinor: 4999 }));
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*data-testid="pack-plus"/);
    expect(html).toContain('aria-label="Get 825 Credits · $49.99"');
    expect(html).toContain('$49.99');
    expect(html).toContain('+75 free');
    expect(html).toContain('750 + 75 free');
    expect(html).not.toMatch(/>Buy</);
    // One button, the card itself: no nested purchase button.
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('the saving and "Unlocks this ✓" appear only when they are handed in', () => {
    const html = card(pack({ code: 'plus' }), { saving: 39, unlocks: true });
    expect(html).toContain('Save 39%');
    expect(html).toContain('Unlocks this ✓');
    const plain = card(pack({ code: 'plus' }));
    for (const id of ['pack-saving', 'pack-unlocks-this', 'pack-bonus', 'pack-badge', 'pack-was-price', 'pack-countdown']) {
      expect(plain).not.toContain(`data-testid="${id}"`);
    }
  });

  it('the badge the catalog configured; "Recommended" only on the recommended pack without one', () => {
    expect(card(pack({ code: 'plus', badge: 'Most popular' }))).toContain('Most popular');
    const plus = pack({ code: 'plus' });
    expect(card(plus, { recommended: plus })).toContain('Recommended');
    expect(card(pack({ code: 'starter' }), { recommended: plus })).not.toMatch(/recommended|most popular|best value/i);
  });

  it('a running promotion: struck-through regular price and a countdown; an ended one: neither', () => {
    const running = card(pack({ code: 'promo', priceMinor: 4999, wasPriceMinor: 7999, promotionEndsAt: '2026-10-02T14:14:37Z' }));
    expect(running).toMatch(/<s[^>]*data-testid="pack-was-price"[^>]*>\$79\.99<\/s>/);
    expect(running).toContain('Offer ends in 02:14:37');
    const ended = card(pack({ code: 'ended', priceMinor: 4999, wasPriceMinor: 7999, promotionEndsAt: '2026-10-02T11:00:00Z' }));
    expect(ended).toContain('$79.99');
    expect(ended).not.toContain('pack-was-price');
    expect(ended).not.toContain('Offer ends');
  });

  it('the recommended pack is the wide primary card; the selected one is marked', () => {
    const plus = pack({ code: 'plus', isBestValue: true });
    const rec = recommendedPack([pack({ code: 'starter' }), plus]);
    expect(card(plus, { recommended: rec })).toMatch(/data-recommended="true"[^>]*class="[^"]*col-span-2/);
    expect(card(pack({ code: 'starter' }), { recommended: rec })).not.toContain('data-recommended');
    expect(card(plus, { recommended: rec, selected: true })).toContain('aria-pressed="true"');
  });
});

describe('buying the selected pack', () => {
  const view = packView(pack({ code: 'plus', credits: 750, bonusCredits: 75, priceMinor: 4999 }), NOW);

  it('the desktop CTA carries the selected pack and its catalog price -- and is desktop-only', () => {
    const html = render(<PurchaseCta view={view} onBuy={() => undefined} />);
    expect(html).toContain('Get 825 Credits · $49.99');
    expect(html).toMatch(/data-testid="store-cta"[^>]*class="[^"]*\bhidden\b[^"]*\blg:flex\b/);
  });

  it('the sticky bar on a phone: the pack, its price and Continue -- fixed above the safe area, hidden on desktop', () => {
    const html = render(<StickyPurchaseBar view={view} onBuy={() => undefined} />);
    expect(html).toContain('825 Credits');
    expect(html).toContain('$49.99');
    expect(html).toContain('>Continue<');
    expect(html).toContain('aria-label="Get 825 Credits · $49.99"');
    expect(html).toMatch(/data-testid="store-sticky-bar"[^>]*class="[^"]*\bfixed\b[^"]*bottom-0[^"]*safe-area-inset-bottom[^"]*\blg:hidden\b/);
  });

  it('with nothing selected, neither renders', () => {
    expect(render(<PurchaseCta view={null} onBuy={() => undefined} />)).toBe('');
    expect(render(<StickyPurchaseBar view={null} onBuy={() => undefined} />)).toBe('');
  });

  it('the trust row claims only what the payment architecture supports', () => {
    const html = render(<TrustRow />);
    expect(html).toContain('Added instantly');
    expect(html).toContain('Secure checkout');
    // No processor is chosen yet, so no statement descriptor can be promised.
    expect(html).not.toMatch(/discreet|anonymous|untraceable/i);
  });
});

describe('the balance, in one line', () => {
  it.each([
    [0, 'zero', "You're out of Credits: top up to keep going."],
    [5, 'low', 'Only 5 left: top up to keep going.'],
    [347, 'normal', 'You have 347 Credits'],
  ] as const)('%i Credits reads as %s', (n, kind, text) => {
    const html = render(<BalanceLine balance={balanceState(n)} premium={false} />);
    expect(html).toContain(`data-balance="${kind}"`);
    expect(html).toContain(text.replace("'", '&#x27;'));
  });

  it('one combined number, never the sources; Premium a quiet mark for a subscriber only', () => {
    const html = render(<BalanceLine balance={balanceState(347)} premium />);
    expect(html).not.toMatch(/bonus|purchased|included|earned/i);
    expect(html).toContain('Premium');
    expect(render(<BalanceLine balance={balanceState(347)} premium={false} />)).not.toContain('Premium');
  });
});

describe('Premium as a value anchor', () => {
  it("the catalog's numbers, linking to Premium -- secondary, and never \"Subscribe\"", () => {
    const html = render(<PremiumAnchor anchor={{ credits: 200, price: '$12.99' }} />);
    expect(html).toContain('Better value:');
    expect(html).toContain('Premium gives you 200 Credits every');
    expect(html).toContain('month + unlimited chat, $12.99/mo');
    expect(html).toContain('href="/subscription"');
    expect(html).not.toMatch(/subscribe/i);
  });

  it('renders nothing when there is no anchor (a subscriber, or no plan to quote)', () => {
    expect(render(<PremiumAnchor anchor={null} />)).toBe('');
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

  it('REGRESSION (staging QA): a refreshed or revisited completed payment says the purchase is complete -- never "Credits added"', () => {
    const p = payment();
    const html = render(<PurchaseResult outcome={{ kind: 'already_added', payment: p }} continueTo={returnTarget(p.context)} continueLabel="Continue to unlock" onDismiss={() => undefined} />);
    expect(html).toContain('data-outcome="already_added"');
    expect(html).toContain('Purchase complete');
    expect(html).toContain('The 850 Credits from this purchase are already in your balance.');
    expect(html).not.toMatch(/Credits added|\+850|New balance/);
    // The way back still works, so a revisit is not a dead end.
    expect(html).toContain(`href="/characters/${CHARACTER}?tab=posts&amp;unlock=${ASSET}"`);
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
  it('the approved default clip when there is no character to show, muted and looping, with the generic line', () => {
    const html = render(<StoreHero media={{ imageUrl: null, name: null }} copy={storeHeroCopy({ characterName: null, unlock: null })} />);
    expect(html).toContain(`src="${DEFAULT_HERO.video}"`);
    expect(html).toContain(`poster="${DEFAULT_HERO.poster}"`);
    expect(html).toMatch(/muted/);
    expect(html).toContain('Keep the experience going');
  });

  it('a known character: her image and "She\'s waiting for you"; about 300px tall on a phone', () => {
    const html = render(<StoreHero media={{ imageUrl: 'https://api.example/media/camila.png', name: 'Camila' }} copy={storeHeroCopy({ characterName: 'Camila', unlock: null })} />);
    expect(html).toContain('data-testid="store-hero-image"');
    expect(html).toContain('alt="Camila"');
    expect(html).not.toContain(DEFAULT_HERO.video);
    expect(html).toContain('She&#x27;s waiting for you');
    expect(html).toMatch(/data-testid="store-hero"[^>]*class="[^"]*h-\[18\.75rem\]/);
  });

  it('arriving to unlock: the post and what it still needs -- her own hero image, never the post itself', () => {
    const copy = storeHeroCopy({ characterName: 'Amara', unlock: { mediaType: 'video', creditsNeeded: 20 } });
    const html = render(<StoreHero media={{ imageUrl: 'https://api.example/media/amara.png', name: 'Amara' }} copy={copy} />);
    expect(html).toContain('Unlock Amara&#x27;s private video');
    expect(html).toContain('You need 20 more Credits.');
    expect(html).toContain('src="https://api.example/media/amara.png"');
  });

  it('decorative coins are still: no spinning, no slot effects', () => {
    const html = render(<StoreHero media={{ imageUrl: null, name: null }} copy={storeHeroCopy({ characterName: null, unlock: null })} />);
    expect(html).not.toMatch(/animate-spin|animate-bounce|slot|jackpot/i);
  });
});
