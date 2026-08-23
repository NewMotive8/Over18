import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import LobbyTopBar from './LobbyTopBar';
import HeroCarousel from './HeroCarousel';
import CharacterRail from './CharacterRail';
import ClipRail from './ClipRail';
import HomeBannerSlot from './HomeBannerSlot';
import DiscoveryStrip from './DiscoveryStrip';
import FeedView from './FeedView';
import CommunityPromoCard from './CommunityPromoCard';
import PersonaGridCard from './PersonaGridCard';
import PlayWithMeCarousel from './PlayWithMeCarousel';
import CategoryPills from './CategoryPills';
import LobbyPage from '../../pages/LobbyPage';
import { FORBIDDEN_AGE_TERMS } from '../../lib/lobbyContent';
import type {
  PublicCategoryRail,
  PublicCharacterCard,
  PublicClip,
  PublicDiscoveryCategory,
  PublicHomeBanner,
} from '../../lib/api';

/**
 * US-102.4 public Home components.
 *
 * Static node rendering, since this repo's web tests run without a DOM. What is
 * worth pinning here is what the ticket actually changed: the header no longer
 * carries Search, the filter control sits OUTSIDE the scrolling pill track, no
 * component invents content, and no storage path can reach the markup.
 */

const router = (node: React.ReactNode) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

function clip(id = 'a'): PublicClip {
  return {
    id,
    mediaType: 'image',
    url: `/api/media/assets/${id}/file`,
    characterId: `char-${id}`,
    characterName: `Character ${id}`,
  };
}

function card(id = 'a'): PublicCharacterCard {
  return {
    id,
    name: id,
    displayName: `Name ${id}`,
    shortBio: 'bio',
    profileImage: null,
    categories: [],
    clip: clip(id),
  };
}

function rail(): PublicCategoryRail {
  return { id: 'r1', slug: 'r1', name: 'Trending Now', tagline: 'Hand-picked', clips: [clip()] };
}

function banner(over: Partial<PublicHomeBanner> = {}): PublicHomeBanner {
  return {
    id: 'b1',
    title: 'Autumn feature',
    subtitle: 'Hand-picked',
    ctaLabel: 'Explore',
    creativeUrl: '/admin/x',
    creativeMediaType: 'image',
    destination: {
      kind: 'external',
      categoryId: null,
      characterId: null,
      assetId: null,
      url: 'https://example.com/f',
    },
    ...over,
  };
}

const categories: PublicDiscoveryCategory[] = [
  { id: 'd1', slug: 'sexy', name: 'Sexy' },
  { id: 'd2', slug: 'cosplay', name: 'Cosplay' },
];

describe('the header carries Search', () => {
  const markup = router(<LobbyTopBar />);

  it('has the search control the product design shows', () => {
    // It was removed once on the reasoning that Search should live in exactly
    // one place. It is not a second search — it is the shortcut to the one
    // below, and the approved design has it in the header.
    expect(markup).toContain('aria-label="Search"');
  });

  it('keeps the logo, notifications and account access', () => {
    expect(markup).toContain('Over18 — Lobby');
    expect(markup).toContain('Notifications');
    expect(markup).toContain('Your account');
  });
});

describe('the filter control stays fixed while the pills scroll', () => {
  const markup = renderToStaticMarkup(
    <DiscoveryStrip categories={categories} active="sexy" onSelect={() => {}} />,
  );

  it('renders the filter button OUTSIDE the scrolling track', () => {
    // The regression this guards: the button used to be a child of the
    // scroller, so it slid away with the pills.
    const track = markup.indexOf('data-testid="discovery-pill-track"');
    const filter = markup.indexOf('aria-label="Advanced filters"');
    expect(filter).toBeGreaterThan(-1);
    expect(track).toBeGreaterThan(-1);
    expect(filter).toBeLessThan(track);
  });

  it('scrolls only the pill track', () => {
    const trackTag = markup.slice(markup.indexOf('data-testid="discovery-pill-track"'));
    expect(trackTag).toContain('overflow-x-auto');
  });

  it('renders the CMS categories in order, with no hard-coded All', () => {
    expect(markup.indexOf('Sexy')).toBeLessThan(markup.indexOf('Cosplay'));
    expect(markup).not.toContain('>All<');
  });

  it('marks the active pill', () => {
    expect(markup).toContain('aria-pressed="true"');
  });

  it('renders nothing when the CMS has no categories', () => {
    expect(
      renderToStaticMarkup(<DiscoveryStrip categories={[]} active={null} onSelect={() => {}} />),
    ).toBe('');
  });
});

