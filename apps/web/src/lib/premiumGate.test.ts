import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomerEconomyState } from './customerEconomy';
import { FREE_CHARACTER_LIMIT, admit, canMeet, feedWindow, gateStatus, metCharacters } from './premiumGate';

/**
 * The Premium feed gate's rules, without a browser: ten different characters
 * per surface for a Free customer, counted once each, never for Premium.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => id(from + i));
const clip = (character: number, n = 0) => ({ id: `clip-${character}-${n}`, characterId: id(character) });

describe('the allowance', () => {
  it('is ten', () => {
    expect(FREE_CHARACTER_LIMIT).toBe(10);
  });

  it('ten different characters may be met; the eleventh may not; one already met always may', () => {
    const ten = new Set(ids(1, 10));
    expect(canMeet(new Set(ids(1, 9)), id(10))).toBe(true);
    expect(canMeet(ten, id(11))).toBe(false);
    for (const met of ids(1, 10)) expect(canMeet(ten, met)).toBe(true);
  });

  it('counts each character once: repeats, re-renders and replays add nothing', () => {
    const once = admit(new Set(), [id(1), id(1), id(2)]);
    expect([...once]).toEqual([id(1), id(2)]);
    // Recording the same characters again returns the SAME set -- nothing changes, nothing is written.
    expect(admit(once, [id(1), id(2)])).toBe(once);
    expect(admit(once, [])).toBe(once);
  });

  it('never grows past ten, whatever is recorded', () => {
    const full = admit(new Set(), ids(1, 25));
    expect(full.size).toBe(10);
    expect([...full]).toEqual(ids(1, 10));
    expect(admit(full, [id(26)])).toBe(full);
  });
});

describe('Swipe Mode: the card on screen is what counts', () => {
  /** Plays the deck as SwipePage does: record the card shown, block a character beyond the allowance. */
  function swipeThrough(deck: string[], seen: ReadonlySet<string> = new Set()) {
    let met = seen;
    const shown: string[] = [];
    for (const character of deck) {
      if (!canMeet(met, character)) return { shown, blockedAt: character, met };
      // React may render the same card several times; the set does not care.
      met = admit(admit(met, [character]), [character]);
      shown.push(character);
    }
    return { shown, blockedAt: null, met };
  }

  it('shows characters 1-10 and blocks the attempt to continue to #11', () => {
    const run = swipeThrough(ids(1, 20));
    expect(run.shown).toEqual(ids(1, 10));
    expect(run.blockedAt).toBe(id(11));
    expect(run.met.size).toBe(10);
  });

  it('starting over (or coming back later) re-shows the ten already met, and still blocks #11', () => {
    const first = swipeThrough(ids(1, 20));
    const again = swipeThrough(ids(1, 20), first.met);
    expect(again.shown).toEqual(ids(1, 10));
    expect(again.blockedAt).toBe(id(11));
  });

  it('a deck that reorders still lets the ten already met through, and blocks the first new one', () => {
    const met = new Set(ids(1, 10));
    const reordered = [id(3), id(15), id(1)];
    expect(swipeThrough(reordered, met)).toMatchObject({ shown: [id(3)], blockedAt: id(15) });
  });
});

