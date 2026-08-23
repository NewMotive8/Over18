import { describe, expect, it } from 'vitest';
import {
  contentSummary,
  emptyReason,
  HOME_SLOTS,
  previewSummary,
  publishedInOrder,
  recentModeLabel,
  slotLabel,
  summariseHome,
  unpublished,
} from './homeBoard';
import { activePublishingTab } from './PublishingTabs';
import type { HomeCategoryView, PublicHome } from '../lib/api';

/**
 * US-102.4 admin Home-composition presentation.
 *
 * The behaviours worth pinning: Home order is its own order, a published
 * category that would render nothing says WHY, and the two systems keep
 * separate tabs.
 */

function category(over: Partial<HomeCategoryView> = {}): HomeCategoryView {
  return {
    id: 'c1',
    slug: 'c1',
    name: 'Trending',
    tagline: null,
    enabled: true,
    homePublished: true,
    homePosition: 0,
    publishableAssetCount: 3,
    assetCount: 3,
    wouldRenderEmpty: false,
    ...over,
  };
}

describe('Home order is its own order', () => {
  it('sorts by homePosition, not by the CMS position', () => {
    const list = [
      category({ id: 'a', homePosition: 2 }),
      category({ id: 'b', homePosition: 0 }),
      category({ id: 'c', homePosition: 1 }),
    ];
    expect(publishedInOrder(list).map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('excludes unpublished categories from the arrangement', () => {
    const list = [category({ id: 'a' }), category({ id: 'b', homePublished: false })];
    expect(publishedInOrder(list).map((c) => c.id)).toEqual(['a']);
    expect(unpublished(list).map((c) => c.id)).toEqual(['b']);
  });

  it('breaks a position tie deterministically', () => {
    const list = [
      category({ id: 'zzz', homePosition: 0 }),
      category({ id: 'aaa', homePosition: 0 }),
    ];
    expect(publishedInOrder(list).map((c) => c.id)).toEqual(['aaa', 'zzz']);
  });

  it('counts what is published and what would render empty', () => {
    const totals = summariseHome([
      category({ id: 'a' }),
      category({ id: 'b', homePublished: false }),
      category({ id: 'c', wouldRenderEmpty: true }),
    ]);
    expect(totals).toEqual({ total: 3, published: 2, needsAttention: 1 });
  });
});

describe('a published category that would show nothing says why', () => {
  it('names a disabled category as the reason', () => {
    expect(emptyReason(category({ enabled: false }))).toContain('disabled');
  });

  it('distinguishes "no content" from "no APPROVED content"', () => {
    expect(emptyReason(category({ assetCount: 0, publishableAssetCount: 0 }))).toContain(
      'no content yet',
    );
    expect(emptyReason(category({ assetCount: 5, publishableAssetCount: 0 }))).toContain(
      'none of its content is approved',
    );
  });

  it('says nothing when the category is healthy or simply not published', () => {
    expect(emptyReason(category())).toBeNull();
    expect(emptyReason(category({ homePublished: false, publishableAssetCount: 0 }))).toBeNull();
  });

  it('summarises the approved-versus-assigned gap', () => {
    expect(contentSummary(category({ assetCount: 0 }))).toBe('No content assigned');
    expect(contentSummary(category({ assetCount: 3, publishableAssetCount: 3 }))).toBe('3 items');
    expect(contentSummary(category({ assetCount: 1, publishableAssetCount: 1 }))).toBe('1 item');
    expect(contentSummary(category({ assetCount: 11, publishableAssetCount: 8 }))).toBe(
      '8 of 11 approved',
    );
  });
});

describe('the two banner slots', () => {
  it('names both, in page order', () => {
    expect(HOME_SLOTS.map((s) => s.key)).toEqual(['before_search', 'below_results']);
    expect(slotLabel('before_search')).toBe('Before Search');
    expect(slotLabel('below_results')).toBe('Below results');
  });

  it('falls back to the raw value for an unknown slot', () => {
    expect(slotLabel('somewhere_else')).toBe('somewhere_else');
  });
});

describe('Recently Added mode', () => {
  it('explains automatic versus custom', () => {
    expect(recentModeLabel({ curated: false, characters: [] })).toContain('Automatic');
    expect(recentModeLabel({ curated: false, characters: [] })).toContain('12 newest');
    expect(recentModeLabel({ curated: true, characters: [] })).toContain('Custom');
  });
});

describe('preview summary', () => {
  it('counts what the app would build', () => {
    const home: PublicHome = {
      banners: {
        before_search: [
          {
            id: 'b',
            title: 't',
            subtitle: null,
            ctaLabel: null,
            creativeUrl: null,
            creativeMediaType: null,
            destination: { kind: 'external', categoryId: null, characterId: null, assetId: null, url: null },
          },
        ],
        below_results: [],
      },
      hero: [
        { id: 'h', mediaType: 'image', url: '/u', characterId: 'c', characterName: 'C' },
      ],
      playWithMe: [{ id: 'p', displayName: 'P', shortBio: '', clip: null }],
      recentlyAdded: [],
      categories: [
        { id: 'r', slug: 'r', name: 'R', tagline: null, clips: [{ id: 'x', mediaType: 'image', url: '/u', characterId: 'c', characterName: 'C' }] },
        { id: 'empty', slug: 'e', name: 'E', tagline: null, clips: [] },
      ],
    };
    const summary = previewSummary(home);
    expect(summary).toContain('1 hero clip');
    expect(summary).toContain('1 in Play with me');
    expect(summary).toContain('0 recently added');
    // The empty rail is not counted — the app would not render it.
    expect(summary).toContain('1 category rail');
    expect(summary).toContain('1 banner');
  });
});

describe('Home and Discovery are separate tabs', () => {
  it('routes each path to its own tab', () => {
    expect(activePublishingTab('/admin/publishing')).toBe('categories');
    expect(activePublishingTab('/admin/publishing/trending')).toBe('categories');
    expect(activePublishingTab('/admin/publishing/banners')).toBe('banners');
    expect(activePublishingTab('/admin/publishing/banners/abc')).toBe('banners');
    expect(activePublishingTab('/admin/publishing/home')).toBe('home');
    expect(activePublishingTab('/admin/publishing/discovery')).toBe('discovery');
  });
});
