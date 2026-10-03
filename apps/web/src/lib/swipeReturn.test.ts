import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SWIPE_PATH, cameFromSwipe, resolveSwipeIndex, swipePosition } from './swipeReturn';

/**
 * Coming back to Swipe mode where you left it, and the desktop swipe card.
 *
 * Reported in Staging UAT: opening a character from Swipe and pressing Back
 * threw the visitor out to Home; and on a desktop the swipe card cropped heads.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

describe('where the profile’s Back goes', () => {
  it('recognises a profile opened from Swipe -- by exact match, never a URL from state', () => {
    expect(cameFromSwipe({ from: SWIPE_PATH })).toBe(true);
    expect(cameFromSwipe({ from: '/characters' })).toBe(false);
    expect(cameFromSwipe({ from: 'https://evil.example/discover/swipe' })).toBe(false);
    expect(cameFromSwipe({ from: `${SWIPE_PATH}/x` })).toBe(false);
    expect(cameFromSwipe(null)).toBe(false);
    expect(cameFromSwipe(undefined)).toBe(false);
    expect(cameFromSwipe('from')).toBe(false);
  });

  it('Swipe marks the profile visit, from both the card and the open button', () => {
    const page = read('../pages/SwipePage.tsx');
    expect(page).toContain('navigate(`/characters/${character.id}`, { state: { from: SWIPE_PATH } })');
    expect(page).toContain('onOpen={openProfile}');
    expect(page).toContain('onOpen={() => openProfile(current)}');
  });

  it('the profile steps back to Swipe when it came from Swipe, and to Home otherwise (unchanged)', () => {
    const page = read('../pages/CharacterDetailPage.tsx');
    expect(page).toContain('const fromSwipe = cameFromSwipe(location.state);');
    expect(page).toContain("() => (fromSwipe ? navigate(-1) : navigate('/characters'))");
    // It never navigates to a path read out of state.
    expect(page).not.toMatch(/navigate\(location\.state/);
  });
});

describe('which card: remembered per visit', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });
  afterEach(() => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('a visit’s place is written and read back by its history entry', () => {
    swipePosition.write('entry-1', { index: 4, characterId: B });
    expect(swipePosition.read('entry-1')).toEqual({ index: 4, characterId: B });
  });

  it('a fresh visit (a new history entry) has no place: the deck starts at the first card', () => {
    swipePosition.write('entry-1', { index: 4, characterId: B });
    expect(swipePosition.read('entry-2')).toBeNull();
    expect(resolveSwipeIndex(swipePosition.read('entry-2'), [A, B, C])).toBe(0);
  });

  it('garbage reads as nothing', () => {
    store.set('over18.swipe.position.e', '{nope');
    expect(swipePosition.read('e')).toBeNull();
    store.set('over18.swipe.position.e', JSON.stringify({ index: -1, characterId: A }));
    expect(swipePosition.read('e')).toBeNull();
    store.set('over18.swipe.position.e', JSON.stringify({ index: 1, characterId: 'not-an-id' }));
    expect(swipePosition.read('e')).toBeNull();
  });

  it('no storage at all: no error, and the deck starts from the first card', () => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    expect(() => swipePosition.write('e', { index: 2, characterId: A })).not.toThrow();
    expect(swipePosition.read('e')).toBeNull();
  });

  it('per visit, in sessionStorage -- not localStorage', () => {
    const source = read('./swipeReturn.ts');
    expect(source).toMatch(/sessionStorage/);
    expect(source).not.toMatch(/localStorage/);
  });
});

describe('landing on the right card', () => {
  it('the remembered index, while it still holds the remembered character', () => {
    expect(resolveSwipeIndex({ index: 1, characterId: B }, [A, B, C])).toBe(1);
  });

  it('if the list changed, she is found by id -- never somebody else at the old index', () => {
    expect(resolveSwipeIndex({ index: 1, characterId: B }, [A, C, B])).toBe(2);
  });

  it('if she is gone, or the index is past the end, the deck starts from the first card', () => {
    expect(resolveSwipeIndex({ index: 1, characterId: B }, [A, C])).toBe(0);
    expect(resolveSwipeIndex({ index: 9, characterId: B }, [A])).toBe(0);
    expect(resolveSwipeIndex(null, [A, B])).toBe(0);
  });

  it('Swipe starts from the remembered card and keeps the place up to date', () => {
    const page = read('../pages/SwipePage.tsx');
    expect(page).toContain('useState(() => swipePosition.read(location.key)?.index ?? 0)');
    expect(page).toContain('resolveSwipeIndex(swipePosition.read(location.key), state.characters.map((c) => c.id))');
    expect(page).toContain('swipePosition.write(location.key, { index, characterId: onScreen.id })');
  });
});

describe('the desktop swipe card shows the whole clip', () => {
  const page = read('../pages/SwipePage.tsx');

  it('the phone deck is unchanged: it still fills the height that is left', () => {
    expect(page).toContain('<div className="relative min-h-[420px] flex-1 ');
  });

  it('from lg the deck is the clip’s own 9:16 shape, sized from the screen height and centred', () => {
    expect(page).toContain(
      'relative min-h-[420px] flex-1 lg:aspect-[9/16] lg:h-[clamp(26rem,calc(100dvh_-_19rem),46rem)] lg:min-h-0 lg:flex-none lg:self-center',
    );
  });

  it('still one card at a time, with the same deck, actions and gate', () => {
    expect((page.match(/<SwipeDeck\s/g) ?? []).length).toBe(1);
    expect(page).toContain("usePremiumGate('swipe')");
    expect(page).toContain('onDecision={handleDecision}');
  });
});
