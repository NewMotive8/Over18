import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomerEconomyCatalog, CustomerPackOffer, CustomerPlanOffer } from '@over18/shared';
import {
  CREDITS_CHANGED_EVENT,
  LOW_BALANCE,
  announceCreditsChanged,
  balanceState,
  creditsStoreHref,
  formatCountdown,
  heroCharacterId,
  lastCharacter,
  mayAutoUnlock,
  packCheckoutRequest,
  packView,
  pendingPayment,
  pendingUnlock,
  purchasablePacks,
  readStoreContext,
  recommendedPack,
  resumeUnlockAction,
  returnOutcome,
  returnTarget,
  balanceLine,
  packCtaLabel,
  packSavings,
  packThatUnlocks,
  premiumAnchor,
  storeHeroCopy,
} from './creditsStore';
import { afterCheckoutPath } from './payments';

/**
 * Credits Store PR 2 -- the store's rules, without a browser.
 *
 * Every pack here is a catalog answer as the server would send it; nothing is
 * priced by these tests or by the code under test.
 */

const ASSET = '22c28c89-c759-4e03-a449-67aee69a04e3';
const CHARACTER = '6c904827-ba3b-4993-8d8f-454a2091fa83';
const CONVERSATION = '0b6f4d2e-1c3a-4b5d-9e8f-7a6b5c4d3e2f';

function pack(over: Partial<CustomerPackOffer> & { code: string }): CustomerPackOffer {
  const credits = over.credits ?? 100;
  const bonusCredits = over.bonusCredits ?? 0;
  return {
    version: 1,
    versionId: `v-${over.code}`,
    displayName: over.code,
    credits,
    priceMinor: 999,
    currency: 'USD',
    sortOrder: 0,
    isBestValue: false,
    isPurchasable: true,
    effectiveFrom: '2026-10-01T00:00:00.000000Z',
    badge: null,
    bonusCredits,
    totalCredits: credits + bonusCredits,
    wasPriceMinor: null,
    promotionEndsAt: null,
    ...over,
  };
}
const catalogOf = (...packs: CustomerPackOffer[]): CustomerEconomyCatalog => ({ asOf: '2026-10-02T00:00:00.000000Z', plans: [], packs, actionCosts: [] });

describe('which packs the store offers', () => {
  it('only purchasable ones: a retired pack is never shown, though the catalog includes it', () => {
    const catalog = catalogOf(
      pack({ code: 'starter', sortOrder: 1 }),
      pack({ code: 'qa_plain', sortOrder: 901, isPurchasable: false }),
      pack({ code: 'plus', sortOrder: 3 }),
      pack({ code: 'qa_bonus', sortOrder: 902, isPurchasable: false, bonusCredits: 10 }),
    );
    expect(purchasablePacks(catalog).map((p) => p.code)).toEqual(['starter', 'plus']);
  });

  it('in ladder order, then by code; none when there is no catalog', () => {
    expect(purchasablePacks(catalogOf(pack({ code: 'b', sortOrder: 2 }), pack({ code: 'a', sortOrder: 2 }), pack({ code: 'z', sortOrder: 1 }))).map((p) => p.code)).toEqual(['z', 'a', 'b']);
    expect(purchasablePacks(null)).toEqual([]);
    expect(purchasablePacks(catalogOf(pack({ code: 'gone', isPurchasable: false })))).toEqual([]);
  });

});

