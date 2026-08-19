/**
 * Scroll-follow policy for the conversation view.
 *
 * The old behaviour was a single line — `bottomRef.scrollIntoView({ behavior:
 * 'smooth' })` on every update — which failed in three ways:
 *
 *  1. `scrollIntoView` walks up and scrolls the nearest scrollable ANCESTOR,
 *     which in an app shell can be the page rather than the message list. The
 *     viewport ends up somewhere nobody asked for. Setting `scrollTop` on the
 *     list element itself cannot do that.
 *  2. Smooth animations were re-triggered by three separate updates in quick
 *     succession (optimistic message, typing indicator, reply). Each new
 *     animation retargets from wherever the previous one had got to, and a
 *     tall reply changes scrollHeight mid-flight, so it settles short.
 *  3. It force-scrolled unconditionally, so reading older messages was
 *     impossible — any update yanked you back down.
 *
 * The policy here is deliberately just arithmetic and a boolean, with no DOM
 * types, so it is testable in the repo's existing node test environment.
 *
 * The rule: follow the bottom only while the user is already near it. Manual
 * scrolling away turns following off; scrolling back near the bottom turns it
 * on again; SENDING a message always turns it back on, because the user just
 * added the thing they want to see.
 */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How close to the bottom still counts as "following". Roughly one short
 * message: big enough to survive sub-pixel rounding and the bounce at the end
 * of a smooth scroll, small enough that deliberately scrolling up releases it.
 */
export const FOLLOW_THRESHOLD_PX = 80;

/**
 * Beyond this much distance, jump instantly instead of animating. A long
 * smooth scroll is exactly where the animation visibly lags behind further
 * updates, which is what made the chat feel broken.
 */
export const INSTANT_JUMP_PX = 1200;

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

export function isNearBottom(m: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

/** Smooth for small corrections, instant for big jumps. */
export function scrollBehaviorFor(
  m: ScrollMetrics,
  instantJumpPx = INSTANT_JUMP_PX,
): 'smooth' | 'auto' {
  return distanceFromBottom(m) > instantJumpPx ? 'auto' : 'smooth';
}

export interface ScrollFollower {
  /** True while the view should track new content. */
  isFollowing: () => boolean;
  /** Feed every user scroll event; re-evaluates whether to keep following. */
  handleScroll: (m: ScrollMetrics) => void;
  /** Explicitly resume following — used when the user sends a message. */
  resume: () => void;
  /** Whether an update should scroll to the bottom right now. */
  shouldAutoScroll: () => boolean;
}

export function createScrollFollower(threshold = FOLLOW_THRESHOLD_PX): ScrollFollower {
  // Starts true so opening a conversation lands at the newest message.
  let following = true;
  return {
    isFollowing: () => following,
    handleScroll: (m) => {
      following = isNearBottom(m, threshold);
    },
    resume: () => {
      following = true;
    },
    shouldAutoScroll: () => following,
  };
}

/* ------------------------------------------------------------------ *
 * Finding the element that actually scrolls
 * ------------------------------------------------------------------ */

/**
 * WHY THIS EXISTS — measured, not assumed.
 *
 * The message list carries `flex-1 overflow-y-auto`, which reads like a scroll
 * container. In the real shell it is not one. Measured in Chromium at a 412x500
 * viewport with 30 messages:
 *
 *   #list  scrollHeight=2109  clientHeight=2109  -> NOT scrollable
 *   main   scrollHeight=2277  clientHeight=2277  -> NOT scrollable
 *   doc    scrollHeight=2395  clientHeight= 500  -> the real scroller
 *
 * The cause is a chain of indefinite heights: the shell root is `min-h-dvh`
 * (a MINIMUM, so it grows with content), `main` is a flex item whose default
 * `min-height: auto` stops it shrinking below its content, ChatPage's section
 * is `h-full` against that indefinite parent, and the list is another
 * `min-height: auto` flex item. Nothing is ever bounded, so no overflow
 * engages and the document scrolls instead.
 *
 * Two consequences, both of which are the reported bug:
 *   - `list.scrollTo(...)` moved nothing at all. Verified: scrollTop stayed 0.
 *   - `scrollHeight - clientHeight - scrollTop` is 0 on a non-scrolling
 *     element, so the follower read "at the bottom" ALWAYS — while the real
 *     scroller sat 1575px away from it — and its scroll handler never fired,
 *     because a non-scrolling element emits no scroll events.
 *
 * So instead of assuming which element scrolls, find it. This is also why the
 * fix survives the layout being bounded properly later: if the list becomes a
 * real scroll container, it is found first and used.
 */

/** Sub-pixel slack; a 1px difference is rounding, not scrollable content. */
export const SCROLLABLE_EPSILON_PX = 1;

/** Structural shape of a scroll candidate — no DOM types, so node can test it. */
export interface ScrollCandidate {
  scrollHeight: number;
  clientHeight: number;
}

/** True when this box can actually scroll vertically right now. */
export function isScrollableBox(el: ScrollCandidate, overflowY: string): boolean {
  const overflows = el.scrollHeight > el.clientHeight + SCROLLABLE_EPSILON_PX;
  return overflows && (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay');
}

/**
 * Walks from `start` up through `getParent` and returns the first box that
 * genuinely scrolls; falls back to the document scroller when none does.
 *
 * Deliberately re-run rather than cached forever: which element scrolls depends
 * on content height, so an empty conversation and a long one can legitimately
 * differ.
 */
export function findScrollContainer<T extends ScrollCandidate>(
  start: T | null | undefined,
  getOverflowY: (el: T) => string,
  getParent: (el: T) => T | null | undefined,
  fallback: T | null,
): T | null {
  let node = start ?? null;
  while (node) {
    if (isScrollableBox(node, getOverflowY(node))) return node;
    node = getParent(node) ?? null;
  }
  return fallback;
}
