import { describe, expect, it } from 'vitest';
import type { AddOutcome, CandidateAssetView, CategoryAssetView } from '../lib/api';
import {
  blockedItems,
  blockedReason,
  candidateWarning,
  membershipLabel,
  publishableOnly,
  pruneSelection,
  removalMessage,
  selectAll,
  selectRange,
  summarise,
  summariseAdd,
  toggleSelected,
  withIds,
} from './merchandising';
import { moveBy, moveItem, orderOf } from './categoryBoard';

/**
 * Merchandising workspace logic (US-102.2).
 *
 * Two things are covered here that a static render cannot reach: the selection
 * maths behind a multi-select thumbnail grid, and the copy that has to tell the
 * operator the truth about what removing an item does.
 *
 * The drag GESTURE is not covered — node, no DOM, no pointer events — but the
 * ordering primitives every drop resolves to are shared with the categories
 * workspace and exercised through `withIds` below, so a divergence between the
 * two screens fails a test.
 */

function asset(overrides: Partial<CategoryAssetView> & { assetId: string }): CategoryAssetView {
  return {
    characterId: 'char-1',
    characterName: 'luna',
    mediaType: 'image',
    contentRating: 'sfw',
    isPrimary: false,
    status: 'approved',
    position: 0,
    featured: false,
    publishable: true,
    ineligibleReason: null,
    previewUrl: `/admin/content/assets/${overrides.assetId}/file`,
    addedAt: 'x',
    ...overrides,
  };
}

