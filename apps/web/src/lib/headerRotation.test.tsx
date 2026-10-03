import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicClip, PublicPlayWithMeCard } from './api';
import { HEADER_ROTATION_SIZE, nextIndex, pickRotation, sessionRotation } from './headerRotation';
import { storeHeroCopy } from './creditsStore';
import RotatingHeaderClip from '../components/RotatingHeaderClip';
import { DEFAULT_HERO, StoreHero } from '../components/credits/CreditsStoreParts';
import { FunnelPlans } from '../components/premium/PremiumFunnel';

/**
 * The rotating header: six random characters per session, played 1 -> 6 and
 * back to 1, on the Credits Store hero and the Premium funnel offer.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clip = (n: number, mediaType: 'image' | 'video' = 'video'): PublicClip => ({
  id: id(100 + n), mediaType, url: `/api/media/clip-${n}.mp4`, characterId: id(n), characterName: `Char ${n}`,
});
const card = (n: number, c: PublicClip | null = clip(n)): PublicPlayWithMeCard =>
  ({ id: id(n), displayName: `Char ${n}`, apparentAgeBand: '25-29', categories: [], clip: c }) as PublicPlayWithMeCard;
const CARDS = Array.from({ length: 12 }, (_, i) => card(i + 1));
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('choosing the six', () => {
  it('six distinct characters, all with a video clip', () => {
    const cards = [...CARDS, card(50, clip(50, 'image')), card(51, null)];
    const ids = pickRotation(cards, null, seq(0.3, 0.9, 0.1, 0.6));
    expect(ids).toHaveLength(HEADER_ROTATION_SIZE);
    expect(new Set(ids).size).toBe(6);
    expect(ids).not.toContain(id(50));
    expect(ids).not.toContain(id(51));
  });

  it('random: different draws pick different sixes', () => {
    expect(pickRotation(CARDS, null, seq(0))).not.toEqual(pickRotation(CARDS, null, seq(0.99)));
  });

  it('keeps the session six while they are all still available', () => {
    const remembered = [id(3), id(7), id(1), id(12), id(5), id(9)];
    expect(pickRotation(CARDS, remembered, seq(0.5))).toEqual(remembered);
  });

  it('picks again when a remembered character has gone, or the set is malformed', () => {
    const gone = [id(3), id(7), id(1), id(12), id(5), id(99)];
    expect(pickRotation(CARDS, gone, seq(0.5))).not.toEqual(gone);
    const dupes = [id(3), id(3), id(1), id(12), id(5), id(9)];
    expect(new Set(pickRotation(CARDS, dupes, seq(0.5))).size).toBe(6);
  });

  it('fewer than six available: all of them; none: an empty rotation', () => {
    expect(pickRotation(CARDS.slice(0, 4), null, seq(0.5))).toHaveLength(4);
    expect(pickRotation([], null)).toEqual([]);
  });
});

describe('the loop', () => {
  it('1 -> 2 ... -> 6 -> 1', () => {
    const order = [0];
    for (let i = 0; i < 7; i++) order.push(nextIndex(order[order.length - 1]!, 6));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
    expect(nextIndex(0, 0)).toBe(0);
  });
});

describe('remembered for the session', () => {
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

  it('written once, read back the same', () => {
    const ids = [id(1), id(2), id(3), id(4), id(5), id(6)];
    sessionRotation.write(ids);
    expect(sessionRotation.read()).toEqual(ids);
  });

  it('garbage reads as nothing', () => {
    store.set('over18.headerRotation', '{nope');
    expect(sessionRotation.read()).toBeNull();
    store.set('over18.headerRotation', JSON.stringify(['not-an-id']));
    expect(sessionRotation.read()).toBeNull();
  });

  it('in sessionStorage, not localStorage: a new session picks a new six', () => {
    const source = readFileSync(new URL('./headerRotation.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/sessionStorage/);
    expect(source).not.toMatch(/localStorage/);
  });
});

describe('the header', () => {
  const six = [1, 2, 3, 4, 5, 6].map((n) => clip(n));

  it('plays the first clip, muted and inline, and hands over rather than looping', () => {
    const html = renderToStaticMarkup(<RotatingHeaderClip clips={six} fallback={<i>fallback</i>} />);
    expect(html).toContain('data-testid="header-rotation"');
    expect(html).toContain('clip-1.mp4');
    expect(html).toContain('data-count="6"');
    expect(html).toMatch(/muted/);
    expect(html).toMatch(/playsInline|playsinline/);
    expect(html).not.toMatch(/\sloop=""/);
    expect(html).not.toContain('fallback');
  });

  it('nothing to rotate yet: the fallback', () => {
    expect(renderToStaticMarkup(<RotatingHeaderClip clips={[]} fallback={<i>fallback</i>} />)).toBe('<i>fallback</i>');
  });

  it('Credits Store hero: the rotation when no character was asked for', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreHero media={{ imageUrl: null, name: null }} copy={storeHeroCopy({ characterName: null, unlock: null })} rotation={six} />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="header-rotation"');
    expect(html).not.toContain(DEFAULT_HERO.video);
  });

  it('Credits Store hero: a character the store opened FOR still wins over the rotation', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreHero media={{ imageUrl: 'https://api.example/camila.png', name: 'Camila' }} copy={storeHeroCopy({ characterName: 'Camila', unlock: null })} rotation={six} />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="store-hero-image"');
    expect(html).not.toContain('header-rotation');
  });

  it('Premium funnel offer: the rotation in the header', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FunnelPlans state={{ status: 'loading' }} onBack={() => {}} onClose={() => {}} onChoose={() => {}} rotation={six} />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="header-rotation"');
    expect(html).not.toContain(DEFAULT_HERO.poster);
  });

  it('the Credits Store page no longer falls back to the last-chatted character for the hero', () => {
    const page = readFileSync(new URL('../pages/CreditsStorePage.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(/heroCharacterId\(context, null\)/);
    expect(page).toMatch(/useHeaderRotation\(\)/);
  });
});
