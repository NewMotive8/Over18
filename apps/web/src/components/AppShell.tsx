import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import AgeGate from './AgeGate';
import CreditsPill from './CreditsPill';
import MobileNavigation from './MobileNavigation';
import SiteFooter from './SiteFooter';
import StagingBanner from './StagingBanner';
import { initialStatus, writeConfirmation, type GateStatus } from '../lib/ageGate';
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
   * The age gate's answer for this browser.
   *
   * READ ONCE, LAZILY, AND NOT IN AN EFFECT. A `useState(() => ...)` initialiser
   * runs during the first render, so the very first paint is already the gate
   * for an unconfirmed visitor. Reading it in an effect instead would render
   * the application first and replace it a tick later -- which is a flash of
   * exactly the content the gate exists to withhold.
   */
  const [gate, setGate] = useState<GateStatus>(() => initialStatus());

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

  /**
   * BEFORE THE OUTLET, AND AFTER EVERY HOOK.
   *
   * After the hooks because their order may not change between renders; before
   * the outlet because this is what makes the gate a barrier rather than a
   * curtain. Returning here means no page component is constructed, no effect
   * of theirs runs, and no request for a character or a clip is ever sent --
   * so there is nothing explicit in the document to be found behind the gate,
   * by a reader, a screen reader, or View Source.
   *
   * It gates the whole consumer shell rather than a list of adult routes. A
   * list is a thing to forget to add to; the shell is every route there is.
   * `/admin` sits outside this shell and is staff-authenticated separately.
   *
   * NO NAVIGATION, SO NO LOOP. The gate is a different render of the same
   * route, not a redirect to a gate page -- nothing to bounce against
   * `RequireAuth`, and the address a visitor arrived at is still the address
   * they are on when they confirm.
   */
  if (gate !== 'confirmed') {
    return (
      <AgeGate
        status={gate}
        onConfirm={() => {
          writeConfirmation();
          setGate('confirmed');
        }}
        onDecline={() => setGate('declined')}
        onBack={() => setGate('asking')}
      />
    );
  }

  // The v2 lobby (US-28) and the v2 persona profile (US-29) own their own
  // top-of-screen chrome and full-bleed media, so on those routes the shell
  // drops its default brand bar and content padding. Every other screen keeps
  // the original shell chrome unchanged.
  const isLobby = pathname === '/characters';
  const isProfile = /^\/characters\/[^/]+$/.test(pathname);
  const isImmersive = isLobby || isProfile;
  // The Credits Store alone is laid out in two columns on a wide screen (hero
  // left, store right); every other screen keeps the phone-width column.
  const isWide = pathname === '/credits' || pathname === '/wallet';

  return (
    <div className={`mx-auto flex min-h-dvh w-full flex-col bg-zinc-950 text-zinc-100 ${isWide ? 'max-w-lg lg:max-w-6xl' : 'max-w-lg'}`}>
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
        {/* Inside the scroll region and after the outlet, so it sits at the end
            of the content rather than competing with the sticky primary nav
            below it. */}
        <SiteFooter />
      </main>

      <div className="sticky bottom-0 z-10">
        <MobileNavigation />
      </div>
    </div>
  );
}
