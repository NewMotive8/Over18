import { useEffect, useRef } from 'react';
import { Link, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import CreditsPill from './CreditsPill';
import MobileNavigation from './MobileNavigation';
import StagingBanner from './StagingBanner';
import { applyScrollTarget, scrollActionFor, type NavigationKind } from '../lib/scrollRestoration';

/**
 * Persistent application shell (US-18).
 *
 * The single frame every screen renders inside: a sticky brand bar, a scrollable
 * content outlet, and the persistent primary navigation. Mobile-first (centered,
 * max-w-lg, so desktop keeps the same product presentation). The content area is
 * its own scroll region ABOVE the nav, so nothing sits underneath the nav; safe-
 * area insets protect the viewport edges.
 *
 * The shell is intentionally auth-agnostic — account concerns live in the
 * Profile destination — which keeps it a pure, reusable layout primitive.
 */
/** How long to keep trying to reach a restored offset. ~1.5s at 60fps. */
const RESTORE_FRAME_BUDGET = 90;

export default function AppShell() {
  const location = useLocation();
  const { pathname } = location;
  const navigationType = useNavigationType() as NavigationKind;

  /* ------------------------------------------------------------------ *
   * Scroll position, per history entry
   *
   * THE DOCUMENT SCROLLS, NOT `<main>`, AND THAT WAS WORTH MEASURING. `<main>`
   * below carries `overflow-y-auto`, which reads like the scroll container and
   * is not one: `min-h-dvh` on the shell is a MINIMUM, so the shell grows past
   * the viewport, `flex-1` then sizes `<main>` to its content, and the overflow
   * never engages. Measured on the running lobby:
   *
   *   main      scrollHeight 5979 === clientHeight 5979   -> cannot scroll
   *   document  scrollHeight 6078 vs  clientHeight  768   -> scrolls
   *
   * A first attempt reset `<main>` and did nothing at all, because its
   * `scrollTop` is permanently 0. The window is what carries a position from one
   * screen to the next, which is why tapping a clip part-way down Home opened
   * the character page already scrolled -- reproduced at window 1400 on Home
   * becoming window 909 on her page.
   *
   * The decision itself lives in `lib/scrollRestoration` so it can be tested:
   * this suite runs in node with no DOM, so nothing here executes under test.
   * ------------------------------------------------------------------ */
  const positions = useRef(new Map<string, number>());
  const currentKey = useRef(location.key);
  const previousPathname = useRef<string | null>(null);

  /**
   * RECORDED AS THE VISITOR SCROLLS, not as they leave.
   *
   * An effect cleanup looked tidier and was wrong: by the time it runs React has
   * already swapped in the destination, and a shorter destination clamps
   * `scrollTop` -- so the position saved for the page being left was whatever
   * survived the swap, not where the visitor actually was. A passive listener
   * records the truth while it is still true.
   */
  useEffect(() => {
    const onScroll = () => {
      const el = document.scrollingElement;
      if (el) positions.current.set(currentKey.current, el.scrollTop);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = document.scrollingElement;
    if (!el) return;

    const action = scrollActionFor({
      navigationType,
      pathname,
      previousPathname: previousPathname.current,
      savedTop: positions.current.get(location.key),
    });
    previousPathname.current = pathname;
    currentKey.current = location.key;
    if (action.kind === 'keep') return;

    const target = action.kind === 'restore' ? action.top : 0;
    let frames = 0;
    let raf = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      if (applyScrollTarget(el, target) === 'done' || frames >= RESTORE_FRAME_BUDGET) return;
      frames += 1;
      raf = requestAnimationFrame(tick);
    };
    tick();

    /**
     * NEVER FIGHT THE VISITOR. Restoration can take several frames while the
     * destination loads, and if they start scrolling in the meantime the retry
     * would yank them back. The first sign of input ends it.
     */
    const stop = () => {
      cancelled = true;
    };
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const type of events) window.addEventListener(type, stop, { once: true, passive: true });

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      for (const type of events) window.removeEventListener(type, stop);
    };
  }, [location.key, pathname, navigationType]);

  // The v2 lobby (US-28) and the v2 persona profile (US-29) own their own
  // top-of-screen chrome and full-bleed media, so on those routes the shell
  // drops its default brand bar and content padding. Every other screen keeps
  // the original shell chrome unchanged.
  const isLobby = pathname === '/characters';
  const isProfile = /^\/characters\/[^/]+$/.test(pathname);
  const isImmersive = isLobby || isProfile;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col bg-zinc-950 text-zinc-100">
      {!isImmersive && (
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur pt-[max(0.75rem,env(safe-area-inset-top))]">
          <Link
            to="/characters"
            aria-label="Over18 — Discover"
            className="text-lg font-semibold tracking-tight text-white transition-opacity hover:opacity-80"
          >
            Over<span className="text-rose-500">18</span>
          </Link>
          {/* The customer's Credits, before and during anything they pay for.
              Renders nothing at all until a balance is known. */}
          <CreditsPill />
        </header>
      )}

      {/* Immediately below the header -- and at the very top on the immersive
          routes, which have no header of their own. Renders nothing outside a
          staging build. */}
      <StagingBanner />

      <main className={`flex flex-1 flex-col overflow-y-auto ${isImmersive ? '' : 'px-4 pb-8 pt-6'}`}>
        <Outlet />
      </main>

      <div className="sticky bottom-0 z-10">
        <MobileNavigation />
      </div>
    </div>
  );
}
