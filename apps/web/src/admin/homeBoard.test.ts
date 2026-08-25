import { describe, expect, it } from 'vitest';
import {
  contentSummary,
  emptyReason,
  heroFallbackNote,
  heroMode,
  heroModeLabel,
  HOME_SLOTS,
  previewSummary,
  publishedInOrder,
  slotLabel,
  summariseHome,
  unpublished,
} from './homeBoard';
import * as board from './homeBoard';
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

/* ------------------------------------------------------------------ *
 * Recently Added is GONE
 *
 * It was removed as a product feature, not disabled. These tests replace the
 * mode-label, picker and add-consequence suites that used to live here: the
 * module must no longer export anything that could rebuild that rail.
 * ------------------------------------------------------------------ */

describe('Recently Added has no admin surface left', () => {
  it('exports no Recently Added helper of any kind', () => {
    const names = Object.keys(board);
    for (const name of names) expect(name).not.toMatch(/recent/i);
  });

  it('still exports the Home-composition helpers that remain', () => {
    // The removal must not have taken the surviving surfaces with it.
    expect(typeof board.publishedInOrder).toBe('function');
    expect(typeof board.previewSummary).toBe('function');
    expect(typeof board.heroMode).toBe('function');
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
      playWithMe: [
        { id: 'p', displayName: 'P', apparentAgeBand: null, categories: [], clip: null },
      ],
      categories: [
        { id: 'r', slug: 'r', name: 'R', tagline: null, clips: [{ id: 'x', mediaType: 'image', url: '/u', characterId: 'c', characterName: 'C' }] },
        { id: 'empty', slug: 'e', name: 'E', tagline: null, clips: [] },
      ],
      categoryPills: [],
      browseClips: [],
    };
    const summary = previewSummary(home);
    expect(summary).toContain('1 hero clip');
    expect(summary).toContain('1 in Play with me');
    expect(summary).not.toMatch(/recently/i);
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

/* ------------------------------------------------------------------ *
 * Hero: configured versus fallback
 *
 * The app shows borrowed clips when nothing is assigned, so the Admin must
 * never let those two states look alike — an operator seeing a full Hero on
 * the app would otherwise assume it was theirs.
 * ------------------------------------------------------------------ */

const heroClip = (id: string) => ({
  id,
  mediaType: 'image' as const,
  url: `/api/media/assets/${id}/file`,
  characterId: `c-${id}`,
  characterName: `C ${id}`,
});

describe('the Hero states are never confusable', () => {
  it('is CONFIGURED the moment one clip is assigned', () => {
    expect(heroMode([])).toBe('fallback');
    expect(heroMode([{}])).toBe('configured');
    expect(heroMode([{}, {}, {}])).toBe('configured');
  });

  it('says the configured Hero is exact', () => {
    const said = heroModeLabel('configured');
    expect(said).toContain('exactly these clips');
    expect(said).toContain('order');
  });

  it('says the fallback is temporary and not a choice', () => {
    const said = heroModeLabel('fallback');
    expect(said).toContain('Not configured');
    expect(said).toContain('temporarily');
  });

  it('the fallback note says borrowed, not saved, and replaceable', () => {
    const said = heroFallbackNote([heroClip('a'), heroClip('b')]);
    expect(said).toContain('Borrowed');
    expect(said).toContain('2 clips');
    expect(said).toContain('not saved');
    expect(said).toContain('replaces it entirely');
  });

  it('explains an empty fallback rather than going silent', () => {
    expect(heroFallbackNote([])).toContain('empty on the app');
  });

  it('singularises one borrowed clip', () => {
    expect(heroFallbackNote([heroClip('a')])).toContain('1 clip ');
  });
});

/* ------------------------------------------------------------------ *
 * Play with me
 *
 * The rail has exactly two states and an operator must always be able to tell
 * which one they are in, because the first edit is a one-way door until Reset.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Play with me has NO ADMIN SURFACE
 *
 * These replace the mode-label, picker and add-consequence suites. The rail is
 * one rule — active character, her newest publicly reachable video, one card —
 * so there are no modes to label and no rows to derive.
 * ------------------------------------------------------------------ */

describe('Play with me has no admin surface left', () => {
  it('exports no Play with me helper of any kind', () => {
    for (const name of Object.keys(board)) expect(name).not.toMatch(/playwithme/i);
  });

  it('exports no rail-curation vocabulary at all', () => {
    // Neither rail has an automatic-versus-curated model any more.
    for (const name of Object.keys(board)) {
      expect(name).not.toMatch(/recent/i);
      expect(name).not.toMatch(/pickerrows/i);
      expect(name).not.toMatch(/consequence/i);
    }
  });

  it('still exports the Hero helpers, which DO remain curated', () => {
    // The Hero is deliberately untouched by this release.
    expect(typeof board.heroMode).toBe('function');
    expect(typeof board.heroModeLabel).toBe('function');
    expect(typeof board.heroFallbackNote).toBe('function');
  });
});
