import { describe, it, expect } from 'vitest';
import {
  createScrollFollower,
  distanceFromBottom,
  findScrollContainer,
  isNearBottom,
  isScrollableBox,
  scrollBehaviorFor,
  FOLLOW_THRESHOLD_PX,
  INSTANT_JUMP_PX,
  type ScrollMetrics,
} from './chatScroll';

/**
 * Scroll-follow policy. Pure arithmetic and one boolean, so it runs in the
 * repo's existing node test environment with no DOM stack.
 */

/** A viewport 600px tall over `content` px of messages, scrolled to `top`. */
const at = (top: number, content = 3000, viewport = 600): ScrollMetrics => ({
  scrollTop: top,
  scrollHeight: content,
  clientHeight: viewport,
});

const BOTTOM = at(2400); // 3000 - 600 = pinned to the bottom

describe('distance and thresholds', () => {
  it('reports zero distance when pinned to the bottom', () => {
    expect(distanceFromBottom(BOTTOM)).toBe(0);
    expect(isNearBottom(BOTTOM)).toBe(true);
  });

  it('treats a small gap as still following', () => {
    expect(isNearBottom(at(2400 - (FOLLOW_THRESHOLD_PX - 1)))).toBe(true);
    expect(isNearBottom(at(2400 - FOLLOW_THRESHOLD_PX))).toBe(true); // boundary included
  });

  it('treats a deliberate scroll up as not following', () => {
    expect(isNearBottom(at(2400 - (FOLLOW_THRESHOLD_PX + 1)))).toBe(false);
    expect(isNearBottom(at(0))).toBe(false);
  });

  it('never reports a negative distance when content is shorter than the viewport', () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 600 })).toBe(0);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 600 })).toBe(true);
  });
});

describe('scroll behaviour choice', () => {
  it('animates small corrections', () => {
    expect(scrollBehaviorFor(BOTTOM)).toBe('smooth');
    expect(scrollBehaviorFor(at(2400 - 300))).toBe('smooth');
  });

  it('jumps instantly over a long distance, so the animation cannot lag behind', () => {
    expect(scrollBehaviorFor(at(0, 5000))).toBe('auto'); // 4400px away
    expect(scrollBehaviorFor(at(2400 - (INSTANT_JUMP_PX + 1)))).toBe('auto');
  });
});

describe('follow state', () => {
  it('follows by default, so opening a conversation lands on the newest message', () => {
    expect(createScrollFollower().shouldAutoScroll()).toBe(true);
  });

  it('sending a message resumes following (requirement: send always shows the new message)', () => {
    const f = createScrollFollower();
    f.handleScroll(at(0)); // user had scrolled right up
    expect(f.shouldAutoScroll()).toBe(false);

    f.resume();
    expect(f.isFollowing()).toBe(true);
    expect(f.shouldAutoScroll()).toBe(true);
  });

  it('a pending typing indicator keeps following while the user is at the bottom', () => {
    const f = createScrollFollower();
    f.handleScroll(BOTTOM);
    // The indicator arriving is just another update; the policy must still say yes.
    expect(f.shouldAutoScroll()).toBe(true);
    // ...and again when the reply lands and the content grows.
    f.handleScroll(at(3400, 4000));
    expect(f.shouldAutoScroll()).toBe(true);
  });

  it('a new response scrolls to the bottom for a following user', () => {
    const f = createScrollFollower();
    f.handleScroll(BOTTOM);
    expect(f.shouldAutoScroll()).toBe(true);
  });

  it('does NOT force a user who scrolled up back to the bottom on unrelated updates', () => {
    const f = createScrollFollower();
    f.handleScroll(at(400)); // reading history
    expect(f.shouldAutoScroll()).toBe(false);

    // Content keeps arriving; the policy must stay "no" every time.
    f.handleScroll(at(400, 4000));
    expect(f.shouldAutoScroll()).toBe(false);
    f.handleScroll(at(400, 5000));
    expect(f.shouldAutoScroll()).toBe(false);
  });

  it('resumes on its own once the user scrolls back down to the bottom', () => {
    const f = createScrollFollower();
    f.handleScroll(at(400));
    expect(f.shouldAutoScroll()).toBe(false);

    f.handleScroll(BOTTOM);
    expect(f.shouldAutoScroll()).toBe(true);
  });

  it('honours a custom threshold', () => {
    const f = createScrollFollower(10);
    f.handleScroll(at(2400 - 50)); // inside the default 80px, outside a 10px one
    expect(f.shouldAutoScroll()).toBe(false);
  });
});

/**
 * Finding the element that actually scrolls.
 *
 * These encode the measured production layout. In Chromium at 412x500 with 30
 * messages the message list reported scrollHeight === clientHeight === 2109 —
 * it is NOT a scroll container — while the document reported 2395 vs 500 and
 * sat 1575px from the bottom. Scrolling the list therefore moved nothing, and
 * because a non-scrolling element emits no scroll events, the follower never
 * received a single update and read "at the bottom" forever.
 *
 * NOTE ON WHAT THIS CANNOT DO: these are structural, not layout, tests. They
 * cannot compute a real height, cannot open a keyboard, and would not have
 * caught the original bug on their own — only a browser could, and did.
 */

