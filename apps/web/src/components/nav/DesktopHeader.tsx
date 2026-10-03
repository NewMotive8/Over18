import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import CreditsPill from '../CreditsPill';
import { DiscoverIcon, GoSteadyIcon, LikeIcon, ProfileIcon, SparkleIcon } from '../icons';
import { PRIMARY_DESTINATIONS, activeDestinationKey, type DestinationKey } from './destinations';

/**
 * The desktop header (`lg`, 1024px and up).
 *
 * On a desktop screen the phone's bottom tab bar is replaced by this: one
 * horizontal bar across the top with the brand, the SAME primary destinations
 * (`PRIMARY_DESTINATIONS`, with the same active rule as `MobileNavigation`, so
 * there is still exactly one list of where the app goes), and the customer's
 * Credits. Below `lg` it is not rendered at all (`hidden lg:block`) and the
 * phone keeps its own header and bottom bar, unchanged.
 *
 * `extras` is the page's own actions where a page has them (Home's search,
 * notifications and offer), so a desktop visitor loses nothing the phone top
 * bar offers.
 */
const ICONS: Record<DestinationKey, (props: { className?: string }) => JSX.Element> = {
  discover: DiscoverIcon,
  'go-steady': GoSteadyIcon,
  favourites: LikeIcon,
  profile: ProfileIcon,
};

export default function DesktopHeader({
  extras,
  showCredits = true,
}: {
  extras?: ReactNode;
  /** False on a screen that already shows the balance itself, so it is never doubled. */
  showCredits?: boolean;
}) {
  const { pathname } = useLocation();
  const active = activeDestinationKey(pathname);

  return (
    <header data-testid="desktop-header" className="sticky top-0 z-30 hidden border-b border-white/5 bg-zinc-950/85 backdrop-blur-xl lg:block">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-8 px-8">
        <Link to="/characters" aria-label="Over18 — Discover" className="flex shrink-0 items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-fuchsia-600 text-white shadow-lg shadow-rose-950/40">
            <SparkleIcon className="h-4 w-4" />
          </span>
          <span className="text-xl font-black italic uppercase tracking-tight text-white">
            Over<span className="text-rose-500">18</span>
          </span>
        </Link>

        <nav aria-label="Primary">
          <ul className="flex items-center gap-1">
            {PRIMARY_DESTINATIONS.map((dest) => {
              const Icon = ICONS[dest.key];
              const isActive = dest.key === active;
              return (
                <li key={dest.key}>
                  <Link
                    to={dest.path}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                      isActive ? 'bg-rose-500/10 text-rose-400' : 'text-zinc-400 hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px]" />
                    {dest.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* The customer's Credits, as on every phone screen. Nothing until known. */}
          {showCredits && <CreditsPill />}
          {extras}
        </div>
      </div>
    </header>
  );
}