describe('which pack the store recommends (store conversion)', () => {
  const ladder = [
    pack({ code: 'p100', credits: 100, priceMinor: 999, sortOrder: 1 }),
    pack({ code: 'p320', credits: 300, bonusCredits: 20, priceMinor: 2499, sortOrder: 2 }),
    pack({ code: 'p825', credits: 750, bonusCredits: 75, priceMinor: 4999, sortOrder: 3 }),
    pack({ code: 'p1700', credits: 1500, bonusCredits: 200, priceMinor: 8999, sortOrder: 4 }),
  ];

  it('1. the pack the operator marked as best value wins, even arriving to unlock something', () => {
    const marked = ladder.map((p) => (p.code === 'p1700' ? { ...p, isBestValue: true } : p));
    expect(recommendedPack(marked)?.code).toBe('p1700');
    expect(recommendedPack(marked, 20)?.code).toBe('p1700');
  });

  it('2. arriving to unlock: the smallest pack that covers what is still needed', () => {
    expect(recommendedPack(ladder, 20)?.code).toBe('p100');
    expect(recommendedPack(ladder, 101)?.code).toBe('p320');
    expect(recommendedPack(ladder, 500)?.code).toBe('p825');
  });

  it('3. otherwise the second-cheapest; the only pack when there is one; none when none is for sale', () => {
    expect(recommendedPack(ladder)?.code).toBe('p320');
    expect(recommendedPack(ladder, 0)?.code).toBe('p320'); // nothing needed: no covering rule
    expect(recommendedPack(ladder, 99_999)?.code).toBe('p320'); // nothing covers it
    expect(recommendedPack([pack({ code: 'only' })])?.code).toBe('only');
    expect(recommendedPack([pack({ code: 'gone', isPurchasable: false })])).toBeNull();
  });

  it('"Unlocks this" marks the smallest covering pack -- and nothing when nothing is needed', () => {
    expect(packThatUnlocks(ladder, 20)).toBe('p100');
    expect(packThatUnlocks(ladder, 321)).toBe('p825');
    expect(packThatUnlocks(ladder, 0)).toBeNull();
    expect(packThatUnlocks(ladder, null)).toBeNull();
    expect(packThatUnlocks(ladder, 99_999)).toBeNull();
  });
});

describe('what each pack is worth (store conversion)', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const views = [
    pack({ code: 'p100', credits: 100, priceMinor: 999 }),
    pack({ code: 'p320', credits: 300, bonusCredits: 20, priceMinor: 2499 }),
    pack({ code: 'p825', credits: 750, bonusCredits: 75, priceMinor: 4999 }),
    pack({ code: 'p4100', credits: 3500, bonusCredits: 600, priceMinor: 17999 }),
  ].map((p) => packView(p, now));

  it('the CTA carries what is received and the catalog price', () => {
    expect(packCtaLabel(views[2]!)).toBe('Get 825 Credits · $49.99');
    expect(packCtaLabel(packView(pack({ code: 'one', credits: 1, priceMinor: 99 }), now))).toBe('Get 1 Credit · $0.99');
  });

  it('savings per Credit against the cheapest pack, rounded DOWN; none for the reference pack', () => {
    const savings = packSavings(views);
    expect(savings.has('p100')).toBe(false);
    // $9.99/100 = 9.99c; $24.99/320 = 7.81c (21.8%); $49.99/825 = 6.06c (39.3%); $179.99/4100 = 4.39c (56.0%)
    expect(Object.fromEntries(savings)).toEqual({ p320: 21, p825: 39, p4100: 56 });
  });

  it('follows the price on screen: a running promotion counts, and an ended one does not', () => {
    const promo = pack({ code: 'promo', credits: 100, priceMinor: 499, wasPriceMinor: 999, promotionEndsAt: '2026-10-02T13:00:00Z' });
    const base = pack({ code: 'base', credits: 200, priceMinor: 1998 });
    // While the promotion runs, the promotional pack is the cheapest per Credit: the other saves nothing.
    expect(Object.fromEntries(packSavings([packView(promo, now), packView(base, now)]))).toEqual({});
    // Once it ends, both cost the same per Credit: still nothing to claim.
    expect(Object.fromEntries(packSavings([packView(promo, now + 2 * 3_600_000), packView(base, now)]))).toEqual({});
  });

  it('never compares across currencies, and claims nothing under 5%', () => {
    const usd = packView(pack({ code: 'usd', credits: 100, priceMinor: 1000 }), now);
    const eur = packView(pack({ code: 'eur', credits: 200, priceMinor: 1000, currency: 'EUR' }), now);
    const slight = packView(pack({ code: 'slight', credits: 103, priceMinor: 1000 }), now);
    expect(Object.fromEntries(packSavings([usd, eur, slight]))).toEqual({});
  });
});

