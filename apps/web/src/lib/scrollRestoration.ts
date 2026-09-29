/**
 * Scroll restoration for the customer shell's ONE scroll container.
 *
 * ── WHY THIS IS A MODULE AND NOT SIX LINES IN AppShell ───────────────────────
 *
 * The behaviour is a decision (reset, restore, or leave alone) plus a retry
 * (a restored offset is unreachable until the destination has rendered enough
 * height to hold it). Both are worth testing, and neither can be tested where
 * they are used: the web suite runs `environment: 'node'` with
 * `renderToStaticMarkup` and no jsdom, so effects never run and nothing scrolls.
 * Splitting the decision out is what makes the navigation rules assertable at
 * all; `AppShell` keeps only the wiring, which is the part a DOM test would
 * have covered.
 *
 * ── WHAT ACTUALLY SCROLLS ────────────────────────────────────────────────────
 *
 * The DOCUMENT, not `<main>`. `AppShell` renders its routes inside
 * `<main class="… overflow-y-auto">`, which reads like the scroll container and
 * is not one: `min-h-dvh` on the shell is a MINIMUM, so the shell grows past the
 * viewport, `flex-1` then sizes `<main>` to its content, and the overflow never
 * engages. Measured on the running lobby:
 *
 *   main      scrollHeight 5979 === clientHeight 5979   -> cannot scroll
 *   document  scrollHeight 6078 vs  clientHeight  768   -> scrolls
 *
 * THE FIRST ATTEMPT RESET `<main>` AND DID NOTHING, because its `scrollTop` is
 * permanently 0. Recorded here because the class list is genuinely misleading,
 * and reading it was how the wrong element got picked in the first place.
 *
 * The document keeps its offset across a client-side navigation, which is the
 * bug: window 1400 on Home became window 909 on the character page -- clamped
 * only because her page is shorter, not reset.
 */

/** The only part of an element this module needs, so a test can pass an object. */
export interface Scrollable {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export type NavigationKind = 'PUSH' | 'REPLACE' | 'POP';

export type ScrollAction =
  /** Put the destination back where the visitor left it. */
  | { kind: 'restore'; top: number }
  /** A new screen: start at the beginning. */
  | { kind: 'top' }
  /** Not a screen change at all -- do not touch what the visitor is reading. */
  | { kind: 'keep' };

/**
 * What a navigation should do to the scroll container.
 *
 * KEYED ON THE PATHNAME, NOT THE LOCATION KEY, for forward navigation. Every
 * navigation gets a fresh key -- including one that only changes a query string
 * -- so resetting per key would scroll the lobby back to the top every time a
 * filter or a search term changed. The pathname is what identifies a SCREEN.
 *
 * POP IS DECIDED BY THE SAVED OFFSET, not by the pathname, because Back and
 * Forward are the two cases where the visitor has a place to be returned to.
 * With nothing saved -- a forward jump into a location this session never
 * rendered -- the honest answer is the top, not an arbitrary leftover offset.
 */
export function scrollActionFor(input: {
  navigationType: NavigationKind;
  pathname: string;
  /** Null on the very first render, when there is nothing to have left. */
  previousPathname: string | null;
  /** What was recorded for the DESTINATION's location key, if anything. */
  savedTop: number | undefined;
}): ScrollAction {
  const { navigationType, pathname, previousPathname, savedTop } = input;

  if (navigationType === 'POP') {
    // 0 is a real saved position (the top), so the test is on presence.
    return savedTop === undefined ? { kind: 'top' } : { kind: 'restore', top: savedTop };
  }

  // First render: the container is already at 0 and there is no history to
  // honour. Touching it here would fight a deep link that scrolled itself.
  if (previousPathname === null) return { kind: 'keep' };

  // A query-string change on the same screen is not a navigation the visitor
  // experienced as one.
  if (previousPathname === pathname) return { kind: 'keep' };

  return { kind: 'top' };
}

/** How far this container can actually be scrolled right now. */
export function maxScrollTop(el: Scrollable): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

/**
 * One attempt at putting the container at `target`.
 *
 * `'wait'` means the destination has not rendered enough height yet -- a
 * restored offset of 900px cannot be applied to a container that is still 300px
 * tall because its data has not arrived. The caller retries on later frames;
 * without that, restoration silently lands short of where the visitor was and
 * looks like it did not work.
 *
 * Returns `'done'` for the top, always: 0 is reachable by definition, so a reset
 * never needs a second frame.
 */
export function applyScrollTarget(el: Scrollable, target: number): 'done' | 'wait' {
  if (target <= 0) {
    el.scrollTop = 0;
    return 'done';
  }
  if (maxScrollTop(el) < target) return 'wait';
  el.scrollTop = target;
  return 'done';
}