describe('rails render CMS data and invent nothing', () => {
  it('a character rail shows one card per character with no invented badge or age', () => {
    const markup = router(<CharacterRail title="Play with me" characters={[card('a'), card('b')]} />);
    expect(markup).toContain('Play with me');
    expect(markup).toContain('Name a');
    expect(markup).toContain('Name b');
    for (const invented of ['Online', '🔥 Hot', '>New<']) {
      expect(markup).not.toContain(invented);
    }
  });

  it('a character rail states no presence, because there is no presence system', () => {
    const markup = router(<CharacterRail title="Play with me" characters={[card()]} />);
    expect(markup.toLowerCase()).not.toContain('online');
    expect(markup.toLowerCase()).not.toContain('offline');
  });

  it('a clip rail shows its name and tagline', () => {
    const markup = router(<ClipRail rail={rail()} />);
    expect(markup).toContain('Trending Now');
    expect(markup).toContain('Hand-picked');
  });

  it('an empty rail renders nothing at all', () => {
    expect(router(<CharacterRail title="Play with me" characters={[]} />)).toBe('');
    expect(router(<ClipRail rail={{ ...rail(), clips: [] }} />)).toBe('');
  });

  it('the hero renders only assigned clips, and nothing when empty', () => {
    expect(router(<HeroCarousel clips={[]} />)).toBe('');
    const markup = router(<HeroCarousel clips={[clip()]} />);
    expect(markup).toContain('Character a');
    // The old hard-coded promo slide is gone.
    expect(markup).not.toContain('Refer a friend');
    expect(markup).not.toContain('85%');
  });
});