describe('what the store says (store conversion)', () => {
  it('the balance in one line; low and zero say what to do, with no alarm', () => {
    expect(balanceLine(balanceState(42))).toBe('You have 42 Credits');
    expect(balanceLine(balanceState(5))).toBe('Only 5 left: top up to keep going.');
    expect(balanceLine(balanceState(0))).toBe("You're out of Credits: top up to keep going.");
    expect(balanceLine(balanceState(null))).toBeNull();
    for (const n of [0, 5, 42]) expect(balanceLine(balanceState(n))).not.toMatch(/hurry|now!|last chance|expires/i);
  });

  it('the hero: the post being unlocked and what it still needs; a known character; or the generic line', () => {
    expect(storeHeroCopy({ characterName: 'Amara', unlock: { mediaType: 'video', creditsNeeded: 20 } })).toMatchObject({
      title: "Unlock Amara's private video",
      subtitle: 'You need 20 more Credits.',
    });
    expect(storeHeroCopy({ characterName: 'Amara', unlock: { mediaType: 'image', creditsNeeded: 1 } }).subtitle).toBe('You need 1 more Credit.');
    expect(storeHeroCopy({ characterName: 'Amara', unlock: { mediaType: 'image', creditsNeeded: 0 } })).toMatchObject({
      title: "Unlock Amara's private photo",
      subtitle: 'You already have enough Credits to unlock it.',
    });
    // The price is not known yet: no number is invented.
    expect(storeHeroCopy({ characterName: 'Amara', unlock: { mediaType: null, creditsNeeded: null } }).subtitle).not.toMatch(/[0-9]/);
    expect(storeHeroCopy({ characterName: 'Camila', unlock: null }).title).toBe("She's waiting for you");
    expect(storeHeroCopy({ characterName: null, unlock: null }).title).toBe('Keep the experience going');
  });
});

describe('the balance', () => {
  it('zero, low and normal -- and unknown when the server did not say', () => {
    expect(balanceState(0)).toEqual({ kind: 'zero' });
    expect(balanceState(7)).toEqual({ kind: 'low', credits: 7 });
    expect(balanceState(LOW_BALANCE)).toEqual({ kind: 'low', credits: LOW_BALANCE });
    expect(balanceState(LOW_BALANCE + 1)).toEqual({ kind: 'normal', credits: LOW_BALANCE + 1 });
    expect(balanceState(347)).toEqual({ kind: 'normal', credits: 347 });
    expect(balanceState(null)).toEqual({ kind: 'unknown' });
  });
});

describe('one pack, as shown', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');

  it('says exactly what the customer receives, bonus included', () => {
    const view = packView(pack({ code: 'plus', credits: 750, bonusCredits: 100, priceMinor: 4999, badge: 'Best value' }), now);
    expect(view).toMatchObject({ credits: 750, bonusCredits: 100, totalCredits: 850, price: '$49.99', badge: 'Best value', cta: 'Get 850 Credits' });
    expect(packView(pack({ code: 'one', credits: 1, priceMinor: 99 }), now).cta).toBe('Get 1 Credit');
  });

  it('no promotion: no struck-through price and no countdown', () => {
    expect(packView(pack({ code: 'p', priceMinor: 999 }), now)).toMatchObject({ price: '$9.99', wasPrice: null, endsInMs: null });
  });

  it('a running promotion: the promotional price, the regular one struck through, and the time left', () => {
    const view = packView(pack({ code: 'p', priceMinor: 4999, wasPriceMinor: 7999, promotionEndsAt: '2026-10-02T14:14:37Z' }), now);
    expect(view).toMatchObject({ price: '$49.99', wasPrice: '$79.99' });
    expect(formatCountdown(view.endsInMs!)).toBe('02:14:37');
  });

  it('an open-ended promotion: struck through, but no countdown', () => {
    expect(packView(pack({ code: 'p', priceMinor: 4999, wasPriceMinor: 7999 }), now)).toMatchObject({ wasPrice: '$79.99', endsInMs: null });
  });

  it('when the countdown reaches zero the offer ends here too: the regular price, no struck price, no countdown', () => {
    const offer = pack({ code: 'p', priceMinor: 4999, wasPriceMinor: 7999, promotionEndsAt: '2026-10-02T12:00:01Z' });
    expect(packView(offer, now)).toMatchObject({ price: '$49.99', wasPrice: '$79.99' });
    expect(packView(offer, now + 1000)).toMatchObject({ price: '$79.99', wasPrice: null, endsInMs: null });
  });

  it('marks the recommended pack', () => {
    const plus = pack({ code: 'plus', isBestValue: true });
    expect(packView(plus, now, plus).recommended).toBe(true);
    expect(packView(pack({ code: 'starter' }), now, plus).recommended).toBe(false);
  });

  it('counts down in hours, minutes and seconds -- and days beyond one', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(-5000)).toBe('00:00:00');
    expect(formatCountdown(3 * 86_400_000 + 3_723_000)).toBe('3d 01:02:03');
  });
});

