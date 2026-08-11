import { Link, Outlet, useLocation } from 'react-router-dom';
import MobileNavigation from './MobileNavigation';

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
export default function AppShell() {
  const { pathname } = useLocation();
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
        </header>
      )}

      <main className={`flex flex-1 flex-col overflow-y-auto ${isImmersive ? '' : 'px-4 pb-8 pt-6'}`}>
        <Outlet />
      </main>

      <div className="sticky bottom-0 z-10">
        <MobileNavigation />
      </div>
    </div>
  );
}
