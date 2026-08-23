import { describe, expect, it } from 'vitest';
import {
  addPlayWithMeConsequence,
  addRecentConsequence,
  contentSummary,
  emptyReason,
  heroFallbackNote,
  heroMode,
  heroModeLabel,
  HOME_SLOTS,
  playWithMeModeLabel,
  playWithMePickerRows,
  previewSummary,
  publishedInOrder,
  recentModeLabel,
  recentPickerRows,
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

/* ------------------------------------------------------------------ *
 * The Recently Added picker
 *
 * The UAT gap this closes: the rail could be reordered, emptied and reset, but
 * a character could never be put BACK on it, because Admin had no Add control
 * at all. The endpoints already existed; only the picker was missing.
 * ------------------------------------------------------------------ */

const candidate = (id: string, displayName: string, createdAt = '2026-08-01T00:00:00.000Z') => ({
  characterId: id,
  displayName,
  createdAt,
});

const railEntry = (id: string, displayName: string, position: number) => ({
  characterId: id,
  displayName,
  status: 'active',
  position,
  createdAt: '2026-08-01T00:00:00.000Z',
  profileImage: null,
});

describe('the Recently Added picker', () => {
  const candidates = [candidate('a', 'Ada'), candidate('b', 'Bea'), candidate('c', 'Cass')];

  it("offers every candidate the server returned, in the server's order", () => {
    // Eligibility and ordering are the SERVER'S rule (active, newest first).
    // The picker must not re-sort or re-filter and quietly disagree with it.
    const rows = recentPickerRows(candidates, { curated: false, characters: [] });
    expect(rows.map((r) => r.characterId)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.displayName)).toEqual(['Ada', 'Bea', 'Cass']);
  });

  it('marks the ones already on the rail', () => {
    // The recent-candidates endpoint, unlike the Hero's, does not send this
    // flag — so an unmarked picker would offer buttons that do nothing.
    const rows = recentPickerRows(candidates, {
      curated: true,
      characters: [railEntry('b', 'Bea', 0)],
    });
    expect(rows.find((r) => r.characterId === 'b')!.onRail).toBe(true);
    expect(rows.find((r) => r.characterId === 'a')!.onRail).toBe(false);
    expect(rows.find((r) => r.characterId === 'c')!.onRail).toBe(false);
  });

  it('treats an automatic rail as occupied too — it is what is on screen', () => {
    // An automatic rail already SHOWS these characters. Offering "Add" for one
    // would be a no-op on the server: ensureCurated materialises the same list
    // and the insert then conflicts and does nothing.
    const rows = recentPickerRows(candidates, {
      curated: false,
      characters: [railEntry('a', 'Ada', 0), railEntry('c', 'Cass', 1)],
    });
    expect(rows.map((r) => [r.characterId, r.onRail])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
  });

  it('survives a rail that has not loaded yet', () => {
    expect(recentPickerRows(candidates, null).every((r) => !r.onRail)).toBe(true);
  });

  it('has nothing to offer when the server returns no candidates', () => {
    expect(recentPickerRows([], { curated: false, characters: [] })).toEqual([]);
  });

  it('re-marks a row as soon as the rail comes back with it — derived, not stored', () => {
    // The add flow refreshes the RAIL, not the candidate list. Deriving means
    // the row it came from cannot go on offering "Add" afterwards.
    const before = recentPickerRows(candidates, { curated: false, characters: [] });
    expect(before.find((r) => r.characterId === 'a')!.onRail).toBe(false);
    const after = recentPickerRows(candidates, {
      curated: true,
      characters: [railEntry('a', 'Ada', 0)],
    });
    expect(after.find((r) => r.characterId === 'a')!.onRail).toBe(true);
  });
});

describe('what adding will do to the rail', () => {
  it('warns that adding leaves automatic mode, before the operator commits', () => {
    const said = addRecentConsequence({ curated: false, characters: [] });
    expect(said).toContain('automatic');
    expect(said).toContain('custom');
    expect(said).toContain('Reset');
  });

  it('says only where it lands once the rail is already custom', () => {
    const said = addRecentConsequence({ curated: true, characters: [] });
    expect(said).toContain('end');
    expect(said).not.toContain('switches');
  });

  it('assumes the cautious wording while the rail is still loading', () => {
    expect(addRecentConsequence(null)).toBe(
      addRecentConsequence({ curated: false, characters: [] }),
    );
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
        { id: 'p', name: 'p', displayName: 'P', shortBio: '', profileImage: null, categories: [], clip: null },
      ],
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

const playCandidate = (id: string, displayName: string) => ({
  characterId: id,
  displayName,
  createdAt: '2026-01-01T00:00:00.000Z',
  profileImage: `/api/media/assets/${id}/file`,
});

const playRail = (curated: boolean, ids: string[]) => ({
  curated,
  characters: ids.map((id, position) => ({
    characterId: id,
    displayName: `C ${id}`,
    status: 'active',
    position,
    createdAt: '2026-01-01T00:00:00.000Z',
    profileImage: null,
  })),
});

describe('the Play with me states are never confusable', () => {
  it('names the automatic rule, and warns that editing leaves it', () => {
    const said = playWithMeModeLabel({ curated: false });
    expect(said).toContain('Automatic');
    expect(said).toContain('active character');
    expect(said).toContain('alphabetically');
    expect(said).toContain('custom list');
  });

  it('says a curated rail is the operator’s own arrangement', () => {
    expect(playWithMeModeLabel({ curated: true })).toContain('Custom list');
  });

  it('states the one-way door BEFORE the first add', () => {
    const said = addPlayWithMeConsequence({ curated: false });
    expect(said).toContain('automatic to a custom list');
    expect(said).toContain('Reset');
  });

  it('says only where it lands once the rail is already curated', () => {
    expect(addPlayWithMeConsequence({ curated: true })).toContain('end of your custom list');
  });

  it('warns before the first add even when the rail has not loaded', () => {
    expect(addPlayWithMeConsequence(null)).toContain('automatic to a custom list');
  });
});

describe('the Play with me picker', () => {
  it('marks the candidates already on the rail', () => {
    const rows = playWithMePickerRows(
      [playCandidate('a', 'Ada'), playCandidate('b', 'Bea')],
      playRail(true, ['b']),
    );
    expect(rows.map((r) => r.onRail)).toEqual([false, true]);
  });

  it('carries the face through, so the picker is not a wall of names', () => {
    const [row] = playWithMePickerRows([playCandidate('a', 'Ada')], playRail(true, []));
    expect(row!.profileImage).toBe('/api/media/assets/a/file');
  });

  it('offers everyone while the rail is still automatic', () => {
    const rows = playWithMePickerRows(
      [playCandidate('a', 'Ada'), playCandidate('b', 'Bea')],
      playRail(false, []),
    );
    expect(rows.every((r) => !r.onRail)).toBe(true);
  });

  it('re-decides from the CURRENT rail rather than remembering', () => {
    const candidates = [playCandidate('a', 'Ada')];
    expect(playWithMePickerRows(candidates, playRail(true, []))[0]!.onRail).toBe(false);
    // The same candidate list, one add later.
    expect(playWithMePickerRows(candidates, playRail(true, ['a']))[0]!.onRail).toBe(true);
  });

  it('survives a rail that has not loaded yet', () => {
    expect(playWithMePickerRows([playCandidate('a', 'Ada')], null)[0]!.onRail).toBe(false);
  });
});