describe('where the customer came from', () => {
  it('reads the context from the store link -- fixed values and ids only', () => {
    const params = new URLSearchParams({ origin: 'profile', originAction: 'content_unlock', assetId: ASSET, characterId: CHARACTER, extra: 'ignored' });
    expect(readStoreContext(params)).toEqual({ origin: 'profile', originAction: 'content_unlock', assetId: ASSET, conversationId: null, characterId: CHARACTER });
  });

  it('drops anything that is not on the lists or not an id, including URLs', () => {
    const params = new URLSearchParams({ origin: 'https://evil.example', originAction: 'transfer', assetId: '../../etc', conversationId: 'javascript:alert(1)' });
    expect(readStoreContext(params)).toBeNull();
    expect(readStoreContext(new URLSearchParams())).toBeNull();
  });

  it('builds the store link a "Get Credits" button points at, and nothing more', () => {
    expect(creditsStoreHref({ origin: 'profile', originAction: 'content_unlock', assetId: ASSET, characterId: CHARACTER })).toBe(
      `/credits?origin=profile&originAction=content_unlock&assetId=${ASSET}&characterId=${CHARACTER}`,
    );
    expect(creditsStoreHref()).toBe('/credits');
    // And the store reads back exactly what the link carried.
    const href = creditsStoreHref({ origin: 'chat', conversationId: CONVERSATION });
    expect(readStoreContext(new URL(href, 'https://app.example').searchParams)).toMatchObject({ origin: 'chat', conversationId: CONVERSATION });
  });
});

