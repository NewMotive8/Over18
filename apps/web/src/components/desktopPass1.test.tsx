import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PublicCategoryRail, PublicClip } from '../lib/api';
import DesktopHeader from './nav/DesktopHeader';
import { PRIMARY_DESTINATIONS } from './nav/destinations';
import HeroCarousel from './lobby/HeroCarousel';
import ClipRail from './lobby/ClipRail';
import LobbyTopBar from './lobby/LobbyTopBar';
import FeedGate from './premium/FeedGate';
import CommunityPromoCard from './lobby/CommunityPromoCard';

/**
 * Desktop Pass 1: the foundations and Home.
 *
 * The rule these guard: every desktop change sits behind `lg:` (1024px+), so a
 * phone or tablet renders exactly what it did before; and from `lg` up the
 * desktop layout is really there.
 */

const at = (path: string, node: JSX.Element) =>
  renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const clip = (n: number): PublicClip =>
  ({ id: `clip-${n}`, mediaType: 'video', url: `/api/media/assets/${n}/file`, characterId: `c-${n}`, characterName: `Char ${n}` }) as PublicClip;

describe('the desktop header', () => {
  it('is desktop-only: not rendered below lg', () => {
    expect(at('/characters', <DesktopHeader />)).toMatch(/<header[^>]*class="[^"]*\bhidden\b[^"]*\blg:block\b/);
  });

  it('carries the same primary destinations as the phone tab bar, in the same order', () => {
    const html = at('/characters', <DesktopHeader />);
    const labels = PRIMARY_DESTINATIONS.map((d) => d.label);
    let from = 0;
    for (const label of labels) {
      const i = html.indexOf(`>${label}<`, from);
      expect(i).toBeGreaterThan(-1);
      from = i;
    }
    for (const d of PRIMARY_DESTINATIONS) expect(html).toContain(`href="${d.path}"`);
  });

  it('marks the active destination with the same rule as the phone bar', () => {
    const html = at('/favourites', <DesktopHeader />);
    expect(html).toMatch(/aria-current="page"[^>]*href="\/favourites"|href="\/favourites"[^>]*aria-current="page"/);
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });

  it('holds the page’s own actions when it has them', () => {
    expect(at('/characters', <DesktopHeader extras={<span>extra-action</span>} />)).toContain('extra-action');
  });
});

describe('the shell', () => {
  const shell = read('./AppShell.tsx');

  it('renders the desktop header on every route, and the phone bar only below lg', () => {
    expect(shell).toMatch(/<DesktopHeader/);
    expect(shell).toContain("sticky bottom-0 z-10 mx-auto w-full max-w-lg lg:hidden");
  });

  it('keeps every screen the phone column below lg, and widens only screens with a desktop layout', () => {
    expect(shell).toContain("const frame = isLobby ? 'max-w-lg lg:max-w-7xl lg:px-8' : isWide ? 'max-w-lg lg:max-w-6xl' : 'max-w-lg';");
    expect(shell).toContain('mx-auto flex w-full flex-1 flex-col overflow-y-auto ${frame}');
  });

  it('the phone header is the phone column, and steps aside for the desktop header from lg', () => {
    expect(shell).toMatch(/<header className="sticky top-0 z-10 mx-auto flex w-full max-w-lg [^"]*lg:hidden">/);
  });

  it('paints the page dark, so no white shows beside the app on a wide screen', () => {
    expect(read('../index.css')).toMatch(/html,\s*body\s*\{\s*background-color: var\(--color-zinc-950\);/);
  });
});

describe('Home on a phone is unchanged', () => {
  it('the phone top bar is phone-only; the desktop header replaces it from lg', () => {
    expect(at('/characters', <LobbyTopBar />)).toMatch(/<header[^>]*class="[^"]*\blg:hidden"/);
  });

  it('the hero keeps its square, full-width, centre-snapped slide below lg', () => {
    const html = at('/characters', <HeroCarousel clips={[clip(1), clip(2)]} />);
    expect(html).toContain('relative aspect-square w-full shrink-0 snap-center');
  });

  it('the rails keep their 160px cards and swipe scroller below lg', () => {
    const rail = { id: 'r', slug: 'new', name: 'New', tagline: null, clips: [clip(1), clip(2)] } as unknown as PublicCategoryRail;
    const html = at('/characters', <ClipRail rail={rail} />);
    expect(html).toContain('flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none]');
    expect(html).toContain('relative block aspect-[3/4] w-40 shrink-0 snap-start');
  });

  it('the promo card still spans two columns, and the feed gate stays a full row', () => {
    expect(at('/characters', <CommunityPromoCard />)).toContain('col-span-2 flex flex-col');
    expect(at('/characters', <FeedGate onContinue={() => {}} />)).toContain('col-span-2 flex flex-col lg:col-span-full');
  });
});

describe('Home on a desktop', () => {
  it('the hero becomes a row of portrait slides: 3 at lg, 4 from xl', () => {
    const html = at('/characters', <HeroCarousel clips={[clip(1), clip(2), clip(3), clip(4), clip(5)]} />);
    expect(html).toContain('lg:aspect-[3/4] lg:w-[calc((100%-2rem)/3)] lg:snap-start');
    expect(html).toContain('xl:w-[calc((100%-3rem)/4)]');
  });

  it('never leaves an empty slot: 3 clips stay 3 across at xl; fewer than 3 are centred', () => {
    const three = at('/characters', <HeroCarousel clips={[clip(1), clip(2), clip(3)]} />);
    expect(three).not.toContain('xl:w-[calc((100%-3rem)/4)]');
    expect(three).not.toContain('lg:justify-center');
    const two = at('/characters', <HeroCarousel clips={[clip(1), clip(2)]} />);
    expect(two).toContain('lg:justify-center');
  });

  it('the hero has desktop arrows (and keeps its phone dots below lg)', () => {
    const html = at('/characters', <HeroCarousel clips={[clip(1), clip(2), clip(3), clip(4), clip(5)]} />);
    expect(html).toMatch(/data-testid="hero-prev"[^>]*class="[^"]*\bhidden\b[^"]*\blg:flex\b/);
    expect(html).toMatch(/data-testid="hero-next"[^>]*class="[^"]*\bhidden\b[^"]*\blg:flex\b/);
    expect(html).toContain('absolute right-4 top-4 flex gap-1.5 lg:hidden');
  });

  it('every slide in view plays on a desktop; only the active one on a phone', () => {
    expect(read('./lobby/HeroCarousel.tsx')).toContain('active={i >= active && i < active + perView}');
  });

  it('rails get bigger cards and arrows on a desktop', () => {
    const rail = { id: 'r', slug: 'new', name: 'New', tagline: null, clips: [clip(1)] } as unknown as PublicCategoryRail;
    expect(at('/characters', <ClipRail rail={rail} />)).toContain('w-40 shrink-0 snap-start overflow-hidden rounded-2xl border border-white/5 bg-zinc-900 lg:w-48 xl:w-52');
    expect(read('./lobby/ClipRail.tsx')).toMatch(/<RailArrows scrollerRef=\{scrollerRef\}/);
    expect(read('./lobby/PlayWithMeCarousel.tsx')).toMatch(/<RailArrows scrollerRef=\{scrollerRef\}/);
  });

  it('rail arrows are desktop-only', () => {
    expect(read('./lobby/RailArrows.tsx')).toMatch(/hidden h-11 w-11 [^']*lg:flex/);
  });

  it('the results grid: 2 columns on a phone, 4 / 5 / 6 on a desktop, in data order', () => {
    const page = read('../pages/LobbyPage.tsx');
    expect(page).toContain("const FEED_GRID = 'grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4 xl:grid-cols-5 2xl:grid-cols-6';");
    // Still the same order: two clips, the promo, the rest, then the gate.
    expect(page).toMatch(/shownClips\.slice\(0, 2\)[\s\S]*<CommunityPromoCard \/>[\s\S]*shownClips\.slice\(2\)[\s\S]*<FeedGate/);
    // No CSS that would reorder cards visually (CSS columns, dense packing).
    expect(page).not.toMatch(/\bcolumns-\d|grid-flow-dense|grid-flow-col/);
  });

  it('the header search reaches the one search input on the page', () => {
    expect(read('../pages/LobbyPage.tsx')).toContain('id={LOBBY_SEARCH_ID}');
    expect(read('./AppShell.tsx')).toContain('<LobbyActions onSearch={focusLobbySearch} withAccount={false} />');
  });
});
