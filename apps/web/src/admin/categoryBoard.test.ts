import { describe, expect, it } from 'vitest';
import type { AppCategoryView } from '../lib/api';
import {
  assignedLabel,
  canMove,
  deletionMessage,
  interceptedPath,
  moveBy,
  moveItem,
  orderOf,
  previewCategories,
  reconcileOrder,
  sameOrder,
  slugPreview,
  summarise,
} from './categoryBoard';

/**
 * App Categories workspace logic (US-102.1).
 *
 * These cover the arithmetic behind every reorder — the part that silently
 * corrupts an arrangement when it is wrong — plus the copy that has to tell an
 * operator the truth about what deleting a category does.
 *
 * NOT covered here, and deliberately stated rather than implied: the drag
 * GESTURE. This suite runs in node with no DOM and no pointer events, so what
 * is verified is the index maths every drop resolves to, and the keyboard path
 * that reaches the same functions.
 */

function category(overrides: Partial<AppCategoryView> & { id: string }): AppCategoryView {
  return {
    slug: overrides.id,
    name: overrides.id,
    tagline: null,
    enabled: true,
    position: 0,
    assignedAssetCount: 0,
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  };
}

const A = category({ id: 'a' });
const B = category({ id: 'b' });
const C = category({ id: 'c' });
const LIST = [A, B, C];

/* ------------------------------------------------------------------ *
 * Slug derivation — must agree with the server
 * ------------------------------------------------------------------ */

describe('slugPreview', () => {
  it('lowercases and hyphenates', () => {
    expect(slugPreview('Girlfriend Experience')).toBe('girlfriend-experience');
  });

  it('strips accents, punctuation and outer separators', () => {
    // Same cases the API test asserts against slugFromName. If either
    // implementation drifts, one of the two suites fails.
    expect(slugPreview('  Café  Noir!! ')).toBe('cafe-noir');
    expect(slugPreview('Милые')).toBe('');
  });

  it('collapses runs of separators rather than emitting empties', () => {
    expect(slugPreview('New   ---   Arrivals')).toBe('new-arrivals');
  });

  it('caps length', () => {
    expect(slugPreview('x'.repeat(200))).toHaveLength(60);
  });
});

/* ------------------------------------------------------------------ *
 * Reordering
 * ------------------------------------------------------------------ */

describe('moveItem', () => {
  it('moves an item down to the given index', () => {
    expect(orderOf(moveItem(LIST, 0, 2))).toEqual(['b', 'c', 'a']);
  });

  it('moves an item up to the given index', () => {
    expect(orderOf(moveItem(LIST, 2, 0))).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when the item does not move', () => {
    expect(orderOf(moveItem(LIST, 1, 1))).toEqual(['a', 'b', 'c']);
  });

  it('never mutates the input', () => {
    const input = [...LIST];
    moveItem(input, 0, 2);
    expect(orderOf(input)).toEqual(['a', 'b', 'c']);
  });

  it('ignores an out-of-range drop instead of throwing', () => {
    // Dropping outside the list is something a person does, not an error.
    expect(orderOf(moveItem(LIST, 0, 9))).toEqual(['a', 'b', 'c']);
    expect(orderOf(moveItem(LIST, -1, 1))).toEqual(['a', 'b', 'c']);
    expect(orderOf(moveItem(LIST, 0, -1))).toEqual(['a', 'b', 'c']);
  });

  it('keeps every item — a reorder can never lose one', () => {
    const moved = moveItem(LIST, 2, 0);
    expect(new Set(orderOf(moved))).toEqual(new Set(['a', 'b', 'c']));
    expect(moved).toHaveLength(3);
  });
});