/** Mirrors the measured production shell: nothing overflows until the document. */
const shell = () => {
  const doc = { scrollHeight: 2395, clientHeight: 500, id: 'document' };
  const root = { scrollHeight: 2277, clientHeight: 2277, id: 'root', parent: doc };
  const main = { scrollHeight: 2277, clientHeight: 2277, id: 'main', parent: root };
  const section = { scrollHeight: 2109, clientHeight: 2109, id: 'section', parent: main };
  const list = { scrollHeight: 2109, clientHeight: 2109, id: 'list', parent: section };
  return { doc, root, main, section, list };
};

type Box = { scrollHeight: number; clientHeight: number; id: string; parent?: Box };

const overflowOf = (el: Box) =>
  el.id === 'list' || el.id === 'main' ? 'auto' : el.id === 'document' ? 'auto' : 'visible';

const resolve = (start: Box | null, fallback: Box | null) =>
  findScrollContainer<Box>(start, overflowOf, (el) => el.parent ?? null, fallback);

describe('isScrollableBox', () => {
  it('is false when content exactly fits — the production list case', () => {
    expect(isScrollableBox({ scrollHeight: 2109, clientHeight: 2109 }, 'auto')).toBe(false);
  });

  it('ignores sub-pixel rounding', () => {
    expect(isScrollableBox({ scrollHeight: 2110, clientHeight: 2109 }, 'auto')).toBe(false);
    expect(isScrollableBox({ scrollHeight: 2111, clientHeight: 2109 }, 'auto')).toBe(true);
  });

  it('requires an overflow that actually scrolls', () => {
    const overflowing = { scrollHeight: 3000, clientHeight: 500 };
    expect(isScrollableBox(overflowing, 'auto')).toBe(true);
    expect(isScrollableBox(overflowing, 'scroll')).toBe(true);
    expect(isScrollableBox(overflowing, 'visible')).toBe(false);
    expect(isScrollableBox(overflowing, 'hidden')).toBe(false);
  });
});

describe('findScrollContainer', () => {
  it('does NOT pick the message list when the list does not scroll', () => {
    const s = shell();
    // The exact regression: overflow-y-auto is present, but nothing overflows.
    expect(resolve(s.list, s.doc)!.id).not.toBe('list');
  });

  it('falls through to the document, which is what really scrolls', () => {
    const s = shell();
    expect(resolve(s.list, s.doc)!.id).toBe('document');
  });

  it('prefers the list once the layout is bounded and it genuinely scrolls', () => {
    // Guards the fix against a future layout change: if the list is given a
    // real height, it must be used instead of the document, with no code edit.
    const s = shell();
    s.list.clientHeight = 400;
    expect(resolve(s.list, s.doc)!.id).toBe('list');
  });

  it('picks the nearest scrolling ancestor, not the outermost one', () => {
    const s = shell();
    s.main.clientHeight = 450;
    expect(resolve(s.list, s.doc)!.id).toBe('main');
  });

  it('returns the fallback when the chain is empty', () => {
    const s = shell();
    expect(resolve(null, s.doc)!.id).toBe('document');
  });
});

describe('the follower, fed by the REAL scroller instead of a dead element', () => {
  it('a non-scrolling element always reports "at the bottom" — the old bug', () => {
    // Every message list metric was this, forever, no matter where the user was.
    const dead = { scrollTop: 0, scrollHeight: 2109, clientHeight: 2109 };
    expect(distanceFromBottom(dead)).toBe(0);
    expect(isNearBottom(dead)).toBe(true);
  });

  it('the real scroller reports the true distance, so scrolling up releases', () => {
    const real = { scrollTop: 820, scrollHeight: 2395, clientHeight: 820 };
    expect(distanceFromBottom(real)).toBe(755);
    expect(isNearBottom(real)).toBe(false);

    const follower = createScrollFollower();
    follower.handleScroll(real);
    expect(follower.shouldAutoScroll()).toBe(false); // impossible before the fix
  });

  it('returning to the bottom of the real scroller resumes following', () => {
    const follower = createScrollFollower();
    follower.handleScroll({ scrollTop: 820, scrollHeight: 2395, clientHeight: 820 });
    expect(follower.shouldAutoScroll()).toBe(false);
    follower.handleScroll({ scrollTop: 1575, scrollHeight: 2395, clientHeight: 820 });
    expect(follower.shouldAutoScroll()).toBe(true);
  });

  it('a keyboard-close resize leaves the user short of the bottom until re-pinned', () => {
    // Pinned with the keyboard open (clientHeight 500)...
    const pinned = { scrollTop: 1895, scrollHeight: 2395, clientHeight: 500 };
    expect(distanceFromBottom(pinned)).toBe(0);
    // ...then the keyboard closes and clientHeight grows. Same scrollTop, and
    // scrollHeight grows too because the composer is no longer compressed.
    const afterResize = { scrollTop: 1895, scrollHeight: 3000, clientHeight: 820 };
    expect(distanceFromBottom(afterResize)).toBe(285); // stranded — must re-pin
    expect(isNearBottom(afterResize)).toBe(false);
  });
});