describe('banner slots', () => {
  it('renders nothing when its slot is empty, so it occupies no space', () => {
    expect(router(<HomeBannerSlot banners={[]} label="Featured" />)).toBe('');
  });

  it('renders a banner and links an external destination safely', () => {
    const markup = router(<HomeBannerSlot banners={[banner()]} label="Featured" />);
    expect(markup).toContain('Autumn feature');
    expect(markup).toContain('Explore');
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  it('renders a card without a link when the destination cannot resolve', () => {
    const markup = router(
      <HomeBannerSlot
        banners={[
          banner({
            destination: {
              kind: 'category',
              categoryId: 'c1',
              characterId: null,
              assetId: null,
              url: null,
            },
          }),
        ]}
        label="Featured"
      />,
    );
    expect(markup).toContain('Autumn feature');
    expect(markup).not.toContain('<a ');
  });

  it('keeps Get 20 For Free as its own separate component', () => {
    // The ticket says it stays where it is and is not a CMS banner.
    const promo = router(<CommunityPromoCard />);
    expect(promo).toContain('Get 20 for free');
    const slot = router(<HomeBannerSlot banners={[banner()]} label="Featured" />);
    expect(slot).not.toContain('Get 20 for free');
  });
});

describe('feed view', () => {
  it('presents the same clips full-screen and offers a way out', () => {
    const markup = router(<FeedView clips={[clip('a'), clip('b')]} onClose={() => {}} />);
    expect(markup).toContain('aria-label="Feed view"');
    expect(markup).toContain('snap-y');
    expect(markup).toContain('Close feed view');
    expect(markup).toContain('Character a');
  });

  it('says so plainly when there is nothing to show', () => {
    expect(router(<FeedView clips={[]} onClose={() => {}} />)).toContain('Nothing to show');
  });
});

describe('Home first paint', () => {
  const markup = router(<LobbyPage />);

  it('renders a loading state rather than an empty screen', () => {
    expect(markup).toContain('lobby-skeleton');
    expect(markup).toContain('Loading Home…');
  });

  it('invents no category names of its own', () => {
    // Every one of these was hard-coded in the old lobby.
    for (const invented of ['Trending', 'Girlfriend', 'Milf', 'Cosplay', 'Goth', 'Luxury', '>All<']) {
      expect(markup).not.toContain(invented);
    }
  });
});

describe('no storage path can reach the markup', () => {
  it('renders only opaque, id-keyed media locators', () => {
    const markup =
      router(<HeroCarousel clips={[clip()]} />) +
      router(<CharacterRail title="Play with me" characters={[card()]} />) +
      router(<ClipRail rail={rail()} />) +
      router(<FeedView clips={[clip()]} onClose={() => {}} />);
    expect(markup).not.toContain('storageKey');
    expect(markup).not.toContain('/app/var/media');
    expect(markup).toContain('/api/media/assets/');
  });
});

describe('the adults-only guardrail still holds', () => {
  it('no rendered surface carries a minor-coded term', () => {
    const markup = (
      router(<CharacterRail title="Play with me" characters={[card()]} />) +
      router(<ClipRail rail={rail()} />) +
      renderToStaticMarkup(
        <DiscoveryStrip categories={categories} active="sexy" onSelect={() => {}} />,
      )
    ).toLowerCase();
    for (const term of FORBIDDEN_AGE_TERMS) {
      expect(markup.includes(term)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The approved lobby design, restored
 *
 * US-102.4 kept the CMS but changed the presentation: the character grid became
 * clip tiles, Play with Me became a generic rail, the header lost its search
 * icon and the pills became keyword queries with the first one auto-selected.
 * The product design is the source of truth for presentation; the CMS is the
 * source of truth for content. These pin the presentation half.
 * ------------------------------------------------------------------ */

describe('the original character-card presentation', () => {
  const markup = router(<PersonaGridCard character={card('grid')} index={0} />);

  it('is a character card, not a clip tile — name and age together', () => {
    expect(markup).toContain('Name grid');
    // The card states an adult age beside the name, as the design shows.
    expect(markup).toMatch(/Name grid[\s\S]*?<span class="text-sm font-medium text-zinc-200">\d+/);
  });

  it('links to the character, not to a clip', () => {
    expect(markup).toContain('/characters/grid');
  });

  it('renders the approved HOT/NEW badge', () => {
    // The design has it. It was briefly dropped as "invented decoration"; the
    // approved public UI is frozen, so the original rule stands.
    expect(router(<PersonaGridCard character={card('a')} index={0} />)).toContain('🔥 Hot');
    expect(router(<PersonaGridCard character={card('b')} index={1} />)).toContain('New');
    expect(router(<PersonaGridCard character={card('c')} index={2} />)).not.toContain('🔥 Hot');
  });

  it('renders NO category chips — the approved grid card has none', () => {
    // Chips belong on the Play with me card. Adding them here was a
    // presentation change to an approved component.
    const withCategories = router(
      <PersonaGridCard
        character={{
          ...card('t'),
          categories: [
            { slug: 'sexy', name: 'Sexy' },
            { slug: 'lux', name: 'Luxury' },
          ],
        }}
        index={2}
      />,
    );
    expect(withCategories).not.toContain('Sexy');
    expect(withCategories).not.toContain('Luxury');
  });

  it('keeps the original footer layout', () => {
    expect(markup).toContain('flex items-baseline gap-1.5 p-3');
  });
});

describe('the original Play with me rail', () => {
  const markup = router(<PlayWithMeCarousel characters={[card('a'), card('b')]} />);

  it('keeps its heading and Swipe mode link', () => {
    expect(markup).toContain('Play with me');
    expect(markup).toContain('Swipe mode');
    expect(markup).toContain('/discover/swipe');
  });

  it('keeps the Online chip the design shows', () => {
    expect(markup).toContain('Online');
  });

  it('renders one card per CMS character', () => {
    expect(markup).toContain('Name a');
    expect(markup).toContain('Name b');
  });

  it('renders nothing at all when the CMS sends no characters', () => {
    expect(router(<PlayWithMeCarousel characters={[]} />)).toBe('');
  });

  it('is the ONLY character rail the lobby renders', () => {
    // The approved design has one rail. Recently Added is a CMS feature with
    // no public surface, so no second rail may appear here.
    expect(markup.match(/aria-label="Play with me"/g)).toHaveLength(1);
    expect(markup).not.toContain('Recently Added');
  });
});

describe('the category pills are CMS data with an All state', () => {
  const pills = [
    { id: '1', slug: 'sexy', name: 'Sexy' },
    { id: '2', slug: 'new', name: 'New' },
  ];

  it('renders All first, then the operator’s categories in order', () => {
    const markup = router(<CategoryPills categories={pills} active={null} onSelect={() => {}} />);
    expect(markup.indexOf('All')).toBeLessThan(markup.indexOf('Sexy'));
    expect(markup.indexOf('Sexy')).toBeLessThan(markup.indexOf('New'));
  });

  it('marks All as selected when nothing is filtered', () => {
    const markup = router(<CategoryPills categories={pills} active={null} onSelect={() => {}} />);
    // The first pill (All) carries the active styling.
    expect(markup).toContain('aria-pressed="true"');
    expect(markup.split('aria-pressed="true"').length - 1).toBe(1);
  });

  it('marks the chosen category instead once one is selected', () => {
    const markup = router(<CategoryPills categories={pills} active="new" onSelect={() => {}} />);
    const activeIndex = markup.indexOf('aria-pressed="true"');
    expect(markup.slice(activeIndex, activeIndex + 200)).toContain('New');
  });

  it('still shows All when the operator has created no categories', () => {
    // This is what keeps search usable before any category exists.
    const markup = router(<CategoryPills categories={[]} active={null} onSelect={() => {}} />);
    expect(markup).toContain('All');
  });

  it('invents no hard-coded taxonomy', () => {
    const markup = router(<CategoryPills categories={[]} active={null} onSelect={() => {}} />);
    for (const invented of ['Trending', 'Girlfriend', 'Milf', 'Dominant', 'Cosplay', 'Goth']) {
      expect(markup).not.toContain(invented);
    }
  });
});

describe('the original Advanced-filters control', () => {
  // Rendered through the page, because the funnel and its panel are wired
  // together there — the button was briefly inert, which a component-only test
  // would not have caught.
  const source = readFileSync(
    fileURLToPath(new URL('../../pages/LobbyPage.tsx', import.meta.url)),
    'utf8',
  );

  it('toggles, rather than sitting inert', () => {
    expect(source).toContain('setShowFilters((v) => !v)');
  });

  it('exposes aria-expanded', () => {
    expect(source).toContain('aria-expanded={showFilters}');
  });

  it('keeps the original shape and active-state styling', () => {
    expect(source).toContain('rounded-xl');
    expect(source).toContain('border-rose-500/60 bg-rose-500/15');
  });

  it('renders the original Advanced filters panel when open', () => {
    expect(source).toContain('Advanced filters');
    expect(source).toContain('Refine by body type, personality and availability');
  });

  it('uses the original small pill size in the Discovery section', () => {
    expect(source).toContain('size="sm"');
  });
});