describe('moveBy (the keyboard path)', () => {
  it('moves one place at a time', () => {
    expect(orderOf(moveBy(LIST, 'c', -1))).toEqual(['a', 'c', 'b']);
    expect(orderOf(moveBy(LIST, 'a', 1))).toEqual(['b', 'a', 'c']);
  });

  it('CLAMPS at the ends rather than wrapping around', () => {
    // Pressing "up" on the first row must do nothing — not teleport it.
    expect(orderOf(moveBy(LIST, 'a', -1))).toEqual(['a', 'b', 'c']);
    expect(orderOf(moveBy(LIST, 'c', 1))).toEqual(['a', 'b', 'c']);
  });

  it('clamps a large jump to the end of the list', () => {
    expect(orderOf(moveBy(LIST, 'a', 99))).toEqual(['b', 'c', 'a']);
  });

  it('ignores an unknown id', () => {
    expect(orderOf(moveBy(LIST, 'nope', 1))).toEqual(['a', 'b', 'c']);
  });
});

describe('canMove', () => {
  it('is false at the boundaries and true in between', () => {
    expect(canMove(LIST, 'a', -1)).toBe(false);
    expect(canMove(LIST, 'a', 1)).toBe(true);
    expect(canMove(LIST, 'c', 1)).toBe(false);
    expect(canMove(LIST, 'b', -1)).toBe(true);
  });

  it('is false for an unknown id and for a single-item list', () => {
    expect(canMove(LIST, 'nope', 1)).toBe(false);
    expect(canMove([A], 'a', 1)).toBe(false);
    expect(canMove([A], 'a', -1)).toBe(false);
  });
});

