import { Link, useLocation } from 'react-router-dom';
import { PRIMARY_DESTINATIONS, activeDestinationKey, type DestinationKey } from './nav/destinations';
import { DiscoverIcon, GoSteadyIcon, LikeIcon, ProfileIcon } from './icons';

/**
 * Persistent, mobile-first primary navigation (US-18).
 *
 * Renders the primary destinations with clear active state. Active
 * detection uses the platform-independent `activeDestinationKey` so the rule is
 * shared with tests (and a future native shell) rather than duplicated in the
 * component. Thumb-friendly targets; still usable on desktop.
 */
const ICONS: Record<DestinationKey, (props: { className?: string }) => JSX.Element> = {
  discover: DiscoverIcon,
  'go-steady': GoSteadyIcon,
  // The filled heart — the same mark the swipe deck's favourite action uses, so
  // the tab and the action a user just took are visibly the same thing.
  favourites: LikeIcon,
  profile: ProfileIcon,
};

export default function MobileNavigation() {
  const { pathname } = useLocation();
  const active = activeDestinationKey(pathname);

  return (
    <nav
      aria-label="Primary"
      className="border-t border-zinc-800 bg-zinc-950/90 backdrop-blur pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex">
        {PRIMARY_DESTINATIONS.map((dest) => {
          const Icon = ICONS[dest.key];
          const isActive = dest.key === active;
          return (
            <li key={dest.key} className="flex-1">
              <Link
                to={dest.path}
                aria-label={dest.label}
                aria-current={isActive ? 'page' : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors ${
                  isActive ? 'text-rose-500' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon />
                {dest.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
