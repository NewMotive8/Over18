import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether an element is on screen, and whether it is close enough to be worth
 * loading.
 *
 * WHY TWO ANSWERS RATHER THAN ONE. Loading and playing want different moments.
 * A clip should START FETCHING slightly before it appears, so that by the time
 * the user reaches it there is something to show — waiting until it is already
 * on screen just moves the stall to a worse place. But it should only PLAY
 * while it is genuinely visible: a decoder running on something nobody can see
 * spends battery and GPU for nothing. So `near` is generous and `visible` is
 * strict, and callers use each for its own purpose.
 *
 * SSR-SAFE BY DEFAULT, and this matters in this repo specifically: the web
 * tests run in node with no DOM, so `IntersectionObserver` is undefined there.
 * Rather than making every caller branch, both answers default to TRUE when the
 * API is missing. Server-rendered markup therefore contains the real `src`
 * exactly as before, and the assertions that pin it keep working — the laziness
 * is a browser-only optimisation, never a change to what the markup means.
 *
 * MEASURED PROBLEM THIS SOLVES: on one Home load, 18 of 24 video elements were
 * off screen and had already buffered data, and 9 of 9 Search clips — an entire
 * section below the fold — had downloaded before the user scrolled anywhere
 * near them.
 */
export interface ViewportState {
  /** Close enough to start fetching. Generous by design. */
  near: boolean;
  /** Actually on screen, so playing is worth the decode. Strict by design. */
  visible: boolean;
}

/**
 * How far outside the viewport counts as "about to be seen".
 *
 * Roughly one card ahead in a horizontal rail and about half a screen
 * vertically. Large enough that a swipe or a scroll finds media already
 * arriving; small enough that a page of rails does not fetch everything at
 * once, which is the behaviour being removed.
 */
const LOAD_MARGIN = '400px';

export function useInViewport(
  ref: RefObject<Element | null>,
  options: { rootMargin?: string; disabled?: boolean } = {},
): ViewportState {
  const supported = typeof IntersectionObserver !== 'undefined';
  const disabled = options.disabled === true;
  const assumeEverything = !supported || disabled;

  const [state, setState] = useState<ViewportState>(() => ({
    near: assumeEverything,
    visible: assumeEverything,
  }));

  const rootMargin = options.rootMargin ?? LOAD_MARGIN;

  useEffect(() => {
    if (assumeEverything) {
      setState({ near: true, visible: true });
      return;
    }
    const el = ref.current;
    if (!el) return;

    // Two observers rather than one: `rootMargin` is a property of the
    // observer, not of an entry, so a single observer cannot answer both
    // questions. They are cheap — the browser batches them off the main thread.
    const nearObserver = new IntersectionObserver(
      ([entry]) => entry && setState((s) => (s.near === entry.isIntersecting ? s : { ...s, near: entry.isIntersecting })),
      { rootMargin },
    );
    const visibleObserver = new IntersectionObserver(
      ([entry]) =>
        entry &&
        setState((s) => (s.visible === entry.isIntersecting ? s : { ...s, visible: entry.isIntersecting })),
      { rootMargin: '0px' },
    );

    nearObserver.observe(el);
    visibleObserver.observe(el);
    return () => {
      nearObserver.disconnect();
      visibleObserver.disconnect();
    };
  }, [ref, rootMargin, assumeEverything]);

  return state;
}
