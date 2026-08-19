import { describe, it, expect } from 'vitest';
import {
  createScrollFollower,
  distanceFromBottom,
  isNearBottom,
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
