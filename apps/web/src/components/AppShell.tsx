import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import AgeGate from './AgeGate';
import CreditsPill from './CreditsPill';
import MobileNavigation from './MobileNavigation';
import DesktopHeader from './nav/DesktopHeader';
import LobbyActions, { focusLobbySearch } from './lobby/LobbyActions';
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
  // left, store right).
  const isWide = pathname === '/credits' || pathname === '/wallet';
  const hideNavOnPhone = pathname === '/credits';

  /**
   * HOW WIDE EACH SCREEN MAY BE ON A DESKTOP (`lg`, 1024px and up).
   *
   * Below `lg` every screen is the phone column it has always been
   * (`max-w-lg`) -- nothing about a phone or tablet changes. From `lg` a screen
   * gets the width its own desktop layout was designed for, and a screen that
   * has no desktop layout yet KEEPS the phone column, centred under the desktop
   * header, rather than being stretched into something nobody designed:
   *
   *   Home (desktop Pass 1)              -> the 1280px desktop container
   *   Character profile (desktop Pass 2) -> a 1152px two-column layout
   *   Credits Store                      -> its two-column 1152px layout, as before
   *   everything else                    -> the phone column, unchanged
   *
   * `lg:overflow-visible` ON THE PROFILE. `<main>` is `overflow-y-auto`, which
   * makes it the reference box for `position: sticky` even though it never
   * scrolls (the document does). The profile's media column is sticky, so on
   * that route, on a desktop, `<main>` stops clipping and the column follows the
   * real page scroll. Nothing else about `<main>` changes, and no other route
   * or width is affected.
   */
  const frame = isLobby
    ? 'max-w-lg lg:max-w-7xl lg:px-8'
    : isProfile
      ? 'max-w-lg lg:max-w-6xl lg:overflow-visible lg:px-8'
      : isWide
        ? 'max-w-lg lg:max-w-6xl'
        : 'max-w-lg';

  /**
   * ONE CREDITS BALANCE ON A DESKTOP SCREEN, NEVER TWO.
   *
   * The desktop header shows the balance on every route -- except a screen
   * that still carries its own on a desktop: the chat, in its chat header
   * (not redesigned yet). There the header leaves its pill out.
   *
   * The character profile used to be the other exception. Its desktop layout
   * (Pass 2) now hides the hero's own pill from `lg` instead, so on a desktop
   * its balance is in the header like Home's; on a phone it is in the hero as
   * it always was. Either way: once.
   */
  const pageShowsCredits = pathname.startsWith('/chat/');

  /**
   * THE CHAT IS A FIXED SCREEN; EVERY OTHER ROUTE IS A PAGE.
   *
   * Elsewhere the shell is `min-h-dvh` and the DOCUMENT scrolls. For a
   * conversation that was wrong twice over: keeping the newest message in view
   * meant scrolling the whole document to its end -- past the chat, to the site
   * footer -- so the chat opened with her header scrolled off the top and the
   * visitor part-way down a page.
   *
   * On the chat route the shell is exactly the viewport (`h-dvh`, which is the
   * viewport the on-screen keyboard leaves) and does not scroll. `<main>` gives
   * the chat all the room between the header and the navigation, and the
   * message list inside it is the only thing that scrolls: her header stays at
   * the top, the composer at the bottom. The footer is left out there -- a
   * screen that does not scroll has no end to put it at; it is one tap away on
   * every other screen.
   */
  const isChat = pathname.startsWith('/chat/');

  return (
    <div className={`flex w-full flex-col bg-zinc-950 text-zinc-100 ${isChat ? 'h-dvh overflow-hidden' : 'min-h-dvh'}`}>
      {/* Desktop only: the header with the primary navigation, which replaces
          the phone's bottom tab bar from `lg` up. Home adds its own actions. */}
      <DesktopHeader
        showCredits={!pageShowsCredits}
        extras={isLobby ? <LobbyActions onSearch={focusLobbySearch} withAccount={false} /> : undefined}
      />

      {!isImmersive && (
        <header className="sticky top-0 z-10 mx-auto flex w-full max-w-lg items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur pt-[max(0.75rem,env(safe-area-inset-top))] lg:hidden">
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
          staging build. Full width on a desktop, like the header above it. */}
      <div className="mx-auto w-full max-w-lg lg:max-w-none">
        <StagingBanner />
      </div>

      <main
        className={
          isChat
            ? `mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden ${frame} px-4 pb-3 pt-4`
            : `mx-auto flex w-full flex-1 flex-col overflow-y-auto ${frame} ${isImmersive ? '' : 'px-4 pb-8 pt-6'}`
        }
      >
        <Outlet />
        {/* Inside the scroll region and after the outlet, so it sits at the end
            of the content rather than competing with the sticky primary nav
            below it. */}
        {!isChat && <SiteFooter />}
      </main>

      {/* The phone's primary navigation. The Credits Store is a checkout: on a
          phone its own sticky purchase bar takes the bottom of the screen, so
          the app navigation steps aside there. From `lg` up the desktop
          header above carries the navigation instead, on every screen. */}
      <div className={`sticky bottom-0 z-10 mx-auto w-full max-w-lg lg:hidden ${hideNavOnPhone ? 'hidden' : ''}`}>
        <MobileNavigation />
      </div>
    </div>
  );
}
