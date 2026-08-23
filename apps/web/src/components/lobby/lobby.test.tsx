import { describe, expect, it } from 'vitest';
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
  return { id, displayName: `Name ${id}`, shortBio: 'bio', clip: clip(id) };
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

describe('the header no longer carries Search', () => {
  const markup = router(<LobbyTopBar />);

  it('has no search control', () => {
    expect(markup).not.toContain('aria-label="Search"');
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
