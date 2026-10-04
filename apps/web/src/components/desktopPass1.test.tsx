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
import LobbyActions, { offerLabel } from './lobby/LobbyActions';
import type { CustomerEconomyState } from '../lib/customerEconomy';
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
    // Every mode starts from the phone column; only the lg: part differs.
    const frame = shell.slice(shell.indexOf('const frame = isLobby'), shell.indexOf('/**', shell.indexOf('const frame = isLobby')));
    expect(frame).toContain("? 'max-w-lg lg:max-w-7xl lg:px-8'"); // Home (Pass 1)
    expect(frame).toContain("? 'max-w-lg lg:max-w-6xl lg:overflow-visible lg:px-8'"); // Character profile (Pass 2)
    expect(frame).toContain("? 'max-w-lg lg:max-w-6xl'"); // Credits Store
    expect(frame).toMatch(/: 'max-w-lg';/); // everything else: the phone column, unchanged
    // No mode may drop the phone column or change anything below lg.
    for (const mode of frame.match(/'[^']*'/g) ?? []) {
      expect(mode.startsWith("'max-w-lg")).toBe(true);
      for (const cls of mode.slice(1, -1).split(' ').slice(1)) expect(cls.startsWith('lg:')).toBe(true);
    }
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

  it('the results grid: 2 columns on a phone, 4 at lg and 5 from xl on a desktop, in data order', () => {
    const page = read('../pages/LobbyPage.tsx');
    expect(page).toContain("const FEED_GRID = 'grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4 xl:grid-cols-5';");
    // Five is the maximum: the container is capped, so a sixth column would only shrink the cards.
    expect(page).not.toMatch(/FEED_GRID = '[^']*grid-cols-6/);
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

describe('one Credits balance on a desktop screen, never two', () => {
  const shell = read('./AppShell.tsx');

  it('the header leaves its pill out on the screen that still shows the balance itself on a desktop: chat', () => {
    expect(shell).toContain("const pageShowsCredits = pathname.startsWith('/chat/');");
    expect(shell).toContain('showCredits={!pageShowsCredits}');
    expect(read('./nav/DesktopHeader.tsx')).toContain('{showCredits && <CreditsPill />}');
    expect(read('../pages/ChatPage.tsx')).toContain('<CreditsPill />');
  });

  it('the character profile: its hero pill on a phone, the header pill on a desktop -- never both', () => {
    // The page still hands the hero its pill (the phone needs it)...
    expect(read('../pages/CharacterDetailPage.tsx')).toContain('topRight={<CreditsPill />}');
    // ...and the hero hides it from lg, where the desktop header shows the balance.
    expect(read('./profile/ProfileHero.tsx')).toContain(
      '{topRight && <span className="rounded-xl bg-black/40 backdrop-blur lg:hidden">{topRight}</span>}',
    );
    expect(shell).not.toMatch(/pageShowsCredits = isProfile/);
  });
});

describe('notifications are not given any new scope by the desktop header', () => {
  const bell = (html: string) => html.match(/<button[^>]*aria-label="Notifications[^"]*"[\s\S]*?<\/button>/)?.[0];

  it('the bell is the phone top bar’s own, byte for byte: same count, same size, same badge', () => {
    const phone = bell(at('/characters', <LobbyTopBar />));
    const desktop = bell(at('/characters', <DesktopHeader extras={<LobbyActions withAccount={false} />} />));
    expect(phone).toBeDefined();
    expect(desktop).toBe(phone);
  });

  it('it appears only on Home, as on a phone -- no other desktop screen gains it', () => {
    expect(read('./AppShell.tsx')).toContain('extras={isLobby ? <LobbyActions onSearch={focusLobbySearch} withAccount={false} /> : undefined}');
    expect(at('/favourites', <DesktopHeader />)).not.toContain('Notifications');
  });

  it('the offer capsule claims no discount: "Upgrade" until the server says Premium, on phone and desktop alike', () => {
    for (const header of [at('/characters', <LobbyTopBar />), at('/characters', <DesktopHeader extras={<LobbyActions withAccount={false} />} />)]) {
      expect(header).toMatch(/href="\/subscription"[^>]*from-rose-500 to-fuchsia-600[^>]*>.*Upgrade<\/a>/);
      expect(header).not.toMatch(/\d+%/);
    }
    const tier = (value: string) => ({ status: 'ready', overview: { commercial: { tier: { available: true, value } } } }) as unknown as CustomerEconomyState;
    expect(offerLabel(tier('premium'))).toBe('Premium');
    expect(offerLabel(tier('free'))).toBe('Upgrade');
    expect(offerLabel({ status: 'signed-out' } as CustomerEconomyState)).toBe('Upgrade');
    expect(offerLabel({ status: 'loading' } as CustomerEconomyState)).toBe('Upgrade');
    // The tier unavailable (economy off): no claim of membership.
    expect(offerLabel({ status: 'ready', overview: { commercial: { tier: { available: false } } } } as unknown as CustomerEconomyState)).toBe('Upgrade');
  });

  it('the desktop header passes no count of its own', () => {
    expect(read('./AppShell.tsx')).not.toMatch(/notificationCount/);
  });
});
