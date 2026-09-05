/**
 * Primary navigation model (US-18) — platform-independent.
 *
 * No DOM and no React: the set of primary destinations and the "which tab is
 * active for this path" rule are pure data + a pure function, so they are
 * trivially testable and reusable by a future native shell. Presentation
 * (icons, layout) lives in MobileNavigation; product routing rules live here.
 */

export type DestinationKey = 'discover' | 'go-steady' | 'favourites' | 'profile';

export interface NavDestination {
  key: DestinationKey;
  label: string;
  /** The canonical route this destination navigates to. */
  path: string;
  /** Route prefixes that should light up this destination as active. */
  matchPrefixes: string[];
  /** Short description (used for aria / future tooltips). */
  description: string;
}

/**
 * The primary destinations of the application shell, in bar order.
 * Discover reuses the existing lobby route (`/characters`) — no duplicate route.
 *
 * Favourites sits between Get Steady and Profile: it is a browsing destination
 * like the two before it, and it must not displace Profile from the edge of the
 * bar, which is where people reach for it.
 *
 * ORDER IS DECLARATION ORDER. `MobileNavigation` maps this array straight to
 * `<li>`s, so the position of the entry below is the position on screen — there
 * is no second ordering to keep in step.
 */
export const PRIMARY_DESTINATIONS: NavDestination[] = [
  {
    key: 'discover',
    label: 'Discover',
    path: '/characters',
    matchPrefixes: ['/characters'],
    description: 'Browse characters',
  },
  {
    key: 'go-steady',
    label: 'Go Steady',
    path: '/go-steady',
    matchPrefixes: ['/go-steady'],
    description: 'Your closer connections',
  },
  {
    key: 'favourites',
    label: 'Favourites',
    path: '/favourites',
    matchPrefixes: ['/favourites'],
    description: 'Characters you saved',
  },
  {
    key: 'profile',
    label: 'Profile',
    path: '/profile',
    matchPrefixes: ['/profile'],
    description: 'Account and settings',
  },
];

/** True if `pathname` falls under this destination's route subtree. */
export function matchesDestination(pathname: string, dest: NavDestination): boolean {
  return dest.matchPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * The active primary destination for a path, or null when none applies (e.g.
 * `/subscription`, `/chat`, auth screens) — the shell simply shows no tab as
 * active rather than mis-highlighting one.
 */
export function activeDestinationKey(pathname: string): DestinationKey | null {
  const match = PRIMARY_DESTINATIONS.find((dest) => matchesDestination(pathname, dest));
  return match ? match.key : null;
}
