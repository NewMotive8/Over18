import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  addKeywords,
  approveConsequence,
  archiveConsequence,
  assetActions,
  lifecycleNotice,
  LIFECYCLE_ACTION_LABEL,
  needsConfirmation,
  orderedActions,
  unarchiveConsequence,
  assetDeletable,
  categoryChoices,
  characterReadiness,
  CONTENT_SECTIONS,
  deleteCharacterAsset,
  deletionConsequence,
  groupBySection,
  groupCharacterContent,
  isUndistributed,
  distributionLabel,
  liveChannels,
  dormantChannels,
  distributionBlockerLabel,
  identityLabel,
  identityLineageSummary,
  identityUsageSummary,
  sectionSummary,
  SECTION_ACCEPTS,
  SECTION_FILE_ACCEPT,
  SECTION_RATING,
  shelfSummary,
  keywordsDiffer,
  normaliseKeyword,
  removeKeyword,
  statusLabel,
} from './characterContent';
import type {
  AssetDistribution,
  CharacterContentAsset,
  IdentityLineage,
  IdentityVersionUsage,
} from '../lib/api';

/**
 * The server's distribution model for one asset (P0.5). Tests build it exactly
 * as the API reports it -- including whether each channel is LIVE -- because
 * the browser is not allowed to work that out for itself.
 */
function dist(over: Partial<AssetDistribution> = {}): AssetDistribution {
  const base: AssetDistribution = {
    blocker: null,
    liveAnywhere: false,
    placedAnywhere: false,
    posts: { released: false, releasedAt: null, live: false },
    hero: { placed: false, position: null, live: false },
    categories: [],
    discovery: [],
    ...over,
  };
  return {
    ...base,
    placedAnywhere:
      over.placedAnywhere ??
      (base.posts.released || base.hero.placed || base.categories.length > 0 || base.discovery.length > 0),
    liveAnywhere:
      over.liveAnywhere ??
      (base.posts.live ||
        base.hero.live ||
        base.categories.some((c) => c.live) ||
        base.discovery.some((d) => d.live)),
  };
}

/** A live Hero slot, the shorthand these tests use most. */
const heroAt = (position: number, live = true) => dist({ hero: { placed: true, position, live } });
const inCategories = (
  categories: Array<{ id: string; slug: string; name: string; position: number; live?: boolean; reason?: AssetDistribution['categories'][number]['reason'] }>,
) =>
  dist({
    categories: categories.map((c) => ({ ...c, live: c.live ?? true, reason: c.reason ?? null })),
  });

/**
 * The character content shelf.
 *
 * THE UAT GAP THIS CLOSES. Opening a character showed only her primary
 * references, so manually uploaded content — which can never become one —
 * appeared nowhere on her page. "What content does Maria have?" required
 * visiting Review, the Library, the merchandising screens and the Home
 * composer, and even then nothing said whether an approved clip was actually
 * reachable by anyone.
 */

/**
 * What the SERVER sends for each stored status (P0.4's contract, which the API
 * suite asserts). The fixture fills `workflow` and `actions` from it so a test
 * that only sets `status` still describes a row the server could have sent. A
 * test ABOUT actions sets `actions` itself -- the page must follow that list,
 * not these defaults.
 */
const SERVER_WORKFLOW = {
  generated: 'pending_review',
  under_review: 'pending_review',
  approved: 'approved',
  rejected: 'rejected',
  archived: 'archived',
} as const;
const SERVER_ACTIONS: Record<CharacterContentAsset['workflow'], CharacterContentAsset['actions']> = {
  pending_review: ['approve', 'reject'],
  approved: ['publish', 'archive'],
  rejected: [],
  archived: ['unarchive'],
};

function asset(over: Partial<CharacterContentAsset> = {}): CharacterContentAsset {
  const status = over.status ?? 'approved';
  const workflow = over.workflow ?? SERVER_WORKFLOW[status];
  return {
    assetId: 'a1',
    characterId: 'c1',
    kind: 'generated',
    status,
    role: 'content',
    origin: 'manual',
    workflow,
    actions: SERVER_ACTIONS[workflow],
    mediaType: 'video',
    contentRating: 'sfw',
    requirementKey: null,
    // Not released by default: approving no longer publishes, so the fixture
    // must not quietly assume it does.
    publishedAt: null,
    archivedAt: null,
    isPrimary: false,
    position: null,
    previewUrl: '/admin/content/assets/a1/file',
    distribution: dist(),
    visualIdentity: { id: 'identity-2', version: 2, status: 'active', label: null, active: true },
    createdAt: '2026-08-01T00:00:00.000Z',
    approvedAt: '2026-08-02T00:00:00.000Z',
    ...over,
  };
}

