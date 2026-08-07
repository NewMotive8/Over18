import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

/**
 * Mobile-first application shell:
 * - sticky top bar with the app name and session state
 * - scrollable content area
 * - bottom navigation (thumb-friendly on mobile, still usable on desktop)
 */
export default function AppLayout() {
  const { user, status, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/', { replace: true });
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex flex-col items-center gap-0.5 py-2.5 text-xs transition-colors ${
      isActive ? 'text-rose-500' : 'text-zinc-400 hover:text-zinc-200'
    }`;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur">
        <h1 className="text-lg font-semibold tracking-tight">
          Over<span className="text-rose-500">18</span>
        </h1>
        {status === 'authenticated' && user && (
          <span className="max-w-40 truncate text-xs text-zinc-500" title={user.email}>
            {user.email}
          </span>
        )}
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-6">
        <Outlet />
      </main>

      <nav className="sticky bottom-0 z-10 border-t border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <ul className="flex">
          <li className="flex-1">
            <NavLink to="/" end className={navLinkClass}>
              <span aria-hidden className="text-base leading-none">
                ⌂
              </span>
              Home
            </NavLink>
          </li>
          <li className="flex-1">
            <NavLink to="/characters" className={navLinkClass}>
              <span aria-hidden className="text-base leading-none">
                ☺
              </span>
              Characters
            </NavLink>
          </li>
          <li className="flex-1">
            {status === 'authenticated' ? (
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full flex-col items-center gap-0.5 py-2.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
              >
                <span aria-hidden className="text-base leading-none">
                  ←
                </span>
                Logout
              </button>
            ) : (
              <NavLink to="/login" className={navLinkClass}>
                <span aria-hidden className="text-base leading-none">
                  →
                </span>
                Login
              </NavLink>
            )}
          </li>
        </ul>
      </nav>
    </div>
  );
}
