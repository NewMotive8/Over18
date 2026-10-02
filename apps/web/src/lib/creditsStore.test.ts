import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomerEconomyCatalog, CustomerPackOffer } from '@over18/shared';
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
  returnTarget,
  showPremiumNote,
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
const catalogOf = (...packs: CustomerPackOffer[]): CustomerEconomyCatalog => ({ asOf: '2026-10-02T00:00:00.000000Z', plans: [], packs });

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

  it('recommends the pack the operator marked, and none when none is marked', () => {
    const packs = [pack({ code: 'starter' }), pack({ code: 'plus', isBestValue: true })];
    expect(recommendedPack(packs)?.code).toBe('plus');
    expect(recommendedPack([pack({ code: 'starter' })])).toBeNull();
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

describe('Premium and Credits stay apart', () => {
  it('Premium is mentioned only to someone known not to have it', () => {
    expect(showPremiumNote('free')).toBe(true);
    expect(showPremiumNote('premium')).toBe(false);
    expect(showPremiumNote(null)).toBe(false);
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
