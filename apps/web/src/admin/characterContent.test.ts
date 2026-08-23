import { describe, expect, it } from 'vitest';
import {
  addKeywords,
  approveConsequence,
  assetActions,
  categoryChoices,
  characterReadiness,
  groupCharacterContent,
  isUnplaced,
  placementLabel,
  shelfSummary,
  keywordsDiffer,
  normaliseKeyword,
  removeKeyword,
  statusLabel,
} from './characterContent';
import type { CharacterContentAsset } from '../lib/api';

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

function asset(over: Partial<CharacterContentAsset> = {}): CharacterContentAsset {
  return {
    assetId: 'a1',
    characterId: 'c1',
    kind: 'generated',
    status: 'approved',
    mediaType: 'video',
    contentRating: 'sfw',
    requirementKey: null,
    isPrimary: false,
    position: null,
    previewUrl: '/admin/content/assets/a1/file',
    placement: { categories: [], heroPosition: null },
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
    ];
    const shelf = groupCharacterContent(assets);
    const seen = [...shelf.primary, ...shelf.approved, ...shelf.pending, ...shelf.rejected].map(
      (x) => x.assetId,
    );
    expect(seen.sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(new Set(seen).size).toBe(assets.length);
  });

  it('an empty shelf is empty, not undefined', () => {
    expect(groupCharacterContent([])).toEqual({
      primary: [],
      approved: [],
      pending: [],
      rejected: [],
    });
  });
});

describe('placement says whether anyone can actually see it', () => {
  it('names the Hero slot, one-based', () => {
    expect(placementLabel(asset({ placement: { categories: [], heroPosition: 0 } }))).toBe(
      'Hero #1',
    );
  });

  it('names every category with the position inside it', () => {
    const placed = asset({
      placement: {
        heroPosition: null,
        categories: [
          { id: 'c', slug: 'sexy', name: 'Sexy', position: 0 },
          { id: 'd', slug: 'new', name: 'New', position: 2 },
        ],
      },
    });
    expect(placementLabel(placed)).toBe('Sexy #1 · New #3');
  });

  it('combines Hero and category membership', () => {
    const placed = asset({
      placement: {
        heroPosition: 1,
        categories: [{ id: 'c', slug: 'sexy', name: 'Sexy', position: 0 }],
      },
    });
    expect(placementLabel(placed)).toBe('Hero #2 · Sexy #1');
  });

  it('says APPROVED BUT NOT PLACED rather than leaving it blank', () => {
    // This is the sentence the UAT was missing: approval is not publication.
    expect(placementLabel(asset())).toBe('Approved, not placed anywhere yet');
  });

  it('does not claim an unapproved item is merely unplaced', () => {
    expect(placementLabel(asset({ status: 'under_review' }))).toBe('Not placed');
  });

  it('flags approved-but-unreachable, and only that', () => {
    expect(isUnplaced(asset())).toBe(true);
    expect(isUnplaced(asset({ status: 'under_review' }))).toBe(false);
    expect(isUnplaced(asset({ kind: 'reference', isPrimary: true }))).toBe(false);
    expect(isUnplaced(asset({ placement: { categories: [], heroPosition: 0 } }))).toBe(false);
    expect(
      isUnplaced(
        asset({
          placement: {
            heroPosition: null,
            categories: [{ id: 'c', slug: 's', name: 'S', position: 0 }],
          },
        }),
      ),
    ).toBe(false);
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
      canAddToCategory: false,
      canAddToHero: false,
      inHero: false,
    });
  });

  it('stops offering the Hero to something already in it', () => {
    const actions = assetActions(asset({ placement: { categories: [], heroPosition: 0 } }));
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
      placement: {
        categories: [{ id: 'c-a', slug: 'trending', name: 'Trending', position: 0 }],
        heroPosition: null,
      },
    });
    expect(categoryChoices(already, categories).map((c) => c.id)).toEqual(['c-b']);
  });

  it('offers nothing when it is in all of them', () => {
    const all = asset({
      placement: {
        categories: [
          { id: 'c-a', slug: 'trending', name: 'Trending', position: 0 },
          { id: 'c-b', slug: 'new', name: 'New', position: 1 },
        ],
        heroPosition: null,
      },
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