function candidate(
  overrides: Partial<CandidateAssetView> & { assetId: string },
): CandidateAssetView {
  return {
    characterId: 'char-1',
    characterName: 'luna',
    mediaType: 'image',
    contentRating: 'sfw',
    isPrimary: false,
    previewUrl: null,
    approvedAt: null,
    categoryCount: 0,
    inThisCategory: false,
    ineligibleReason: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

describe('toggleSelected', () => {
  it('adds and removes without mutating the original', () => {
    const start = new Set(['a']);
    const added = toggleSelected(start, 'b');
    expect([...added].sort()).toEqual(['a', 'b']);
    expect([...start]).toEqual(['a']);
    expect([...toggleSelected(added, 'a')]).toEqual(['b']);
  });
});

describe('selectRange (shift-click)', () => {
  const visible = ['a', 'b', 'c', 'd', 'e'];

  it('selects everything between the anchor and the target', () => {
    expect([...selectRange(new Set(), visible, 'b', 'd')].sort()).toEqual(['b', 'c', 'd']);
  });

  it('works in either direction', () => {
    expect([...selectRange(new Set(), visible, 'd', 'b')].sort()).toEqual(['b', 'c', 'd']);
  });

  it('keeps what was already selected', () => {
    expect([...selectRange(new Set(['z']), visible, 'a', 'b')].sort()).toEqual(['a', 'b', 'z']);
  });

  it('falls back to a single selection with no anchor', () => {
    expect([...selectRange(new Set(), visible, null, 'c')]).toEqual(['c']);
  });

  it('never reaches across items the filter has hidden', () => {
    // `visible` is the filtered list, so a range can only span what is shown.
    const filtered = ['a', 'e'];
    expect([...selectRange(new Set(), filtered, 'a', 'e')].sort()).toEqual(['a', 'e']);
  });

  it('falls back to a single selection when the anchor is gone', () => {
    expect([...selectRange(new Set(), visible, 'gone', 'c')]).toEqual(['c']);
  });
});

describe('pruneSelection', () => {
  it('drops anything no longer visible', () => {
    // Otherwise "Add 12 items" could include assets the operator filtered away.
    expect([...pruneSelection(new Set(['a', 'b', 'c']), ['a', 'c'])].sort()).toEqual(['a', 'c']);
  });

  it('empties the selection when nothing is visible', () => {
    expect([...pruneSelection(new Set(['a']), [])]).toEqual([]);
  });
});

describe('selectAll', () => {
  it('selects exactly what is on screen', () => {
    expect([...selectAll(['a', 'b'])].sort()).toEqual(['a', 'b']);
  });
});

/* ------------------------------------------------------------------ *
 * Bulk outcomes
 * ------------------------------------------------------------------ */

describe('summariseAdd', () => {
  const out = (o: Partial<AddOutcome> & { assetId: string }): AddOutcome => ({
    added: false,
    ...o,
  });

  it('reports a clean success', () => {
    const summary = summariseAdd([out({ assetId: 'a', added: true }), out({ assetId: 'b', added: true })]);
    expect(summary.added).toBe(2);
    expect(summary.message).toBe('Added 2 items.');
  });

  it('NEVER rounds a partial success up', () => {
    const summary = summariseAdd([
      out({ assetId: 'a', added: true }),
      out({ assetId: 'b', reason: 'not_approved', status: 'under_review' }),
    ]);
    expect(summary).toMatchObject({ added: 1, notApproved: 1 });
    expect(summary.message).toContain('Added 1 item');
    expect(summary.message).toContain('not approved');
  });

  it('names each cause separately', () => {
    const summary = summariseAdd([
      out({ assetId: 'a', added: true }),
      out({ assetId: 'b', reason: 'already_present' }),
      out({ assetId: 'c', reason: 'not_approved' }),
      out({ assetId: 'd', reason: 'not_found' }),
    ]);
    expect(summary).toMatchObject({ added: 1, alreadyPresent: 1, notApproved: 1, missing: 1 });
    expect(summary.message).toContain('already here');
    expect(summary.message).toContain('no longer exists');
  });

  it('says so plainly when nothing was added', () => {
    const summary = summariseAdd([out({ assetId: 'a', reason: 'already_present' })]);
    expect(summary.message).toMatch(/^Nothing added/);
  });

  it('is singular for one item', () => {
    expect(summariseAdd([out({ assetId: 'a', added: true })]).message).toBe('Added 1 item.');
  });

  it('counts the refusals that are not about approval, without blaming Review', () => {
    const summary = summariseAdd([
      out({ assetId: 'a', added: true }),
      out({ assetId: 'b', reason: 'no_media' }),
      out({ assetId: 'c', reason: 'not_content' }),
    ]);
    expect(summary).toMatchObject({ added: 1, notRenderable: 2, notApproved: 0 });
    expect(summary.message).toMatch(/the app cannot show/i);
    expect(summary.message).not.toMatch(/not approved/i);
  });
});

/* ------------------------------------------------------------------ *
 * Publishability in the UI
 * ------------------------------------------------------------------ */

describe('publishability', () => {
  const list = [
    asset({ assetId: 'a' }),
    asset({ assetId: 'b', publishable: false, status: 'rejected' }),
    asset({ assetId: 'c', publishable: false, status: 'under_review' }),
  ];

  it('the preview shows only what the app would show', () => {
    expect(publishableOnly(list).map((a) => a.assetId)).toEqual(['a']);
  });

  it('the workspace can still surface what is blocked', () => {
    expect(blockedItems(list).map((a) => a.assetId)).toEqual(['b', 'c']);
  });

  it('explains a rejection without implying the assignment is gone', () => {
    const message = blockedReason(list[1]!);
    expect(message).toContain('Rejected in Review');
    expect(message).toContain('Still assigned');
    expect(message).toMatch(/brings it back/i);
  });

  it('explains a pending review the same way', () => {
    expect(blockedReason(list[2]!)).toContain('Waiting on Review');
    expect(blockedReason(list[2]!)).toContain('Still assigned');
  });

  it('handles an unexpected status without inventing a story', () => {
    expect(blockedReason(asset({ assetId: 'x', status: 'archived', publishable: false }))).toContain(
      'archived',
    );
  });

  /* ---------------- blocked for reasons that are NOT approval ---------------- */

  /**
   * The reported bug's UI half. An approved clip belonging to an unpublished
   * character arrives here as publishable:false with status 'approved', and the
   * old copy — which switched on status alone — answered "Not approved
   * (approved)". Wrong, and impossible to act on.
   */
  it('names the character when she is the reason, not the approval state', () => {
    const message = blockedReason(
      asset({
        assetId: 'y',
        status: 'approved',
        publishable: false,
        ineligibleReason: 'character_inactive',
      }),
    );
    expect(message).toMatch(/character is not published/i);
    expect(message).toContain('Still assigned');
    expect(message).not.toMatch(/not approved/i);
  });

  it('names a missing file, and does not blame Review for it', () => {
    const message = blockedReason(
      asset({ assetId: 'z', status: 'approved', publishable: false, ineligibleReason: 'no_media' }),
    );
    expect(message).toMatch(/no media file/i);
    expect(message).not.toMatch(/Review/i);
  });

  it('still falls back to the status when approval IS the reason', () => {
    // The server's reason is coarse — `not_approved` covers rejected and
    // pending alike — so which state it is still comes from `status`.
    expect(
      blockedReason(
        asset({
          assetId: 'w',
          status: 'rejected',
          publishable: false,
          ineligibleReason: 'not_approved',
        }),
      ),
    ).toContain('Rejected in Review');
  });
});

/* ------------------------------------------------------------------ *
 * The picker warns before the add, not after
 * ------------------------------------------------------------------ */

describe('candidateWarning', () => {
  it('warns that an unpublished character will not appear yet', () => {
    const warning = candidateWarning(
      candidate({ assetId: 'a', ineligibleReason: 'character_inactive' }),
    );
    expect(warning).toMatch(/not published/i);
    expect(warning).toMatch(/will not appear on Home/i);
  });

  it('says nothing about a candidate that will render', () => {
    expect(candidateWarning(candidate({ assetId: 'b' }))).toBeNull();
  });
});

describe('summarise', () => {
  it('separates assigned from what is actually live', () => {
    expect(
      summarise([
        asset({ assetId: 'a', featured: true }),
        asset({ assetId: 'b', mediaType: 'video' }),
        asset({ assetId: 'c', publishable: false, status: 'rejected' }),
      ]),
    ).toEqual({ assigned: 3, publishable: 2, blocked: 1, featured: 1, images: 1, videos: 1 });
  });

  it('handles an empty category', () => {
    expect(summarise([])).toEqual({
      assigned: 0,
      publishable: 0,
      blocked: 0,
      featured: 0,
      images: 0,
      videos: 0,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

describe('membershipLabel', () => {
  it('says where else an asset is used, so adding never looks like moving', () => {
    expect(membershipLabel(candidate({ assetId: 'a' }))).toBe('Not in any category yet');
    expect(membershipLabel(candidate({ assetId: 'a', categoryCount: 1 }))).toBe(
      'In 1 other category',
    );
    expect(membershipLabel(candidate({ assetId: 'a', categoryCount: 4 }))).toBe(
      'In 4 other categories',
    );
    expect(membershipLabel(candidate({ assetId: 'a', inThisCategory: true }))).toBe(
      'Already in this category',
    );
  });
});

describe('removalMessage', () => {
  it('states that the Library asset is untouched', () => {
    const message = removalMessage(3);
    expect(message).toContain('3 items');
    expect(message).toMatch(/Nothing is deleted, rejected or changed in the Library/i);
    expect(message).toContain('every other category');
  });

  it('reads correctly for a single item', () => {
    const message = removalMessage(1);
    expect(message).toContain('1 item ');
    expect(message).toContain('it stays');
  });
});

/* ------------------------------------------------------------------ *
 * Ordering reuses the categories workspace primitives
 * ------------------------------------------------------------------ */

describe('ordering assets reuses the shared primitives', () => {
  const list = withIds([asset({ assetId: 'a' }), asset({ assetId: 'b' }), asset({ assetId: 'c' })]);

  it('moves an asset by drag index', () => {
    expect(orderOf(moveItem(list, 0, 2))).toEqual(['b', 'c', 'a']);
  });

  it('moves an asset by keyboard, clamped at the ends', () => {
    expect(orderOf(moveBy(list, 'a', -1))).toEqual(['a', 'b', 'c']);
    expect(orderOf(moveBy(list, 'a', 1))).toEqual(['b', 'a', 'c']);
    expect(orderOf(moveBy(list, 'c', 1))).toEqual(['a', 'b', 'c']);
  });

  it('withIds keeps the asset payload intact', () => {
    const [first] = withIds([asset({ assetId: 'a', characterName: 'nova' })]);
    expect(first).toMatchObject({ id: 'a', assetId: 'a', characterName: 'nova' });
  });
});