describe('the way back -- always a path of this app', () => {
  const ctx = { origin: null, originAction: null, assetId: null, conversationId: null, characterId: null };

  it('an unlock goes back to that character\'s Posts, to finish it', () => {
    expect(returnTarget({ ...ctx, origin: 'profile', originAction: 'content_unlock', assetId: ASSET, characterId: CHARACTER })).toBe(
      `/characters/${CHARACTER}?tab=posts&unlock=${ASSET}`,
    );
  });

  it('a chat goes back to that conversation; anything else with a character to her profile', () => {
    expect(returnTarget({ ...ctx, origin: 'chat', conversationId: CONVERSATION })).toBe(`/chat/${CONVERSATION}`);
    expect(returnTarget({ ...ctx, origin: 'header', characterId: CHARACTER })).toBe(`/characters/${CHARACTER}`);
  });

  it('nowhere when nothing names a place -- and never a crafted value', () => {
    expect(returnTarget(null)).toBeNull();
    expect(returnTarget({ ...ctx, origin: 'header' })).toBeNull();
    for (const bad of ['https://evil.example', '//evil.example', '../admin', 'x?y=1']) {
      expect(returnTarget({ ...ctx, conversationId: bad, characterId: bad, assetId: bad, originAction: 'content_unlock' })).toBeNull();
    }
    // Whatever it returns starts with a single slash and names one of this app's routes.
    const target = returnTarget({ ...ctx, originAction: 'content_unlock', assetId: ASSET, characterId: CHARACTER })!;
    expect(target).toMatch(/^\/(characters|chat)\//);
  });

  it('a pack checkout comes back to the store with its payment; a plan to Premium', () => {
    expect(afterCheckoutPath({ id: 'p-1', kind: 'credit_pack' })).toBe('/credits?from=checkout&payment=p-1');
    expect(afterCheckoutPath({ id: 'p-2', kind: 'subscription' })).toBe('/subscription?from=checkout');
  });
});

describe('returning from checkout -- the success message is said once', () => {
  const PAYMENT = '0e7f80ca-f0d0-418c-b641-511747c46c5b';
  const fakeStorage = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  };
  afterEach(() => vi.unstubAllGlobals());

  it('the first return from the checkout this tab started says the Credits were added', () => {
    expect(returnOutcome('succeeded', PAYMENT, PAYMENT)).toBe('added');
  });

  it('REGRESSION (staging QA): refreshing or revisiting a completed pack payment never says Credits were added again', () => {
    vi.stubGlobal('sessionStorage', fakeStorage());
    // The store starts the checkout and remembers it, as CreditsStorePage does.
    pendingPayment.set(PAYMENT);
    // First return: the page reads which checkout this tab started, then clears it once shown.
    expect(returnOutcome('succeeded', PAYMENT, pendingPayment.get())).toBe('added');
    pendingPayment.clear();
    // A refresh of the same /credits?from=checkout&payment=... URL: nothing is remembered any more.
    expect(returnOutcome('succeeded', PAYMENT, pendingPayment.get())).toBe('already_added');
    // A later visit after another checkout was started: still not news for THIS payment.
    pendingPayment.set('f640d9f8-80a5-4e58-9d32-767c0382156b');
    expect(returnOutcome('succeeded', PAYMENT, pendingPayment.get())).toBe('already_added');
  });

  it('a link opened in another tab, with nothing remembered, is a completed purchase -- not new Credits', () => {
    expect(returnOutcome('succeeded', PAYMENT, null)).toBe('already_added');
  });

  it('pending and unsuccessful payments are never called added, first time or not', () => {
    expect(returnOutcome('pending', PAYMENT, PAYMENT)).toBe('pending');
    for (const status of ['failed', 'cancelled', 'refunded', 'disputed']) {
      expect(returnOutcome(status, PAYMENT, PAYMENT)).toBe('not_completed');
      expect(returnOutcome(status, PAYMENT, null)).toBe('not_completed');
    }
  });
});

describe('finishing the unlock that sent them here', () => {
  const pending = { assetId: ASSET, creditPrice: 25 };

  it('goes through on its own only at the price the customer saw', () => {
    expect(resumeUnlockAction({ decision: 'credits_required', creditPrice: 25 }, true, pending, ASSET)).toBe('auto');
    expect(mayAutoUnlock(pending, ASSET, 25)).toBe(true);
  });

  it('asks again when the price changed, or nothing was remembered', () => {
    expect(resumeUnlockAction({ decision: 'credits_required', creditPrice: 30 }, true, pending, ASSET)).toBe('confirm');
    expect(resumeUnlockAction({ decision: 'credits_required', creditPrice: 25 }, true, null, ASSET)).toBe('confirm');
    expect(resumeUnlockAction({ decision: 'credits_required', creditPrice: 25 }, true, { ...pending, assetId: CHARACTER }, ASSET)).toBe('confirm');
  });

  it('does nothing for content already owned, no longer for sale, or not on the page', () => {
    expect(resumeUnlockAction({ decision: 'owned' }, true, pending, ASSET)).toBe('none');
    expect(resumeUnlockAction({ decision: 'premium_required' }, true, pending, ASSET)).toBe('none');
    expect(resumeUnlockAction(null, true, pending, ASSET)).toBe('none');
    expect(resumeUnlockAction({ decision: 'credits_required', creditPrice: 25 }, false, pending, ASSET)).toBe('none');
  });
});

