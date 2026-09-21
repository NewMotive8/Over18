import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import StagingBanner from '../components/StagingBanner';
import type { AdminAccessView } from '@over18/shared';
import { activeAdminDestination, visibleAdminDestinations } from './adminNav';
import { useAuth } from '../auth/AuthContext';
import { adminAccessApi } from '../lib/api';

/**
 * Persistent admin shell (US-99).
 *
 * ONE operator product: every Epic 11 workflow renders inside this frame. It is
 * a sibling of the consumer AppShell, not a replacement and not a second SPA —
 * same Tailwind conventions, but a desktop-width two-column layout because
 * operator work is desktop work, whereas AppShell is deliberately max-w-lg.
 *
 * The shell owns only chrome: brand, navigation, current-location state, a way
 * back to the live app, and a content outlet. It contains no product logic, so
 * US-106 onward can plug pages in without touching it.
 */
export default function AdminShell() {
  const { pathname } = useLocation();
  const active = activeAdminDestination(pathname);
  const { user } = useAuth();

  /**
   * What this operator may see. Fetched once per shell mount. Until it
   * arrives, and if it fails, the navigation is the six ungated areas it has
   * always been -- a failure here must never cost an operator a section.
   */
  const [access, setAccess] = useState<AdminAccessView | null>(null);
  useEffect(() => {
    let cancelled = false;
    adminAccessApi
      .me()
      .then((view) => {
        if (!cancelled) setAccess(view);
      })
      .catch(() => {
        if (!cancelled) setAccess(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const destinations = visibleAdminDestinations(access);

  return (
    <div className="flex min-h-dvh w-full bg-zinc-950 text-zinc-100">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 md:flex">
        <div className="border-b border-zinc-800 px-5 py-4">
          <Link to="/admin" className="text-lg font-semibold tracking-tight text-white">
            Over<span className="text-rose-500">18</span>
            <span className="ml-2 align-middle text-xs font-medium uppercase tracking-wider text-zinc-500">
              Admin
            </span>
          </Link>
        </div>

        <nav aria-label="Admin sections" className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-1">
            {destinations.map((dest) => {
              const isActive = dest.key === active;
              return (
                <li key={dest.key}>
                  <NavLink
                    to={dest.path}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-zinc-900 text-white'
                        : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                    }`}
                  >
                    <span>{dest.label}</span>
                    {dest.status === 'not-implemented' && (
                      <span className="ml-2 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                        Soon
                      </span>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-zinc-800 px-5 py-4 text-xs text-zinc-500">
          {user?.email && <p className="truncate">{user.email}</p>}
          <Link to="/characters" className="mt-2 inline-block text-rose-500 hover:text-rose-400">
            ← Back to the app
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Narrow viewports get the same destinations as a horizontal strip, so
            the admin stays usable without a second navigation model. */}
        <nav
          aria-label="Admin sections"
          className="flex gap-1 overflow-x-auto border-b border-zinc-800 px-3 py-2 md:hidden"
        >
          {destinations.map((dest) => (
            <NavLink
              key={dest.key}
              to={dest.path}
              aria-current={dest.key === active ? 'page' : undefined}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${
                dest.key === active ? 'bg-zinc-900 text-white' : 'text-zinc-400'
              }`}
            >
              {dest.label}
            </NavLink>
          ))}
        </nav>

        {/* Below the admin navigation, on every admin screen. Renders nothing
            outside a staging build. */}
        <StagingBanner />

        <main className="flex-1 overflow-y-auto px-6 py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
