import { findScrollContainer, type ScrollMetrics } from './chatScroll';

/**
 * The DOM half of keeping a conversation pinned to its newest message.
 *
 * chatScroll.ts is pure arithmetic and stays node-testable. This module is the
 * part that must touch real layout, and it exists because the arithmetic was
 * never the problem — it was being fed by an element that does not scroll.
 *
 * Three jobs:
 *   1. Find the element that ACTUALLY scrolls (see findScrollContainer).
 *   2. Read metrics from that element, so the follower's "is the user near the
 *      bottom" question is asked about the real scroller.
 *   3. Re-pin when the viewport resizes — which on Android is the keyboard
 *      opening and closing.
 *
 * NO TIMERS. The old failure mode here is a `setTimeout(..., 300)` guess at how
 * long the keyboard takes to animate; it is wrong on some devices every time.
 * Instead this listens for the events the browser already fires when layout
 * changes (`visualViewport` resize, window resize, and a ResizeObserver on the
 * content) and re-pins on the next animation frame — one frame is "after layout
 * has settled", not an arbitrary delay.
 */

/** Reads live metrics off the element that is really scrolling. */
export function metricsOf(el: HTMLElement): ScrollMetrics {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  };
}

/**
 * Resolves the real scroll container for a message list, using live computed
 * styles. Returns the document scroller when nothing nearer actually scrolls —
 * which, with the shell's current unbounded layout, is what happens.
 */
export function resolveScrollContainer(list: HTMLElement | null): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const documentScroller = (document.scrollingElement as HTMLElement | null) ?? document.body;
  return findScrollContainer<HTMLElement>(
    list,
    (el) => (el === documentScroller ? 'auto' : getComputedStyle(el).overflowY),
    (el) => el.parentElement,
    documentScroller,
  );
}

/**
 * Pins a container to its true bottom.
 *
 * INSTANT, always — `scrollTop = scrollHeight` rather than a smooth animation.
 * A smooth scroll is an animation over time, and the post-send correction
 * happens exactly when the keyboard is closing and scrollHeight is still
 * changing underneath it: the animation targets a bottom that no longer exists
 * and settles short. This is the "critical post-send correction" that must not
 * be animated.
 */
export function pinToBottom(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}

export interface ViewportAnchorOptions {
  /** The message list element; the search for a real scroller starts here. */
  getList: () => HTMLElement | null;
  /** True when following should happen — normally follower.shouldAutoScroll. */
  shouldFollow: () => boolean;
  /** Receives metrics from the REAL scroller on every scroll event. */
  onScroll: (metrics: ScrollMetrics) => void;
  /** Test seam for requestAnimationFrame. */
  raf?: (cb: () => void) => number;
  cancelRaf?: (handle: number) => void;
}

export interface ViewportAnchor {
  /** Pin now if following (or unconditionally when `force`). */
  pin: (force?: boolean) => void;
  /** Re-resolve the scroller and rebind listeners. Call when the list mounts. */
  attach: () => void;
  /** Remove every listener and observer. */
  dispose: () => void;
}

/**
 * Wires a message list to whatever element actually scrolls it, and keeps it
 * pinned to the bottom across content growth and viewport resizes.
 *
 * Every path funnels through ONE `pin()` guarded by `shouldFollow()`, so there
 * are never two mechanisms racing to move the viewport — which is the other way
 * this class of bug usually presents.
 */
export function createViewportAnchor(options: ViewportAnchorOptions): ViewportAnchor {
  const raf = options.raf ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancelRaf = options.cancelRaf ?? ((h: number) => cancelAnimationFrame(h));

  let container: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let frame: number | null = null;
  /**
   * Set while a viewport resize is in flight. A resize makes the browser emit
   * scroll events we did not ask for, and during a keyboard close those report
   * a position far from the bottom — which would flip following OFF and leave
   * the user stranded exactly where they complained about being stranded.
   * Those events are ignored; the user's own scrolling is not.
   */
  let resizing = false;

  /** Scroll events for the document arrive on window, not on the element. */
  const scrollEventTarget = (): EventTarget | null => {
    if (!container) return null;
    const documentScroller = document.scrollingElement ?? document.body;
    return container === documentScroller ? window : container;
  };

  const handleScroll = () => {
    if (!container || resizing) return;
    options.onScroll(metricsOf(container));
  };

  const pin = (force = false) => {
    if (!container) return;
    if (!force && !options.shouldFollow()) return;
    pinToBottom(container);
  };

  /**
   * A resize (the keyboard opening or closing) changes clientHeight, and the
   * correction must land AFTER the browser has finished laying out — otherwise
   * we pin to a scrollHeight that is about to change. One animation frame is
   * that boundary. `resizing` stays set across the frame so the resize's own
   * scroll events cannot flip following off before we re-pin.
   */
  const handleViewportResize = () => {
    if (!options.shouldFollow()) return;
    resizing = true;
    if (frame !== null) cancelRaf(frame);
    frame = raf(() => {
      frame = null;
      // Re-resolve: a resize can change WHICH element overflows.
      container = resolveScrollContainer(options.getList());
      pin(true); // we were following before the resize; stay at the bottom
      resizing = false;
    });
  };

  const bind = () => {
    const target = scrollEventTarget();
    target?.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleViewportResize);
    window.visualViewport?.addEventListener('resize', handleViewportResize);
    const list = options.getList();
    if (list && typeof ResizeObserver !== 'undefined') {
      // Content growing (a reply, an image finishing load) is also a layout
      // change that must keep the newest message visible.
      resizeObserver = new ResizeObserver(() => pin());
      resizeObserver.observe(list);
    }
  };

  const unbind = () => {
    const target = scrollEventTarget();
    target?.removeEventListener('scroll', handleScroll);
    window.removeEventListener('resize', handleViewportResize);
    window.visualViewport?.removeEventListener('resize', handleViewportResize);
    resizeObserver?.disconnect();
    resizeObserver = null;
  };

  return {
    pin,
    attach: () => {
      unbind();
      container = resolveScrollContainer(options.getList());
      bind();
    },
    dispose: () => {
      if (frame !== null) cancelRaf(frame);
      frame = null;
      unbind();
      container = null;
    },
  };
}
