import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import SwipeCard from './SwipeCard';
import DiscoverActions from './DiscoverActions';
import FavouritesPage from '../pages/FavouritesPage';
import type { PublicPlayWithMeCard } from '../lib/api';

/**
 * The Swipe and Favourites SURFACES: what can and cannot reach the markup.
 *
 * Static node rendering, like the rest of this repo's web tests. The point of
 * these is not layout — it is that the placeholder/demo/portrait fallbacks that
 * used to fill the deck have no path here any more, and that the heart is a
 * readout of stored state rather than a local animation.
 */

const router = (node: React.ReactNode) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

/**
 * A module's CODE, with comments stripped.
 *
 * The "this surface cannot reach the fallback chain" assertions below are about
 * what the module can CALL, and every one of those modules explains in prose
 * which fallbacks it deliberately avoids. Matching raw source text would fail
 * on the explanation rather than on the behaviour — so the prose comes out
 * first and the assertions read the code alone.
 */
function codeOf(relativePath: string): string {
  const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function card(over: Partial<PublicPlayWithMeCard> = {}): PublicPlayWithMeCard {
  return {
    id: 'char-1',
    displayName: 'Nova',
    apparentAgeBand: 'late 20s',
    categories: [{ slug: 'sexy', name: 'Sexy' }],
    clip: {
      id: 'asset-1',
      mediaType: 'video',
      url: '/api/media/assets/asset-1/file',
      characterId: 'char-1',
      characterName: 'Nova',
    },
    ...over,
  };
}

describe('SwipeCard — real published content only', () => {
  it('renders the character and her CMS clip as a video source', () => {
    const html = router(<SwipeCard character={card()} />);
    expect(html).toContain('Nova');
    expect(html).toContain('/api/media/assets/asset-1/file');
    expect(html).toContain('<video');
  });

  it('renders NOTHING when the character has no clip — never a lettered tile', () => {
    const html = router(<SwipeCard character={card({ clip: null })} />);
    expect(html).toBe('');
  });

  it('renders NOTHING for an image clip — these surfaces are video', () => {
    const still = { ...card().clip!, mediaType: 'image' as const };
    expect(router(<SwipeCard character={card({ clip: still })} />)).toBe('');
  });

  it('shows real CMS category chips, not derived ones', () => {
    expect(router(<SwipeCard character={card()} />)).toContain('Sexy');
  });
});

describe('the swipe card cannot reach the placeholder fallback chain', () => {
  const source = codeOf('./SwipeCard.tsx');

  /**
   * `resolveHeroMedia` is the function whose chain ends in a demo manifest, a
   * canonical reference portrait, a profileImage and finally an initial-letter
   * tile. It is CORRECT for the Character page and stays there; what matters is
   * that the swipe card cannot call it. `resolveRailMedia` returns the server's
   * clip or null and has no other source.
   */
  it('imports resolveRailMedia and never resolveHeroMedia', () => {
    expect(source).toContain('resolveRailMedia');
    expect(source).not.toContain('resolveHeroMedia');
  });

  it('references no demo manifest, profile image or placeholder', () => {
    expect(source).not.toContain('characterMedia');
    expect(source).not.toContain('DEMO_MEDIA_OVERRIDES');
    expect(source).not.toContain('profileImage');
    expect(source).not.toContain('placeholder');
    expect(source).not.toContain('firstCanonicalImage');
  });

  /** The card that COULD reach that chain is gone from this surface entirely. */
  it('the old DiscoverCard is no longer part of the deck', () => {
    const deck = codeOf('./SwipeDeck.tsx');
    expect(deck).not.toContain('DiscoverCard');
    expect(deck).toContain('SwipeCard');
  });
});

describe('the heart reflects the PERSISTED favourite state', () => {
  const actions = (favourited: boolean, favouriteDisabled = false) =>
    renderToStaticMarkup(
      <DiscoverActions
        onPass={() => {}}
        onOpen={() => {}}
        onToggleFavourite={() => {}}
        favourited={favourited}
        favouriteDisabled={favouriteDisabled}
      />,
    );

  it('is outline (stroked, unfilled) when she is NOT a favourite', () => {
    const html = actions(false);
    expect(html).toContain('data-favourited="false"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Add to Favourites');
    // The unfilled heart is stroked; nothing on this control is solid.
    expect(html).toContain('bg-transparent');
    expect(html).not.toContain('fill="currentColor"');
  });

  it('is fully filled when she IS a favourite', () => {
    const html = actions(true);
    expect(html).toContain('data-favourited="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Remove from Favourites');
    expect(html).toContain('fill="currentColor"');
  });

  it('is green in both states — the fill changes, the colour does not', () => {
    expect(actions(false)).toContain('emerald');
    expect(actions(true)).toContain('emerald');
  });

  it('can be disabled on its own, leaving pass and open profile usable', () => {
    const html = actions(false, true);
    // Exactly one of the three controls is disabled.
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-label="Pass"');
    expect(html).toContain('aria-label="Open profile"');
  });

  /**
   * The heart is state, not a second right-swipe button. If it took an
   * `onLike`-style prop that flung the card, tapping a full heart could never
   * remove a favourite — the card would be gone first.
   */
  it('exposes a toggle, not a like action', () => {
    const source = codeOf('./DiscoverActions.tsx');
    expect(source).toContain('onToggleFavourite');
    expect(source).not.toContain('onLike');
  });
});

describe('FavouritesPage', () => {
  /**
   * The page fetches on mount, so a static render is its loading state. What is
   * worth pinning here is that the loading state is a neutral skeleton and
   * contains no invented content of its own.
   */
  it('renders its heading and a content-free skeleton before data arrives', () => {
    const html = router(<FavouritesPage />);
    expect(html).toContain('Favourites');
    expect(html).toContain('favourites-skeleton');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<video');
  });

  it('cannot reach the placeholder fallback chain either', () => {
    const source = codeOf('../pages/FavouritesPage.tsx');
    expect(source).toContain('resolveRailMedia');
    expect(source).not.toContain('resolveHeroMedia');
    expect(source).not.toContain('profileImage');
    expect(source).not.toContain('characterMedia');
  });

  /** A favourite is a character, not a clip: nothing here stores a media id. */
  it('reads no stored media locator from the favourite', () => {
    const source = codeOf('../pages/FavouritesPage.tsx');
    expect(source).not.toContain('assetId');
    expect(source).not.toContain('clipId');
  });
});

describe('no surface in this feature uses localStorage', () => {
  it('holds favourites on the server only', () => {
    for (const file of [
      '../hooks/useFavourites.ts',
      '../lib/favourites.ts',
      '../pages/FavouritesPage.tsx',
      '../pages/SwipePage.tsx',
    ]) {
      const source = codeOf(file);
      expect(source).not.toContain('localStorage');
      expect(source).not.toContain('sessionStorage');
    }
  });
});