describe('Premium as a value anchor (store conversion)', () => {
  const plan = (over: Partial<CustomerPlanOffer>): CustomerPlanOffer => ({
    code: 'premium_monthly', version: 1, versionId: 'v', displayName: 'Premium monthly', billingPeriodMonths: 1,
    priceMinor: 1299, currency: 'USD', monthlyIncludedCredits: 200, isPurchasable: true, effectiveFrom: '', ...over,
  });

  it("quotes the catalog's monthly plan -- its Credits and price -- to someone known not to have Premium", () => {
    expect(premiumAnchor([plan({}), plan({ code: 'annual', billingPeriodMonths: 12, priceMinor: 8999 })], 'free')).toEqual({ credits: 200, price: '$12.99' });
    expect(premiumAnchor([plan({ monthlyIncludedCredits: 350, priceMinor: 1599 })], 'free')).toEqual({ credits: 350, price: '$15.99' });
  });

  it('says nothing to a subscriber, while the tier is unknown, or when there is no monthly plan to quote', () => {
    expect(premiumAnchor([plan({})], 'premium')).toBeNull();
    expect(premiumAnchor([plan({})], null)).toBeNull();
    expect(premiumAnchor([plan({ isPurchasable: false })], 'free')).toBeNull();
    expect(premiumAnchor([plan({ billingPeriodMonths: 12 })], 'free')).toBeNull();
    expect(premiumAnchor([], 'free')).toBeNull();
  });
});

describe('the checkout request', () => {
  it('names the pack and where it started -- never a price, Credits or a bonus', () => {
    const context = { origin: 'profile' as const, originAction: 'content_unlock' as const, assetId: ASSET, conversationId: null, characterId: CHARACTER };
    const body = packCheckoutRequest('plus', 'apple_pay', 'plus:key-1', context);
    expect(body).toEqual({ packCode: 'plus', method: 'apple_pay', idempotencyKey: 'plus:key-1', returnUrl: '/credits', context });
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(['priceMinor', 'amountMinor', 'credits', 'bonusCredits']));
  });
});

describe('what the browser remembers across the payment', () => {
  const fakeStorage = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  };
  afterEach(() => vi.unstubAllGlobals());

  it('the payment in flight, the unlock to resume and the last character -- validated on the way out', () => {
    vi.stubGlobal('sessionStorage', fakeStorage());
    vi.stubGlobal('localStorage', fakeStorage());
    pendingPayment.set('f640d9f8-80a5-4e58-9d32-767c0382156b');
    expect(pendingPayment.get()).toBe('f640d9f8-80a5-4e58-9d32-767c0382156b');
    pendingPayment.clear();
    expect(pendingPayment.get()).toBeNull();

    pendingUnlock.set({ assetId: ASSET, creditPrice: 25 });
    expect(pendingUnlock.get()).toEqual({ assetId: ASSET, creditPrice: 25 });
    sessionStorage.setItem('over18.credits.pendingUnlock', '{"assetId":"https://evil.example","creditPrice":1}');
    expect(pendingUnlock.get()).toBeNull();

    lastCharacter.set(CHARACTER);
    expect(lastCharacter.get()).toBe(CHARACTER);
    lastCharacter.set('not-an-id');
    expect(lastCharacter.get()).toBe(CHARACTER);
  });

  it('works -- doing nothing -- when the browser has no storage at all', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(pendingPayment.get()).toBeNull();
    expect(() => pendingPayment.set('x')).not.toThrow();
  });

  it('the hero: where they came from, else who they last chatted with, else the default', () => {
    const ctx = { origin: null, originAction: null, assetId: null, conversationId: null, characterId: CHARACTER };
    expect(heroCharacterId(ctx, 'last')).toBe(CHARACTER);
    expect(heroCharacterId(null, 'last')).toBe('last');
    expect(heroCharacterId(null, null)).toBeNull();
  });

  it('a landed purchase is announced, so the balance in the app bar is read again', () => {
    const target = new EventTarget();
    const heard = vi.fn();
    target.addEventListener(CREDITS_CHANGED_EVENT, heard);
    vi.stubGlobal('dispatchEvent', (event: Event) => target.dispatchEvent(event));
    announceCreditsChanged();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
