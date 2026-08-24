import { describe, expect, it } from 'vitest';
import {
  bannerHref,
  defaultCategorySlug,
  homeIsEmpty,
  homeSections,
  nextView,
  PLAY_WITH_ME_TITLE,
  resultsLabel,
} from './homeContent';
import type { PublicCategoryRail, PublicCharacterCard, PublicClip, PublicHome } from './api';

/**
 * US-102.4 Home arrangement logic.
 *
 * The rules worth pinning here are the ones that would be silent if broken: the
 * fixed rail order, that nothing is invented when the CMS is empty, and that a
 * banner with no real destination never becomes a dead link.
 */

function clip(id: string): PublicClip {
  return {
    id,
    mediaType: 'image',
    url: `/api/media/assets/${id}/file`,
    characterId: `char-${id}`,
    characterName: `Character ${id}`,
  };
}

function card(id: string): PublicCharacterCard {
  return {
    id,
    name: id,
    displayName: `Name ${id}`,
    shortBio: 'bio',
    profileImage: null,
    categories: [],
    clip: clip(`clip-${id}`),
  };
}

function rail(id: string, clips: PublicClip[] = [clip(`${id}-a`)]): PublicCategoryRail {
  return { id, slug: id, name: `Rail ${id}`, tagline: null, clips };
}

function home(overrides: Partial<PublicHome> = {}): PublicHome {
  return {
    banners: { before_search: [], below_results: [] },
    hero: [],
    playWithMe: [],
    categories: [],
    ...overrides,
  };
}

describe('rail order is fixed, and the operator controls only the tail', () => {
  it('puts Play with me first, then the CMS categories', () => {
    const sections = homeSections(
      home({ playWithMe: [card('a')], categories: [rail('one'), rail('two')] }),
    );
    expect(sections.map((s) => s.kind)).toEqual(['play_with_me', 'category', 'category']);
    expect(sections[0].title).toBe(PLAY_WITH_ME_TITLE);
  });

  it('has NO Recently Added section kind at all', () => {
    // Removed as a product feature, not hidden behind a flag. There is no
    // branch that could render it and no title constant to reach for.
    const sections = homeSections(
      home({ playWithMe: [card('a')], categories: [rail('one')] }),
    );
    expect(sections.map((s) => s.kind)).not.toContain('recently_added');
    expect(JSON.stringify(sections)).not.toMatch(/recently/i);
  });

  it('keeps the categories in the order the server sent them', () => {
    const sections = homeSections(home({ categories: [rail('z'), rail('a'), rail('m')] }));
    expect(sections.map((s) => s.rail!.id)).toEqual(['z', 'a', 'm']);
  });

  it('drops a published category whose content is all unapproved', () => {
    // A published category with nothing renderable should show nothing, not an
    // empty heading — the operator sees the warning in Admin instead.
    const sections = homeSections(home({ categories: [rail('empty', []), rail('full')] }));
    expect(sections.map((s) => s.rail!.id)).toEqual(['full']);
  });

  it('omits the system rail when it has no characters', () => {
    expect(homeSections(home({ playWithMe: [] })).map((s) => s.kind)).toEqual([]);
    expect(homeSections(home({ playWithMe: [card('a')] })).map((s) => s.kind)).toEqual([
      'play_with_me',
    ]);
  });

  it('invents nothing at all for an empty Home', () => {
    expect(homeSections(home())).toEqual([]);
    expect(homeIsEmpty(home())).toBe(true);
  });

  it('is not empty when only a banner is published', () => {
    const withBanner = home({
      banners: {
        before_search: [
          {
            id: 'b1',
            title: 'Promo',
            subtitle: null,
            ctaLabel: null,
            creativeUrl: null,
            creativeMediaType: null,
            destination: { kind: 'external', categoryId: null, characterId: null, assetId: null, url: 'https://e.com' },
          },
        ],
        below_results: [],
      },
    });
    expect(homeIsEmpty(withBanner)).toBe(false);
  });

  it('gives every section a stable distinct key', () => {
    const sections = homeSections(
      home({ playWithMe: [card('a')], categories: [rail('one'), rail('two')] }),
    );
    expect(new Set(sections.map((s) => s.key)).size).toBe(sections.length);
  });
});

describe('banner destinations', () => {
  const destination = (over: Partial<{ kind: string; characterId: string | null; url: string | null }>) => ({
    destination: {
      kind: 'external',
      categoryId: null,
      characterId: null,
      assetId: null,
      url: null,
      ...over,
    },
  });

  it('links a character banner to that character', () => {
    expect(bannerHref(destination({ kind: 'character', characterId: 'c1' }))).toBe('/characters/c1');
  });

  it('passes an external link through untouched', () => {
    // The server already validated it as https with no credentials; re-deriving
    // that rule here would create a second definition that could drift.
    expect(bannerHref(destination({ kind: 'external', url: 'https://e.com/x' }))).toBe(
      'https://e.com/x',
    );
  });

  it('returns null rather than inventing a route that does not exist', () => {
    // Home has no per-category or per-clip screen in this ticket.
    expect(bannerHref(destination({ kind: 'category' }))).toBeNull();
    expect(bannerHref(destination({ kind: 'content' }))).toBeNull();
    expect(bannerHref(destination({ kind: 'character', characterId: null }))).toBeNull();
    expect(bannerHref(destination({ kind: 'external', url: null }))).toBeNull();
    expect(bannerHref(destination({ kind: 'nonsense' }))).toBeNull();
  });
});

describe('the default discovery category is data, not a constant', () => {
  it('is whatever the operator ordered first', () => {
    expect(defaultCategorySlug([{ slug: 'sexy' }, { slug: 'cosplay' }])).toBe('sexy');
    expect(defaultCategorySlug([{ slug: 'cosplay' }, { slug: 'sexy' }])).toBe('cosplay');
  });

  it('has no hard-coded fallback — an empty strip has no default', () => {
    // The old lobby hard-coded "All" in first position. Nothing does that now.
    expect(defaultCategorySlug([])).toBeNull();
  });
});

describe('results view', () => {
  it('toggles between grid and feed and nothing else', () => {
    expect(nextView('grid')).toBe('feed');
    expect(nextView('feed')).toBe('grid');
  });

  it('describes the result set for each filter combination', () => {
    expect(resultsLabel(3, '', null)).toBe('3 clips');
    expect(resultsLabel(1, '', null)).toBe('1 clip');
    expect(resultsLabel(2, '', 'Sexy')).toBe('2 clips in Sexy');
    expect(resultsLabel(5, 'luna', 'Sexy')).toBe('5 clips matching "luna"');
    expect(resultsLabel(0, '   ', 'Sexy')).toBe('0 clips in Sexy');
  });
});
