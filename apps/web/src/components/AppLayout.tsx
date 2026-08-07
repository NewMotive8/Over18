import { NavLink, Outlet } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'Home', icon: '⌂' },
  { to: '/characters', label: 'Characters', icon: '☺' },
  { to: '/login', label: 'Login', icon: '→' },
];

/**
 * Mobile-first application shell:
 * - sticky top bar with the app name
 * - scrollable content area
 * - bottom navigation (thumb-friendly on mobile, still usable on desktop)
 */
export default function AppLayout() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur">
        <h1 className="text-lg font-semibold tracking-tight">
          Over<span className="text-rose-500">18</span>
        </h1>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-6">
        <Outlet />
      </main>

      <nav className="sticky bottom-0 z-10 border-t border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <ul className="flex">
          {navItems.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-0.5 py-2.5 text-xs transition-colors ${
                    isActive ? 'text-rose-500' : 'text-zinc-400 hover:text-zinc-200'
                  }`
                }
              >
                <span aria-hidden className="text-base leading-none">
                  {item.icon}
                </span>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
