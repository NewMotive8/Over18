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