describe('the shelf splits content the way an operator reads it', () => {
  it('separates primary references from ordinary approved content', () => {
    const shelf = groupCharacterContent([
      asset({ assetId: 'p', kind: 'reference', isPrimary: true }),
      asset({ assetId: 'a' }),
    ]);
    expect(shelf.primary.map((x) => x.assetId)).toEqual(['p']);
    expect(shelf.approved.map((x) => x.assetId)).toEqual(['a']);
  });

  it('puts both pending statuses in review, never in approved', () => {
    const shelf = groupCharacterContent([
      asset({ assetId: 'u', status: 'under_review', approvedAt: null }),
      asset({ assetId: 'g', status: 'generated', approvedAt: null }),
    ]);
    expect(shelf.pending.map((x) => x.assetId)).toEqual(['u', 'g']);
    expect(shelf.approved).toEqual([]);
  });

  it('shows rejected content rather than hiding it', () => {
    // Hiding it makes an operator think the file vanished.
    const shelf = groupCharacterContent([asset({ assetId: 'r', status: 'rejected' })]);
    expect(shelf.rejected.map((x) => x.assetId)).toEqual(['r']);
  });

  it('a rejected item that was once primary is rejected, not primary', () => {
    // "Remove from primary" rejects the row, so both flags can be set at once.
    const shelf = groupCharacterContent([
      asset({ assetId: 'x', status: 'rejected', isPrimary: true, kind: 'reference' }),
    ]);
    expect(shelf.rejected.map((x) => x.assetId)).toEqual(['x']);
    expect(shelf.primary).toEqual([]);
  });

  it('every asset lands in exactly one bucket — nothing is lost or double-counted', () => {
    const assets = [
      asset({ assetId: '1', kind: 'reference', isPrimary: true }),
      asset({ assetId: '2' }),
      asset({ assetId: '3', status: 'under_review' }),
      asset({ assetId: '4', status: 'rejected' }),
      asset({ assetId: '5', status: 'generated' }),
      asset({ assetId: '6', status: 'archived' }),
    ];
    const shelf = groupCharacterContent(assets);
    const seen = [
      ...shelf.primary,
      ...shelf.approved,
      ...shelf.pending,
      ...shelf.rejected,
      ...shelf.archived,
    ].map((x) => x.assetId);
    expect(seen.sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(new Set(seen).size).toBe(assets.length);
  });

  it('an empty shelf is empty, not undefined', () => {
    expect(groupCharacterContent([])).toEqual({
      primary: [],
      approved: [],
      pending: [],
      rejected: [],
      archived: [],
    });
  });

  it('keeps ARCHIVED items in their own bucket, never among the approved (P0.4)', () => {
    const shelf = groupCharacterContent([
      asset({ assetId: 'a' }),
      asset({ assetId: 'z', status: 'archived', publishedAt: '2026-08-03T00:00:00.000Z' }),
    ]);
    expect(shelf.archived.map((x) => x.assetId)).toEqual(['z']);
    expect(shelf.approved.map((x) => x.assetId)).toEqual(['a']);
  });

  it('groups by the server workflow, so both legacy pending statuses stay one queue', () => {
    const shelf = groupCharacterContent([
      asset({ assetId: 'g', status: 'generated' }),
      asset({ assetId: 'u', status: 'under_review' }),
    ]);
    expect(shelf.pending.map((x) => x.assetId)).toEqual(['g', 'u']);
  });
});

describe('distribution says where an item actually is (P0.5)', () => {
  it('names the Hero slot, one-based', () => {
    expect(distributionLabel(asset({ distribution: heroAt(0) }))).toBe('Live: Hero #1');
  });

  it('names every category with the position inside it', () => {
    const placed = asset({
      distribution: inCategories([
        { id: 'c', slug: 'sexy', name: 'Sexy', position: 0 },
        { id: 'd', slug: 'new', name: 'New', position: 2 },
      ]),
    });
    expect(distributionLabel(placed)).toBe('Live: Sexy #1 · New #3');
  });

  it('combines Posts, Hero, categories and Discovery in one line', () => {
    const everywhere = asset({
      publishedAt: '2026-08-03T00:00:00.000Z',
      distribution: dist({
        posts: { released: true, releasedAt: '2026-08-03T00:00:00.000Z', live: true },
        hero: { placed: true, position: 1, live: true },
        categories: [{ id: 'c', slug: 'sexy', name: 'Sexy', position: 0, live: true, reason: null }],
        discovery: [{ keyword: 'beach', categories: ['Summer'], live: true }],
      }),
    });
    expect(distributionLabel(everywhere)).toBe('Live: Posts · Hero #2 · Sexy #1 · Discovery: beach');
  });

  /**
   * THE BUG THIS CLOSES. A clip released to her Posts tab used to read
   * "Approved, not placed anywhere yet", because the shelf knew only about the
   * Hero and categories. Posts is distribution, and it says so.
   */
  it('never calls a released clip unplaced', () => {
    const released = asset({
      publishedAt: '2026-08-03T00:00:00.000Z',
      distribution: dist({ posts: { released: true, releasedAt: '2026-08-03T00:00:00.000Z', live: true } }),
    });
    expect(distributionLabel(released)).toBe('Live: Posts');
    expect(isUndistributed(released)).toBe(false);
  });

  it('says APPROVED BUT NOWHERE rather than leaving it blank', () => {
    expect(distributionLabel(asset())).toBe('Approved, not distributed anywhere yet');
    expect(isUndistributed(asset())).toBe(true);
  });

  it('separates PLACED from LIVE, and gives the reason it is not live', () => {
    // Placed on Hero and in a category, but she is not published.
    const hidden = asset({
      distribution: dist({
        blocker: 'character_inactive',
        hero: { placed: true, position: 0, live: false },
        categories: [{ id: 'c', slug: 'sexy', name: 'Sexy', position: 0, live: false, reason: null }],
      }),
    });
    expect(distributionLabel(hidden)).toBe('Not live (she is not published) — kept: Home Hero · Sexy');
    expect(isUndistributed(hidden)).toBe(false);

    // Live-able asset, but the category itself is not on Home.
    const unpublishedCategory = asset({
      distribution: inCategories([
        { id: 'c', slug: 'sexy', name: 'Sexy', position: 0, live: false, reason: 'category_unpublished' },
      ]),
    });
    expect(distributionLabel(unpublishedCategory)).toBe(
      'Not live — kept: Sexy (category not on Home)',
    );
  });

  it('says why an unapproved or archived item is not distributed', () => {
    expect(distributionLabel(asset({ status: 'under_review', distribution: dist({ blocker: 'pending_review' }) }))).toBe(
      'Not distributed (waiting for review)',
    );
    expect(
      distributionLabel(
        asset({
          status: 'archived',
          distribution: dist({ blocker: 'archived', hero: { placed: true, position: 0, live: false } }),
        }),
      ),
    ).toBe('Not live (archived) — kept: Home Hero');
    expect(isUndistributed(asset({ status: 'archived', distribution: dist({ blocker: 'archived' }) }))).toBe(false);
  });

  it('reports a keyword no Discovery category queries as kept, not live', () => {
    const tagged = asset({ distribution: dist({ discovery: [{ keyword: 'internal', categories: [], live: false }] }) });
    expect(distributionLabel(tagged)).toBe(
      'Not live — kept: keyword "internal" (no Discovery category uses it)',
    );
  });

  it('exposes the channel lists the label is built from', () => {
    const mixed = dist({
      posts: { released: true, releasedAt: 'x', live: true },
      hero: { placed: true, position: 0, live: false },
      discovery: [{ keyword: 'beach', categories: ['Summer'], live: true }],
    });
    expect(liveChannels(mixed)).toEqual(['Posts', 'Discovery: beach']);
    expect(dormantChannels(mixed)).toEqual(['Home Hero']);
    expect(distributionBlockerLabel('no_media')).toBe('it has no file');
    expect(distributionBlockerLabel(null)).toBeNull();
  });

  it('never calls a primary reference undistributed -- identity is not a channel', () => {
    expect(isUndistributed(asset({ kind: 'reference', isPrimary: true }))).toBe(false);
  });
});

describe('status wording', () => {
  it('never shows an upstream term like "generated"', () => {
    expect(statusLabel(asset({ status: 'generated' }))).toBe('In review');
    expect(statusLabel(asset({ status: 'under_review' }))).toBe('In review');
  });

  it('distinguishes a primary reference from ordinary approved content', () => {
    expect(statusLabel(asset({ kind: 'reference', isPrimary: true }))).toBe('Primary reference');
    expect(statusLabel(asset())).toBe('Approved');
    expect(statusLabel(asset({ status: 'rejected' }))).toBe('Rejected');
    expect(statusLabel(asset({ status: 'archived' }))).toBe('Archived');
  });
});

describe('the one-line summary', () => {
  it('counts every bucket', () => {
    const shelf = groupCharacterContent([
      asset({ assetId: '1', kind: 'reference', isPrimary: true }),
      asset({ assetId: '2' }),
      asset({ assetId: '3', status: 'under_review' }),
      asset({ assetId: '4', status: 'rejected' }),
    ]);
    expect(shelfSummary(shelf)).toBe('4 items · 2 approved · 1 in review · 1 rejected');
  });

  it('counts archived items too', () => {
    const shelf = groupCharacterContent([asset({ assetId: '1' }), asset({ assetId: '2', status: 'archived' })]);
    expect(shelfSummary(shelf)).toBe('2 items · 1 approved · 1 archived');
  });

  it('omits empty buckets and singularises', () => {
    expect(shelfSummary(groupCharacterContent([asset()]))).toBe('1 item · 1 approved');
  });

  it('says so plainly when there is nothing', () => {
    expect(shelfSummary(groupCharacterContent([]))).toBe('No content yet');
  });
});

describe('a character that is not published says so, and why', () => {
  it('states existence, invisibility and the next step', () => {
    const r = characterReadiness({ status: 'inactive', profileComplete: false });
    expect(r.live).toBe(false);
    expect(r.headline).toContain('exists');
    expect(r.headline).toContain('not published');
    expect(r.nextStep).toContain('profile');
    expect(r.nextStep).toContain('Publish');
  });

  it('names only the remaining step once the profile is written', () => {
    const r = characterReadiness({ status: 'inactive', profileComplete: true });
    expect(r.nextStep).toBe('Press Publish to make her public.');
  });

  it('says nothing is needed once she is live', () => {
    const r = characterReadiness({ status: 'active', profileComplete: true });
    expect(r.live).toBe(true);
    expect(r.nextStep).toBeNull();
  });

  it('NEVER gates content management on publishing', () => {
    // Creating by name and uploading over the following days is the whole
    // point; an unpublished character must still accept content.
    for (const status of ['active', 'inactive']) {
      for (const profileComplete of [true, false]) {
        expect(characterReadiness({ status, profileComplete }).contentAllowed).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Acting on an item from her own page
 *
 * Every endpoint behind these controls already existed; only this page could
 * not reach them. The rule worth pinning is that the buttons offered match
 * what the server will actually accept — a button whose only outcome is an
 * error is worse than no button.
 * ------------------------------------------------------------------ */

describe('the controls an item offers', () => {
  it('offers approve and reject only while a decision is outstanding', () => {
    for (const status of ['generated', 'under_review'] as const) {
      const actions = assetActions(asset({ status }));
      expect(actions.canApprove).toBe(true);
      expect(actions.canReject).toBe(true);
      // Nothing may be placed before it is approved — the server refuses it.
      expect(actions.canAddToCategory).toBe(false);
      expect(actions.canAddToHero).toBe(false);
    }
  });

  it('offers placement only once approved', () => {
    const actions = assetActions(asset({ status: 'approved' }));
    expect(actions.canApprove).toBe(false);
    expect(actions.canReject).toBe(false);
    expect(actions.canAddToCategory).toBe(true);
    expect(actions.canAddToHero).toBe(true);
  });

  it('offers nothing on a rejected item — re-approving is a Review decision', () => {
    expect(assetActions(asset({ status: 'rejected' }))).toEqual({
      canApprove: false,
      canReject: false,
      canArchive: false,
      canUnarchive: false,
      canAddToCategory: false,
      canAddToHero: false,
      inHero: false,
      // Releasing to Posts is not on offer either: a rejected clip has not
      // passed moderation, and the server refuses to publish one.
      canPublish: false,
      canUnpublish: false,
    });
  });

  it('stops offering the Hero to something already in it', () => {
    const actions = assetActions(asset({ distribution: heroAt(0) }));
    expect(actions.inHero).toBe(true);
    expect(actions.canAddToHero).toBe(false);
    // Categories are unaffected: an item can be in the Hero AND a category.
    expect(actions.canAddToCategory).toBe(true);
  });

  it('treats a primary reference as approved content, because it is', () => {
    expect(assetActions(asset({ kind: 'reference', isPrimary: true })).canAddToCategory).toBe(true);
  });
});

describe('the category choices offered for an item', () => {
  const categories = [
    { id: 'c-a', name: 'Trending' },
    { id: 'c-b', name: 'New' },
  ];

  it('offers every category it is not already in', () => {
    expect(categoryChoices(asset(), categories).map((c) => c.id)).toEqual(['c-a', 'c-b']);
  });

  it('drops the ones it is already in, rather than offering a no-op', () => {
    const already = asset({
      distribution: inCategories([{ id: 'c-a', slug: 'trending', name: 'Trending', position: 0 }]),
    });
    expect(categoryChoices(already, categories).map((c) => c.id)).toEqual(['c-b']);
  });

  it('offers nothing when it is in all of them', () => {
    const all = asset({
      distribution: inCategories([
        { id: 'c-a', slug: 'trending', name: 'Trending', position: 0 },
        { id: 'c-b', slug: 'new', name: 'New', position: 1 },
      ]),
    });
    expect(categoryChoices(all, categories)).toEqual([]);
  });

  it('survives an empty category list', () => {
    expect(categoryChoices(asset(), [])).toEqual([]);
  });
});

describe('what approving does, said before the operator commits', () => {
  it('separates approval from visibility for a live character', () => {
    const said = approveConsequence(true);
    expect(said).toContain('clears it for use');
    expect(said).toContain('Hero or a published category');
  });

  it('names publication as the gate while she is not live', () => {
    expect(approveConsequence(false)).toContain('until she is published');
  });
});

/* ------------------------------------------------------------------ *
 * Per-clip keywords
 *
 * The endpoint REPLACES an asset's whole keyword set, so add and remove are
 * both "compute the next set correctly". Getting that arithmetic wrong is
 * silent and destructive: a botched remove sends a set missing keywords the
 * operator never touched.
 * ------------------------------------------------------------------ */

describe('normalising a typed keyword', () => {
  it('trims, collapses inner whitespace and lowercases', () => {
    expect(normaliseKeyword('  Beach   Day ')).toBe('beach day');
    expect(normaliseKeyword('BIKINI')).toBe('bikini');
  });

  it('leaves an already-clean keyword alone', () => {
    expect(normaliseKeyword('smiling')).toBe('smiling');
  });
});

describe('adding keywords to one clip', () => {
  it('appends a single keyword', () => {
    expect(addKeywords(['beach'], 'bikini')).toEqual(['beach', 'bikini']);
  });

  it('accepts a comma-separated list, because operators paste them', () => {
    expect(addKeywords([], 'beach, bikini , smiling')).toEqual(['beach', 'bikini', 'smiling']);
  });

  it('never duplicates, whatever the casing or spacing', () => {
    expect(addKeywords(['beach'], 'Beach')).toEqual(['beach']);
    expect(addKeywords(['beach'], '  beach  ')).toEqual(['beach']);
  });

  it('drops empty entries rather than storing blanks', () => {
    expect(addKeywords([], ' , , beach, ')).toEqual(['beach']);
    expect(addKeywords(['beach'], '   ')).toEqual(['beach']);
  });

  it('preserves the existing set, in order', () => {
    expect(addKeywords(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });
});

describe('removing a keyword from one clip', () => {
  it('removes exactly the one named and keeps every other', () => {
    expect(removeKeyword(['beach', 'bikini', 'smiling'], 'bikini')).toEqual(['beach', 'smiling']);
  });

  it('matches regardless of casing or padding', () => {
    expect(removeKeyword(['beach', 'bikini'], ' Bikini ')).toEqual(['beach']);
  });

  it('is a no-op for something not in the set', () => {
    expect(removeKeyword(['beach'], 'sunset')).toEqual(['beach']);
  });

  it('can empty the set — clearing all keywords is a legitimate edit', () => {
    expect(removeKeyword(['beach'], 'beach')).toEqual([]);
  });
});

describe('whether the draft needs saving', () => {
  it('sees an addition and a removal', () => {
    expect(keywordsDiffer(['a'], ['a', 'b'])).toBe(true);
    expect(keywordsDiffer(['a', 'b'], ['a'])).toBe(true);
  });

  it('sees a replacement of the same size', () => {
    expect(keywordsDiffer(['a', 'b'], ['a', 'c'])).toBe(true);
  });

  it('does NOT treat reordering as a change — a keyword set has no order', () => {
    expect(keywordsDiffer(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('treats identical sets as unchanged, including empty ones', () => {
    expect(keywordsDiffer([], [])).toBe(false);
    expect(keywordsDiffer(['a'], ['a'])).toBe(false);
  });

  it('sees clearing everything as a change', () => {
    expect(keywordsDiffer(['a'], [])).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 1 — the Regular / Explicit video shelves.
 *
 * The product question these answer is the one an operator asked: "I uploaded
 * a clip to Maria; where did it go?" Previously it went into a single mixed
 * shelf and then into a review queue. Now the shelf the operator uploaded from
 * decides its rating, and the two shelves are the whole content surface.
 *
 * The rating axis is `content_rating`, which the column has always carried —
 * no new enum, no new column, no migration.
 * ------------------------------------------------------------------ */

describe('Regular and Explicit are split by content rating', () => {
  it('puts an sfw video on Regular and an explicit video on Explicit', () => {
    const shelves = groupBySection([
      asset({ assetId: 'r', contentRating: 'sfw' }),
      asset({ assetId: 'x', contentRating: 'explicit' }),
    ]);
    expect(shelves.regular.map((a) => a.assetId)).toEqual(['r']);
    expect(shelves.explicit.map((a) => a.assetId)).toEqual(['x']);
  });

  it('never lets a Regular item appear on Explicit, or the reverse', () => {
    const shelves = groupBySection([
      asset({ assetId: 'r', contentRating: 'sfw' }),
      asset({ assetId: 'x', contentRating: 'explicit' }),
    ]);
    expect(shelves.regular.some((a) => a.contentRating === 'explicit')).toBe(false);
    expect(shelves.explicit.some((a) => a.contentRating === 'sfw')).toBe(false);
  });

  it('shows items of EVERY status on its shelf, not just approved ones', () => {
    // Uploads land approved now, but anything already in review must still be
    // visible on her page rather than only inside Review.
    const shelves = groupBySection([
      asset({ assetId: 'a', status: 'approved' }),
      asset({ assetId: 'u', status: 'under_review' }),
      asset({ assetId: 'g', status: 'generated' }),
      asset({ assetId: 'j', status: 'rejected' }),
    ]);
    expect(shelves.regular.map((a) => a.assetId)).toEqual(['a', 'u', 'g', 'j']);
  });

  it('keeps identity references OFF the shelves — they are not content', () => {
    // A reference carries the default `sfw` rating, so without this it would
    // read as a clip she had uploaded to Regular.
    const shelves = groupBySection([asset({ assetId: 'p', kind: 'reference', isPrimary: true })]);
    expect(shelves.regular).toEqual([]);
    expect(shelves.explicit).toEqual([]);
    expect(shelves.excluded.map((a) => a.assetId)).toEqual(['p']);
  });

  it('keeps images OFF the shelves — both shelves are video-only', () => {
    const shelves = groupBySection([
      asset({ assetId: 'img', mediaType: 'image' }),
      asset({ assetId: 'imgx', mediaType: 'image', contentRating: 'explicit' }),
    ]);
    expect(shelves.regular).toEqual([]);
    expect(shelves.explicit).toEqual([]);
    expect(shelves.excluded.map((a) => a.assetId)).toEqual(['img', 'imgx']);
  });

  it('accounts for EVERY asset — nothing is silently dropped', () => {
    const input = [
      asset({ assetId: '1' }),
      asset({ assetId: '2', contentRating: 'explicit' }),
      asset({ assetId: '3', mediaType: 'image' }),
      asset({ assetId: '4', kind: 'reference' }),
    ];
    const shelves = groupBySection(input);
    const seen = [...shelves.regular, ...shelves.explicit, ...shelves.excluded];
    expect(seen).toHaveLength(input.length);
    expect(new Set(seen.map((a) => a.assetId)).size).toBe(input.length);
  });

  it('maps each section to exactly one rating, in one direction', () => {
    expect(SECTION_RATING.regular).toBe('sfw');
    expect(SECTION_RATING.explicit).toBe('explicit');
  });
});

describe('the shelf count reads as videos, not items', () => {
  it('says so plainly when a shelf is empty', () => {
    expect(sectionSummary([])).toBe('No videos yet.');
  });

  it('is singular for one and plural beyond that', () => {
    expect(sectionSummary([asset()])).toBe('1 video');
    expect(sectionSummary([asset({ assetId: 'a' }), asset({ assetId: 'b' })])).toBe('2 videos');
  });
});

/* ------------------------------------------------------------------ *
 * Phase 2 — the Chat Content shelf.
 *
 * The bug this prevents is the one the architecture review was written to
 * avoid: an Admin UI that says "Chat Content" while the runtime still pulls
 * from the generic pool. The shelf an operator uploads through has to be
 * recoverable from the STORED asset, not from a label, and `kind` is where it
 * is stored.
 * ------------------------------------------------------------------ */

describe('Chat Content is its own shelf, decided by kind', () => {
  it('puts a chat VIDEO on the Chat shelf, not on Regular', () => {
    const shelves = groupBySection([asset({ assetId: 'c', kind: 'chat', mediaType: 'video' })]);
    expect(shelves.chat.map((a) => a.assetId)).toEqual(['c']);
    expect(shelves.regular).toEqual([]);
    expect(shelves.explicit).toEqual([]);
  });

  it('puts a chat IMAGE on the Chat shelf rather than hiding it', () => {
    // Regular and Explicit exclude images. Chat accepts them, so an image
    // there must be shown, not swept into `excluded`.
    const shelves = groupBySection([asset({ assetId: 'i', kind: 'chat', mediaType: 'image' })]);
    expect(shelves.chat.map((a) => a.assetId)).toEqual(['i']);
    expect(shelves.excluded).toEqual([]);
  });

  it('decides by KIND BEFORE rating — a chat asset is never Explicit content', () => {
    // The two axes are orthogonal. Were rating consulted first, a chat asset
    // carrying `explicit` would land on the Explicit shelf and read as
    // merchandisable content.
    const shelves = groupBySection([
      asset({ assetId: 'x', kind: 'chat', contentRating: 'explicit' }),
    ]);
    expect(shelves.chat.map((a) => a.assetId)).toEqual(['x']);
    expect(shelves.explicit).toEqual([]);
  });

  it('keeps the three shelves disjoint', () => {
    const shelves = groupBySection([
      asset({ assetId: 'r', kind: 'generated', contentRating: 'sfw' }),
      asset({ assetId: 'e', kind: 'generated', contentRating: 'explicit' }),
      asset({ assetId: 'cv', kind: 'chat', mediaType: 'video' }),
      asset({ assetId: 'ci', kind: 'chat', mediaType: 'image' }),
    ]);
    expect(shelves.regular.map((a) => a.assetId)).toEqual(['r']);
    expect(shelves.explicit.map((a) => a.assetId)).toEqual(['e']);
    expect(shelves.chat.map((a) => a.assetId)).toEqual(['cv', 'ci']);
    expect(shelves.excluded).toEqual([]);
  });

  it('still accounts for EVERY asset across all four lists', () => {
    const input = [
      asset({ assetId: '1' }),
      asset({ assetId: '2', contentRating: 'explicit' }),
      asset({ assetId: '3', kind: 'chat', mediaType: 'image' }),
      asset({ assetId: '4', kind: 'reference' }),
      asset({ assetId: '5', mediaType: 'image' }),
    ];
    const s = groupBySection(input);
    const seen = [...s.regular, ...s.explicit, ...s.chat, ...s.excluded];
    expect(seen).toHaveLength(input.length);
    expect(new Set(seen.map((a) => a.assetId)).size).toBe(input.length);
  });

  it('maps every section to exactly one rating and one accepted media set', () => {
    expect(SECTION_RATING.chat).toBe('sfw');
    expect(SECTION_ACCEPTS.regular).toBe('video');
    expect(SECTION_ACCEPTS.explicit).toBe('video');
    expect(SECTION_ACCEPTS.chat).toBe('both');
  });

  it("offers images in the Chat file picker and nowhere else", () => {
    expect(SECTION_FILE_ACCEPT.chat).toContain('image/');
    expect(SECTION_FILE_ACCEPT.chat).toContain('video/');
    expect(SECTION_FILE_ACCEPT.regular).not.toContain('image/');
    expect(SECTION_FILE_ACCEPT.explicit).not.toContain('image/');
  });

  it('renders exactly three shelves, in order', () => {
    expect(CONTENT_SECTIONS).toEqual(['regular', 'explicit', 'chat']);
  });
});

describe('the shelf count says what the shelf actually holds', () => {
  it('counts videos on the video shelves', () => {
    expect(sectionSummary([], 'regular')).toBe('No videos yet.');
    expect(sectionSummary([asset()], 'explicit')).toBe('1 video');
  });

  it('counts ITEMS on Chat, which holds a mix', () => {
    expect(sectionSummary([], 'chat')).toBe('No items yet.');
    expect(sectionSummary([asset({ assetId: 'a' }), asset({ assetId: 'b' })], 'chat')).toBe(
      '2 items',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Deleting a content item from the Character page
 *
 * The rule this suite exists to hold: the Character page must not GROW a
 * deletion of its own. It offers the Content Library's delete in a second
 * place. So most of what follows is about which call is made, when it is
 * made, and what is claimed afterwards — not about what deletion means.
 * ------------------------------------------------------------------ */

/** Records what the page asked the outside world to do, in order. */
function recorder(behaviour: { remove?: () => Promise<unknown>; reload?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  return {
    calls,
    removed: [] as string[],
    deps: {
      remove: async function (this: void, assetId: string) {
        calls.push(`remove:${assetId}`);
        return behaviour.remove ? behaviour.remove() : undefined;
      },
      reload: async function (this: void) {
        calls.push('reload');
        if (behaviour.reload) await behaviour.reload();
      },
    },
  };
}

describe('the Character page uses the canonical Content Library delete', () => {
  it('calls the injected remove exactly once, with this asset id, then re-reads', async () => {
    // `remove` IS contentLibraryApi.remove at the call site — the same client
    // method the Content Library screen uses, hitting the same route.
    const r = recorder();
    const outcome = await deleteCharacterAsset(asset({ assetId: 'chat-7' }), r.deps);

    expect(outcome).toEqual({ ok: true });
    expect(r.calls).toEqual(['remove:chat-7', 'reload']);
  });

  it('re-reads rather than splicing the item out locally', async () => {
    // Position matters: the reload happens AFTER the delete resolves, so the
    // shelf can only lose the item because the server stopped returning it.
    const r = recorder();
    await deleteCharacterAsset(asset({ assetId: 'x' }), r.deps);
    expect(r.calls.indexOf('reload')).toBeGreaterThan(r.calls.indexOf('remove:x'));
  });

  it('deletes chat, regular and explicit items through the one path', async () => {
    for (const item of [
      asset({ assetId: 'c', kind: 'chat', mediaType: 'image' }),
      asset({ assetId: 'r', kind: 'generated', contentRating: 'sfw' }),
      asset({ assetId: 'e', kind: 'generated', contentRating: 'explicit' }),
    ]) {
      const r = recorder();
      expect(await deleteCharacterAsset(item, r.deps)).toEqual({ ok: true });
      expect(r.calls).toEqual([`remove:${item.assetId}`, 'reload']);
    }
  });
});

describe('a failed delete leaves the item alone and says so', () => {
  it('reports the server message and does NOT refresh the shelf', async () => {
    // Not refreshing is the point: the tile stays visible because the item is
    // still there. A refresh here would redraw the same tile and read as a
    // flicker rather than a failure.
    const r = recorder({
      remove: () => Promise.reject(new Error('Media storage is not configured.')),
    });
    const outcome = await deleteCharacterAsset(asset({ assetId: 'x' }), r.deps);

    expect(outcome).toEqual({
      ok: false,
      deleted: false,
      message: 'Media storage is not configured.',
    });
    expect(r.calls).toEqual(['remove:x']);
    expect(r.calls).not.toContain('reload');
  });

  it('never reports success when the delete threw', async () => {
    const r = recorder({ remove: () => Promise.reject(new Error('boom')) });
    const outcome = await deleteCharacterAsset(asset(), r.deps);
    expect(outcome.ok).toBe(false);
  });

  it('survives a non-Error rejection with a usable message', async () => {
    const r = recorder({ remove: () => Promise.reject('nope') });
    const outcome = await deleteCharacterAsset(asset(), r.deps);
    expect(outcome).toEqual({
      ok: false,
      deleted: false,
      message: 'Could not delete this item.',
    });
  });

  it('distinguishes "did not delete" from "deleted but could not refresh"', async () => {
    // These must not share a message. Telling an operator to retry something
    // that already happened is how an asset gets deleted twice and the second
    // attempt reports a confusing 404.
    const r = recorder({ reload: () => Promise.reject(new Error('network')) });
    const outcome = await deleteCharacterAsset(asset(), r.deps);

    expect(outcome).toMatchObject({ ok: false, deleted: true });
    expect((outcome as { message: string }).message).toContain('Reload');
  });
});

describe('protected assets keep their existing protection', () => {
  it('offers no Delete for a Primary (canonical) reference', () => {
    const primary = assetDeletable(asset({ isPrimary: true }));
    expect(primary.deletable).toBe(false);
    expect((primary as { reason: string }).reason).toContain('Primary');
  });

  it('refuses BEFORE sending a request the server would answer 409 to', async () => {
    const r = recorder();
    const outcome = await deleteCharacterAsset(asset({ isPrimary: true }), r.deps);

    expect(outcome).toMatchObject({ ok: false, deleted: false });
    expect(r.calls).toEqual([]); // nothing was sent, nothing was re-read
  });

  it('does not invent any OTHER refusal', () => {
    // Placement, approval state and media type are the server's business and
    // none of them blocks a delete. A "cannot delete a published clip" rule
    // here would be a new safety semantic nobody asked for.
    expect(assetDeletable(asset({ status: 'under_review' })).deletable).toBe(true);
    expect(assetDeletable(asset({ status: 'rejected' })).deletable).toBe(true);
    expect(assetDeletable(asset({ mediaType: 'image' })).deletable).toBe(true);
    expect(assetDeletable(asset({ kind: 'chat' })).deletable).toBe(true);
    expect(
      assetDeletable(asset({ distribution: heroAt(0) })).deletable,
    ).toBe(true);
    expect(
      assetDeletable(
        asset({ distribution: inCategories([{ id: 'k1', slug: 'sexy', name: 'Sexy', position: 2 }]) }),
      ).deletable,
    ).toBe(true);
  });
});

describe('the confirmation names what the tile cannot show', () => {
  it('always says the file goes and that it cannot be undone', () => {
    const message = deletionConsequence(asset());
    expect(message).toContain('stored file');
    expect(message).toContain('cannot be undone');
  });

  it('names each place the item is published, rather than counting them', () => {
    const message = deletionConsequence(
      asset({
        distribution: dist({
          posts: { released: true, releasedAt: 'x', live: true },
          hero: { placed: true, position: 0, live: true },
          categories: [
            { id: 'k1', slug: 'sexy', name: 'Sexy', position: 0, live: true, reason: null },
            { id: 'k2', slug: 'new', name: 'New', position: 1, live: true, reason: null },
          ],
          discovery: [{ keyword: 'beach', categories: ['Summer'], live: true }],
        }),
      }),
    );
    // Every channel it is in, named -- Posts and Discovery included, which the
    // old placement-only message never mentioned.
    expect(message).toContain('her Posts tab');
    expect(message).toContain('Home Hero');
    expect(message).toContain('Sexy');
    expect(message).toContain('New');
    expect(message).toContain('Discovery ("beach")');
    expect(message).toContain('will be removed from there');
  });

  it('says nothing about placement when there is none', () => {
    expect(deletionConsequence(asset())).not.toContain('currently in');
  });

  it('warns that an already-sent chat message keeps its text and loses the media', () => {
    // messages.media_asset_id is ON DELETE SET NULL. Nothing on the tile shows
    // this, and no operator would guess it.
    const message = deletionConsequence(asset({ kind: 'chat' }));
    expect(message).toContain('no longer be able to send it');
    expect(message).toContain('loses the attachment');
  });

  it('does not give the chat warning to a Regular or Explicit clip', () => {
    expect(deletionConsequence(asset({ kind: 'generated' }))).not.toContain('attachment');
  });
});

/* ------------------------------------------------------------------ *
 * P0.4 -- lifecycle actions come from the server, and are said plainly
 * ------------------------------------------------------------------ */

describe('lifecycle controls follow the server, never a status name', () => {
  it('Pending review -> Approve / Reject', () => {
    const actions = assetActions(asset({ status: 'under_review' }));
    expect([actions.canApprove, actions.canReject]).toEqual([true, true]);
    expect([actions.canPublish, actions.canArchive, actions.canUnarchive]).toEqual([false, false, false]);
  });

  it('Approved -> Release / Archive', () => {
    const actions = assetActions(asset());
    expect([actions.canPublish, actions.canArchive]).toEqual([true, true]);
    expect([actions.canApprove, actions.canReject, actions.canUnarchive]).toEqual([false, false, false]);
  });

  it('Released -> Archive (and the existing Take off Posts)', () => {
    const actions = assetActions(
      asset({ publishedAt: '2026-08-03T00:00:00.000Z', actions: ['unpublish', 'archive'] }),
    );
    expect([actions.canArchive, actions.canUnpublish, actions.canPublish]).toEqual([true, true, false]);
  });

  it('Archived -> Unarchive only', () => {
    expect(assetActions(asset({ status: 'archived' }))).toMatchObject({
      canUnarchive: true,
      canApprove: false,
      canReject: false,
      canPublish: false,
      canUnpublish: false,
      canArchive: false,
      canAddToCategory: false,
      canAddToHero: false,
    });
  });

  it('infers NOTHING from status: an empty server list offers nothing, whatever the status', () => {
    for (const status of ['generated', 'under_review', 'approved', 'archived'] as const) {
      const actions = assetActions(asset({ status, actions: [] }));
      expect({
        status,
        offered: [
          actions.canApprove,
          actions.canReject,
          actions.canPublish,
          actions.canUnpublish,
          actions.canArchive,
          actions.canUnarchive,
        ],
      }).toEqual({ status, offered: [false, false, false, false, false, false] });
    }
  });

  it('draws buttons in a fixed order whatever order the server listed them', () => {
    expect(orderedActions(['unarchive', 'archive', 'publish', 'reject', 'approve'])).toEqual([
      'approve',
      'reject',
      'publish',
      'archive',
      'unarchive',
    ]);
    expect(LIFECYCLE_ACTION_LABEL.publish).toBe('Release to Posts');
  });

  it('asks before reject, archive and unarchive -- and only those', () => {
    expect(orderedActions(['approve', 'reject', 'publish', 'unpublish', 'archive', 'unarchive']).filter(needsConfirmation)).toEqual([
      'reject',
      'archive',
      'unarchive',
    ]);
  });
});

describe('lifecycle wording', () => {
  it('says archiving deletes nothing, and that chat keeps already-sent messages', () => {
    expect(archiveConsequence({ role: 'content' })).toContain('Nothing is deleted');
    expect(archiveConsequence({ role: 'content' })).toContain('Posts tab');
    expect(archiveConsequence({ role: 'chat' })).toContain('messages that already carried it keep it');
    expect(archiveConsequence({ role: 'chat' })).not.toContain('Posts tab');
  });

  it('says unarchiving does NOT put it back in front of customers, and names what it clears', () => {
    const wasLive = unarchiveConsequence(
      asset({
        status: 'archived',
        publishedAt: '2026-08-03T00:00:00.000Z',
        distribution: dist({
          hero: { placed: true, position: 0, live: true },
          categories: [{ id: 'c', slug: 's', name: 'Sexy', position: 0, live: true, reason: null }],
        }),
      }),
    );
    expect(wasLive).toContain('returns to Approved');
    expect(wasLive).toContain('stays hidden from customers');
    expect(wasLive).toContain('will NOT go back on her Posts tab, the Home Hero, Sexy');
    expect(wasLive).toContain('Discovery keywords');

    // Nothing to lose: it still says releasing is a separate decision.
    expect(unarchiveConsequence(asset({ status: 'archived' }))).toContain('separate decisions afterwards');
    expect(unarchiveConsequence({ role: 'chat', publishedAt: null })).toContain('never appears anywhere public');
  });

  it('the unarchive notice never claims it went live again', () => {
    expect(lifecycleNotice('unarchive', { role: 'content' })).toBe(
      'Unarchived. It is approved again, and not released or placed — release it when you want it live.',
    );
    expect(lifecycleNotice('unarchive', { role: 'chat' })).toBe('Unarchived. She can send it in chats again.');
  });

  it('never tells an operator that approving released anything', () => {
    expect(lifecycleNotice('approve', { role: 'content' })).toBe(
      'Approved. It is not on her Posts tab until you release it.',
    );
    expect(lifecycleNotice('reject', { role: 'content' })).toContain('delete it separately');
  });
});

/**
 * NO LIFECYCLE RULES IN THE BROWSER. The screens that show asset actions may
 * render `asset.actions`, but may not decide an action from a status name. Only
 * asset status comparisons are forbidden -- a character's or an identity's own
 * status is a different thing. Comments are stripped first.
 */
describe('the admin screens hold no transition logic', () => {
  const source = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const ASSET_STATUS_TEST =
    /\.status\s*[!=]==?\s*'(generated|under_review|approved|rejected|archived)'/;

  for (const file of [
    './characterContent.ts',
    '../pages/admin/AdminCharacterDetailPage.tsx',
    '../pages/admin/ContentReviewPage.tsx',
  ]) {
    it(`${file} decides nothing from an asset status`, () => {
      const code = source(file);
      expect({ file, match: code.match(ASSET_STATUS_TEST)?.[0] ?? null }).toEqual({ file, match: null });
      expect({ file, pendingSet: code.includes('PENDING_STATUSES') }).toEqual({ file, pendingSet: false });
    });
  }

  it('the guard itself catches a planted rule', () => {
    expect(ASSET_STATUS_TEST.test("if (asset.status === 'approved') offer();")).toBe(true);
    expect(ASSET_STATUS_TEST.test("character.status === 'active'")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * P0.6 -- identity lineage, reported and never acted upon
 * ------------------------------------------------------------------ */

const usage = (over: Partial<IdentityVersionUsage> = {}): IdentityVersionUsage => ({
  id: 'v2',
  version: 2,
  status: 'active',
  label: null,
  active: true,
  counts: { total: 0, pendingReview: 0, approved: 0, rejected: 0, archived: 0, live: 0, references: 0 },
  ...over,
});

describe('which identity version an asset was made against', () => {
  it('names the version, and says when it is no longer the active one', () => {
    expect(identityLabel(asset())).toBe('Identity v2');
    expect(
      identityLabel(
        asset({ visualIdentity: { id: 'v1', version: 1, status: 'retired', label: null, active: false } }),
      ),
    ).toBe('Identity v1 · retired');
    expect(
      identityLabel(
        asset({ visualIdentity: { id: 'v3', version: 3, status: 'draft', label: 'Next', active: false } }),
      ),
    ).toBe('Identity v3 · draft');
  });

  it('summarises what one version carries, by workflow', () => {
    expect(identityUsageSummary(usage())).toBe('No content on this version');
    expect(
      identityUsageSummary(
        usage({
          counts: { total: 7, pendingReview: 1, approved: 4, rejected: 1, archived: 1, live: 2, references: 1 },
        }),
      ),
    ).toBe('7 items · 1 reference · 4 approved (2 live) · 1 in review · 1 archived · 1 rejected');
    expect(
      identityUsageSummary(
        usage({ counts: { total: 2, pendingReview: 0, approved: 2, rejected: 0, archived: 0, live: 0, references: 0 } }),
      ),
    ).toBe('2 items · 2 approved');
  });
});

describe('how much content is still on an older identity version', () => {
  const lineage = (over: Partial<IdentityLineage> = {}): IdentityLineage => ({
    activeVersion: 2,
    versions: [usage(), usage({ id: 'v1', version: 1, status: 'retired', active: false })],
    staleApproved: 0,
    staleLive: 0,
    staleVersions: [],
    ...over,
  });

  it('says plainly when everything is on the active version', () => {
    expect(identityLineageSummary(lineage())).toBe(
      'All approved content was made against the active identity (v2).',
    );
  });

  it('names how much, which versions, and how much of it customers can see', () => {
    expect(
      identityLineageSummary(lineage({ staleApproved: 3, staleLive: 1, staleVersions: [1] })),
    ).toBe(
      '3 approved items still use v1, not the active v2, 1 of them live. Nothing was changed by activating it — this is for your judgement.',
    );
    expect(
      identityLineageSummary(lineage({ staleApproved: 1, staleLive: 0, staleVersions: [1] })),
    ).toContain('1 approved item still use');
    expect(
      identityLineageSummary(lineage({ staleApproved: 2, staleLive: 0, staleVersions: [1] })),
    ).toContain('none of them live');
  });

  it('never suggests the content is wrong -- only that it predates the active version', () => {
    const message = identityLineageSummary(lineage({ staleApproved: 3, staleLive: 1, staleVersions: [1] }));
    for (const word of ['regenerate', 'invalid', 'stale', 'outdated', 'must']) {
      expect({ word, present: message.toLowerCase().includes(word) }).toEqual({ word, present: false });
    }
  });

  it('handles a character with no active version, and one with none at all', () => {
    expect(identityLineageSummary(lineage({ activeVersion: null }))).toContain('No version is active');
    expect(identityLineageSummary(lineage({ activeVersion: null, versions: [] }))).toBe(
      'No identity version yet.',
    );
  });
});
