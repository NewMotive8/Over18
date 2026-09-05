import { describe, expect, it } from 'vitest';
import {
  applyAction,
  galleryCards,
  heartAction,
  heartState,
  swipeAction,
} from './favourites';
import type { PublicPlayWithMeCard } from './api';

/**
 * The Favourites product rules.
 *
 * These are the rules the brief states in prose — a right swipe never removes,
 * only the filled heart does, the heart shows what is stored, a favourite with
 * no clip produces no tile — expressed as functions so they can be checked
 * rather than read. The gesture geometry is `swipe.test.ts`; this is what a
 * committed gesture MEANS.
 */

function card(id: string, clip: PublicPlayWithMeCard['clip']): PublicPlayWithMeCard {
  return { id, displayName: `Name ${id}`, apparentAgeBand: null, categories: [], clip };
}

const video = (id: string) => ({
  id: `asset-${id}`,
  mediaType: 'video' as const,
  url: `/api/media/assets/asset-${id}/file`,
  characterId: id,
  characterName: `Name ${id}`,
});

const image = (id: string) => ({ ...video(id), mediaType: 'image' as const });

describe('swipeAction — what a completed swipe does to Favourites', () => {
  it('LEFT never favourites, whatever the current state', () => {
    expect(swipeAction('pass', false)).toBe('none');
    expect(swipeAction('pass', true)).toBe('none');
  });

  it('RIGHT on a non-favourite adds her', () => {
    expect(swipeAction('like', false)).toBe('add');
  });

  it('RIGHT on someone already favourited leaves her favourited', () => {
    // The rule a toggle would break: this must not be 'remove', and it must not
    // re-save her either.
    expect(swipeAction('like', true)).toBe('none');
  });

  it('NO swipe input can ever produce a removal', () => {
    const every = (['like', 'pass'] as const).flatMap((decision) =>
      [true, false].map((favourited) => swipeAction(decision, favourited)),
    );
    expect(every).not.toContain('remove');
  });
});

describe('heartAction — the only way to remove', () => {
  it('a filled heart removes', () => {
    expect(heartAction(true)).toBe('remove');
  });

  it('an outline heart adds', () => {
    expect(heartAction(false)).toBe('add');
  });
});

describe('heartState — a readout of what is stored', () => {
  it('is filled when favourited and outline when not', () => {
    expect(heartState(true)).toBe('filled');
    expect(heartState(false)).toBe('outline');
  });
});

describe('applyAction', () => {
  it('adds, removes, and leaves the set alone for none', () => {
    const base = new Set(['a']);
    expect([...applyAction(base, 'b', 'add')].sort()).toEqual(['a', 'b']);
    expect([...applyAction(base, 'a', 'remove')]).toEqual([]);
    expect([...applyAction(base, 'a', 'none')]).toEqual(['a']);
  });

  it('never mutates the set it was given', () => {
    const base = new Set(['a']);
    applyAction(base, 'b', 'add');
    applyAction(base, 'a', 'remove');
    expect([...base]).toEqual(['a']);
  });

  it('adding someone already in the set leaves her in it, once', () => {
    expect([...applyAction(new Set(['a']), 'a', 'add')]).toEqual(['a']);
  });
});

describe('galleryCards — a favourite with no current clip shows no tile', () => {
  it('keeps a favourite with a real video clip', () => {
    expect(galleryCards([card('a', video('a'))]).map((c) => c.id)).toEqual(['a']);
  });

  it('drops a favourite whose clip is null — no placeholder, no substitute', () => {
    expect(galleryCards([card('a', null)])).toEqual([]);
  });

  it('drops an IMAGE clip: these surfaces are video, and a still is not a clip', () => {
    expect(galleryCards([card('a', image('a'))])).toEqual([]);
  });

  it('shows exactly one card per favourite, and only the renderable ones', () => {
    const visible = galleryCards([card('a', video('a')), card('b', null), card('c', video('c'))]);
    expect(visible.map((c) => c.id)).toEqual(['a', 'c']);
    expect(visible).toHaveLength(new Set(visible.map((c) => c.id)).size);
  });
});
