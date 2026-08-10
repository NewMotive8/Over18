import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { PublicCharacter } from '@over18/shared';
import PersonaGridCard from './PersonaGridCard';
import CommunityPromoCard from './CommunityPromoCard';
import CategoryPills from './CategoryPills';
import HeroCarousel from './HeroCarousel';
import LobbyTopBar from './LobbyTopBar';
import { CATEGORIES, FORBIDDEN_AGE_TERMS, buildHeroSlides } from '../../lib/lobbyContent';

const luna: PublicCharacter = {
  id: 'c1',
  name: 'luna',
  displayName: 'Luna',
  profileImage: 'https://img/luna.png',
  shortBio: 'Night-owl astronomy grad student.',
  personality: 'p',
  interests: [],
  conversationStyle: 's',
};

function router(node: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('PersonaGridCard', () => {
  it('shows the name, a clearly-adult age, a badge, and links to the profile', () => {
    const html = router(<PersonaGridCard character={luna} index={0} />);
    expect(html).toContain('Luna');
    expect(html).toContain('26'); // safe adult default when no visual identity is loaded
    expect(html).toContain('Hot'); // index 0 badge
    expect(html).toContain('href="/characters/c1"');
  });
});

describe('CommunityPromoCard', () => {
  it('renders a non-persona engagement card with social proof and a CTA', () => {
    const html = router(<CommunityPromoCard />);
    expect(html).toContain('Get 20 for free');
    expect(html).toContain('online now');
    expect(html).toContain('Join the community');
    expect(html).toContain('href="/subscription"');
  });
});

describe('CategoryPills', () => {
  it('renders adult-safe categories and marks the active one', () => {
    const html = renderToStaticMarkup(
      <CategoryPills categories={CATEGORIES} active="All" onSelect={() => {}} />,
    );
    expect(html).toContain('All');
    expect(html).toContain('Milf');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('Teen');
  });
});

describe('HeroCarousel', () => {
  it('renders the promo headline, CTA and pagination across slides', () => {
    const html = router(<HeroCarousel slides={buildHeroSlides([luna])} />);
    expect(html).toContain('Refer a friend, get 85% off');
    expect(html).toContain('Spend the evening with Luna');
    expect(html).toContain('aria-label="Go to slide 2"');
  });
});

describe('adult-safety guard', () => {
  it('renders no minor-coded language anywhere across the lobby surfaces', () => {
    const html = (
      router(<LobbyTopBar />) +
      router(<PersonaGridCard character={luna} index={1} />) +
      router(<CommunityPromoCard />) +
      renderToStaticMarkup(<CategoryPills categories={CATEGORIES} active="All" onSelect={() => {}} />) +
      router(<HeroCarousel slides={buildHeroSlides([luna])} />)
    ).toLowerCase();

    for (const term of FORBIDDEN_AGE_TERMS) {
      expect(html.includes(term)).toBe(false);
    }
  });
});