describe('Home feed: the characters behind the clips shown', () => {
  // 12 characters, several clips each, interleaved the way the feed returns them.
  const feed = [clip(1), clip(2), clip(1, 1), clip(3), clip(4), clip(5), clip(2, 1), clip(6), clip(7), clip(8), clip(9), clip(10), clip(10, 1), clip(11), clip(12), clip(1, 2)];

  it('shows the clips of the first ten characters and gates at the first clip of #11', () => {
    const window = feedWindow(feed, new Set());
    expect(window.gated).toBe(true);
    expect(window.visible.map((c) => c.id)).toEqual(feed.slice(0, 13).map((c) => c.id));
    expect(window.admitted).toEqual(ids(1, 10));
    expect(new Set(window.visible.map((c) => c.characterId)).size).toBe(10);
  });

  it('several clips of one character count once', () => {
    const window = feedWindow([clip(1), clip(1, 1), clip(1, 2), clip(2)], new Set());
    expect(window.admitted).toEqual([id(1), id(2)]);
    expect(window.gated).toBe(false);
  });

  it('recomputing after the characters are remembered shows the same feed and admits nobody new', () => {
    const first = feedWindow(feed, new Set());
    const met = admit(new Set(), first.admitted);
    const again = feedWindow(feed, met);
    expect(again.visible).toEqual(first.visible);
    expect(again.admitted).toEqual([]);
    expect(again.gated).toBe(true);
  });

  it('a different feed (a search, a category) keeps the met characters and gates the first new one beyond ten', () => {
    const met = new Set(ids(1, 10));
    const search = [clip(5), clip(30), clip(7)];
    expect(feedWindow(search, met)).toMatchObject({ visible: [clip(5)], admitted: [], gated: true });
  });

  it('fewer than ten characters: the whole feed, no gate', () => {
    expect(feedWindow([clip(1), clip(2)], new Set())).toMatchObject({ gated: false, admitted: [id(1), id(2)] });
  });
});

describe('who is gated', () => {
  const ready = (tier: 'free' | 'premium' | null, userId = id(99)): CustomerEconomyState =>
    ({
      status: 'ready',
      overview: {
        commercial: { viewer: { userId }, tier: tier === null ? { available: false, reason: 'subscription_unresolvable' } : { available: true, value: tier } },
        catalog: { asOf: '', plans: [], packs: [] },
        actions: [],
      },
    }) as unknown as CustomerEconomyState;

  it('a Free customer, once their allowance is read', () => {
    expect(gateStatus(ready('free'), null)).toMatchObject({ enforced: false, pending: true });
    expect(gateStatus(ready('free'), id(99))).toMatchObject({ enforced: true, pending: false });
    // Another customer's allowance never applies.
    expect(gateStatus(ready('free'), id(98))).toMatchObject({ enforced: false, pending: true });
  });

  it('Premium is NEVER gated', () => {
    expect(gateStatus(ready('premium'), null)).toMatchObject({ enforced: false, pending: false });
    expect(gateStatus(ready('premium'), id(99))).toMatchObject({ enforced: false, pending: false });
  });

  it('an unknown tier, signed out, economy off or failing: not gated (a gate that might be wrong must not block)', () => {
    expect(gateStatus(ready(null), null)).toMatchObject({ enforced: false, pending: false });
    for (const status of ['signed-out', 'disabled', 'unavailable', 'error'] as const) {
      expect(gateStatus({ status, message: '' }, null)).toMatchObject({ enforced: false, pending: false });
    }
  });

  it('while loading: pending -- the surface waits instead of over-showing', () => {
    expect(gateStatus({ status: 'loading' }, null)).toMatchObject({ enforced: false, pending: true });
  });
});

describe('remembered per customer and per surface', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage() {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    return data;
  }

  it('round-trips, separately for each surface and each customer', () => {
    stubStorage();
    metCharacters.write('swipe', id(99), ids(1, 3));
    expect(metCharacters.read('swipe', id(99))).toEqual(ids(1, 3));
    expect(metCharacters.read('home_feed', id(99))).toEqual([]);
    expect(metCharacters.read('swipe', id(98))).toEqual([]);
  });

  it('ignores anything that is not a list of character ids, and never stores more than ten', () => {
    const data = stubStorage();
    data.set(`over18.premiumGate.swipe.${id(99)}`, JSON.stringify(['not-an-id', 42, id(1)]));
    expect(metCharacters.read('swipe', id(99))).toEqual([id(1)]);
    data.set(`over18.premiumGate.swipe.${id(99)}`, '{broken');
    expect(metCharacters.read('swipe', id(99))).toEqual([]);
    metCharacters.write('swipe', id(99), ids(1, 25));
    expect(metCharacters.read('swipe', id(99))).toHaveLength(10);
  });

  it('storage refused: no throw, an empty allowance', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(metCharacters.read('swipe', id(99))).toEqual([]);
    expect(() => metCharacters.write('swipe', id(99), [id(1)])).not.toThrow();
  });
});