describe('sameOrder', () => {
  it('detects an unchanged order', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('detects a changed order, and a changed length', () => {
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Keeping a local arrangement across a refresh
 * ------------------------------------------------------------------ */

describe('reconcileOrder', () => {
  it('keeps the local arrangement while taking server content', () => {
    const local = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    const server = [A, B, { ...C, name: 'Renamed' }];
    const merged = reconcileOrder(local, server);

    expect(orderOf(merged)).toEqual(['c', 'a', 'b']);
    expect(merged[0]!.name).toBe('Renamed'); // content from the server
  });

  it('appends categories the local list has never seen', () => {
    const local = [{ id: 'b' }, { id: 'a' }];
    const merged = reconcileOrder(local, [A, B, C]);
    expect(orderOf(merged)).toEqual(['b', 'a', 'c']);
  });

  it('drops categories that no longer exist', () => {
    const local = [{ id: 'c' }, { id: 'gone' }, { id: 'a' }];
    expect(orderOf(reconcileOrder(local, [A, C]))).toEqual(['c', 'a']);
  });

  it('returns the server list when nothing is staged locally', () => {
    expect(orderOf(reconcileOrder([], [A, B, C]))).toEqual(['a', 'b', 'c']);
  });
});

/* ------------------------------------------------------------------ *
 * Preview and summary
 * ------------------------------------------------------------------ */

describe('previewCategories', () => {
  it('shows only enabled categories, in the given order', () => {
    const list = [category({ id: 'a', enabled: false }), B, C];
    expect(orderOf(previewCategories(list))).toEqual(['b', 'c']);
  });

  it('is empty when everything is hidden', () => {
    expect(previewCategories([category({ id: 'a', enabled: false })])).toEqual([]);
  });

  it('reflects a staged order rather than the server position field', () => {
    // The workspace reorders the array locally; `position` is stale until save.
    const staged = [category({ id: 'c', position: 2 }), category({ id: 'a', position: 0 })];
    expect(orderOf(previewCategories(staged))).toEqual(['c', 'a']);
  });
});

describe('summarise', () => {
  it('counts totals, enabled, hidden and assigned content', () => {
    const list = [
      category({ id: 'a', assignedAssetCount: 3 }),
      category({ id: 'b', enabled: false, assignedAssetCount: 2 }),
      category({ id: 'c' }),
    ];
    expect(summarise(list)).toEqual({
      total: 3,
      enabled: 2,
      disabled: 1,
      assignedAssets: 5,
    });
  });

  it('handles an empty workspace', () => {
    expect(summarise([])).toEqual({ total: 0, enabled: 0, disabled: 0, assignedAssets: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * Telling the truth about deletion
 * ------------------------------------------------------------------ */

describe('deletionMessage', () => {
  it('states that content survives, and never says it is deleted', () => {
    const message = deletionMessage(category({ id: 'a', name: 'Trending', assignedAssetCount: 4 }));

    expect(message).toContain('4 items');
    expect(message).toContain('unassigned');
    expect(message).toContain('Library');
    // The rule this copy exists to communicate.
    expect(message).toMatch(/Nothing is deleted from the Library/i);
  });

  it('uses singular phrasing for one item', () => {
    const message = deletionMessage(category({ id: 'a', name: 'New', assignedAssetCount: 1 }));
    expect(message).toContain('1 item ');
    expect(message).not.toContain('1 items');
  });

  it('says plainly that an empty category affects nothing', () => {
    const message = deletionMessage(category({ id: 'a', name: 'Empty' }));
    expect(message).toContain('nothing is affected');
    expect(message).not.toContain('Library');
  });
});

describe('assignedLabel', () => {
  it('reads naturally at zero, one and many', () => {
    expect(assignedLabel(0)).toBe('No content yet');
    expect(assignedLabel(1)).toBe('1 item');
    expect(assignedLabel(7)).toBe('7 items');
  });
});

/* ------------------------------------------------------------------ *
 * Guarding an unsaved order against navigation
 * ------------------------------------------------------------------ */

describe('interceptedPath', () => {
  const base = {
    origin: 'https://admin.example.com',
    currentPath: '/admin/publishing',
  };

  it('holds back an ordinary in-app link', () => {
    expect(interceptedPath({ ...base, href: '/admin/characters' })).toBe('/admin/characters');
  });

  it('keeps the query string on the destination', () => {
    expect(interceptedPath({ ...base, href: '/admin/content/library?character=1' })).toBe(
      '/admin/content/library?character=1',
    );
  });

  it('accepts an absolute URL on our own origin', () => {
    expect(
      interceptedPath({ ...base, href: 'https://admin.example.com/admin/characters' }),
    ).toBe('/admin/characters');
  });

  /*
   * Everything below must NOT be intercepted. Swallowing one of these is a
   * worse bug than the unsaved order this guard exists to protect: an operator
   * who cannot open a link in a new tab has no idea why.
   */

  it('leaves a modifier-click alone, so new tabs still work', () => {
    expect(interceptedPath({ ...base, href: '/admin/characters', modified: true })).toBeNull();
  });

  it('leaves a download alone', () => {
    expect(interceptedPath({ ...base, href: '/export.csv', hasDownload: true })).toBeNull();
  });

  it('leaves a link that targets another window alone', () => {
    expect(interceptedPath({ ...base, href: '/admin/characters', target: '_blank' })).toBeNull();
    // _self is the default and still counts as in-app.
    expect(interceptedPath({ ...base, href: '/admin/characters', target: '_self' })).toBe(
      '/admin/characters',
    );
  });

  it('leaves an external origin alone', () => {
    expect(interceptedPath({ ...base, href: 'https://example.com/docs' })).toBeNull();
  });

  it('leaves non-http schemes alone', () => {
    expect(interceptedPath({ ...base, href: 'mailto:someone@example.com' })).toBeNull();
    expect(interceptedPath({ ...base, href: 'tel:+15551234' })).toBeNull();
  });

  it('leaves a same-page hash alone', () => {
    expect(interceptedPath({ ...base, href: '#main' })).toBeNull();
  });

  it('leaves a link to the page we are already on alone', () => {
    expect(interceptedPath({ ...base, href: '/admin/publishing' })).toBeNull();
  });

  it('leaves a missing or unparseable href alone', () => {
    expect(interceptedPath({ ...base, href: null })).toBeNull();
    expect(interceptedPath({ ...base, href: 'http://[bad' })).toBeNull();
  });
});
