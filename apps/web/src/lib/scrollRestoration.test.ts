import { describe, expect, it } from 'vitest';
import {
  applyScrollTarget,
  maxScrollTop,
  scrollActionFor,
  type Scrollable,
} from './scrollRestoration';

/**
 * The reported bug: tapping a clip part-way down Home opened the character page
 * already scrolled to that offset, "somewhere in the middle".
 *
 * The cause is structural -- `AppShell`'s `<main>` is the app's only vertical
 * scroller and is not remounted between routes, so its `scrollTop` carries over.
 * These tests cover the DECISION and the RETRY, which is everything except the
 * two lines of wiring: the web suite runs in node with no jsdom, so an effect
 * that touches a scroll container cannot be exercised where it lives.
 *
 * Each case below is named after the behaviour it protects, in the order they
 * were specified.
 */

const el = (scrollHeight: number, clientHeight: number, scrollTop = 0): Scrollable => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('which screens start at the top', () => {
  /** 1. Home -> Character page. */
  it('opens a character page at the top when tapped from Home', () => {
    expect(
      scrollActionFor({
        navigationType: 'PUSH',
        pathname: '/characters/abc',
        previousPathname: '/characters',
        savedTop: undefined,
      }),
    ).toEqual({ kind: 'top' });
  });

  /** 2. Character A -> Character B. Same route pattern, different screen. */
  it('opens a DIFFERENT character at the top', () => {
    expect(
      scrollActionFor({
        navigationType: 'PUSH',
        pathname: '/characters/bbb',
        previousPathname: '/characters/aaa',
        savedTop: undefined,
      }),
    ).toEqual({ kind: 'top' });
  });

  /**
   * A stale offset must not win just because the destination key happens to
   * carry one. Only POP restores.
   */
  it('ignores a saved offset on forward navigation', () => {
    expect(
      scrollActionFor({
        navigationType: 'PUSH',
        pathname: '/characters/abc',
        previousPathname: '/characters',
        savedTop: 820,
      }),
    ).toEqual({ kind: 'top' });
  });

  it('starts at the top after a REPLACE onto a different screen', () => {
    // e.g. the `/` -> `/characters` redirect.
    expect(
      scrollActionFor({
        navigationType: 'REPLACE',
        pathname: '/characters',
        previousPathname: '/',
        savedTop: undefined,
      }),
    ).toEqual({ kind: 'top' });
  });
});

describe('what Back and Forward restore', () => {
  /** 3. Character page -> Home via Back. */
  it("restores Home's position on Back", () => {
    expect(
      scrollActionFor({
        navigationType: 'POP',
        pathname: '/characters',
        previousPathname: '/characters/abc',
        savedTop: 820,
      }),
    ).toEqual({ kind: 'restore', top: 820 });
  });

  /** 4. Character A -> Character B -> Back. */
  it("restores character A's position on Back from character B", () => {
    expect(
      scrollActionFor({
        navigationType: 'POP',
        pathname: '/characters/aaa',
        previousPathname: '/characters/bbb',
        savedTop: 240,
      }),
    ).toEqual({ kind: 'restore', top: 240 });
  });

  /** 5. Forward with a saved position restores it. */
  it('restores on Forward when the destination was seen before', () => {
    expect(
      scrollActionFor({
        navigationType: 'POP',
        pathname: '/characters/abc',
        previousPathname: '/characters',
        savedTop: 512,
      }),
    ).toEqual({ kind: 'restore', top: 512 });
  });

  /** 5. Forward into somewhere this session never rendered. */
  it('opens at the top on POP with nothing saved', () => {
    expect(
      scrollActionFor({
        navigationType: 'POP',
        pathname: '/characters/abc',
        previousPathname: '/characters',
        savedTop: undefined,
      }),
    ).toEqual({ kind: 'top' });
  });

  /**
   * ZERO IS A POSITION, NOT AN ABSENCE. A visitor who was at the top of Home
   * must be restored to the top, which is indistinguishable from "no memory"
   * unless presence is what decides.
   */
  it('treats a saved 0 as a real position', () => {
    expect(
      scrollActionFor({
        navigationType: 'POP',
        pathname: '/characters',
        previousPathname: '/characters/abc',
        savedTop: 0,
      }),
    ).toEqual({ kind: 'restore', top: 0 });
  });
});

describe('what must NOT move', () => {
  /** 6. A query-string change is not a screen change. */
  it('leaves the lobby alone when only the search parameters change', () => {
    expect(
      scrollActionFor({
        navigationType: 'PUSH',
        pathname: '/characters',
        previousPathname: '/characters',
        savedTop: undefined,
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('leaves it alone for a REPLACE on the same screen too', () => {
    // Filter changes are usually replaced rather than pushed.
    expect(
      scrollActionFor({
        navigationType: 'REPLACE',
        pathname: '/characters',
        previousPathname: '/characters',
        savedTop: 300,
      }),
    ).toEqual({ kind: 'keep' });
  });

  /** The first paint has nothing to restore and nothing to reset. */
  it('does nothing on the very first render', () => {
    expect(
      scrollActionFor({
        navigationType: 'PUSH',
        pathname: '/characters/abc',
        previousPathname: null,
        savedTop: undefined,
      }),
    ).toEqual({ kind: 'keep' });
  });
});

/* ------------------------------------------------------------------ *
 * Applying the target
 * ------------------------------------------------------------------ */

describe('reaching the target', () => {
  it('measures how far a container can scroll', () => {
    expect(maxScrollTop(el(2000, 800))).toBe(1200);
    // A container shorter than its viewport cannot scroll at all.
    expect(maxScrollTop(el(400, 800))).toBe(0);
  });

  it('resets to the top in one attempt, whatever the height', () => {
    const short = el(100, 800, 640);
    expect(applyScrollTarget(short, 0)).toBe('done');
    expect(short.scrollTop).toBe(0);
  });

  it('applies a reachable offset immediately', () => {
    const tall = el(2000, 800);
    expect(applyScrollTarget(tall, 820)).toBe('done');
    expect(tall.scrollTop).toBe(820);
  });

  /**
   * THE RETRY IS THE POINT. A restored offset is unreachable until the
   * destination's data arrives and gives the container height. Applying it
   * anyway would land short and look like restoration had failed.
   */
  it('waits, and changes nothing, while the destination is still short', () => {
    const loading = el(300, 800);
    expect(applyScrollTarget(loading, 820)).toBe('wait');
    expect(loading.scrollTop, 'must not land short').toBe(0);
  });

  it('succeeds on a later attempt once the content has grown', () => {
    const growing = { scrollTop: 0, scrollHeight: 300, clientHeight: 800 };
    expect(applyScrollTarget(growing, 820)).toBe('wait');
    growing.scrollHeight = 2400; // data arrived
    expect(applyScrollTarget(growing, 820)).toBe('done');
    expect(growing.scrollTop).toBe(820);
  });

  it('accepts a target exactly at the maximum', () => {
    const exact = el(1600, 800);
    expect(applyScrollTarget(exact, 800)).toBe('done');
    expect(exact.scrollTop).toBe(800);
  });
});
