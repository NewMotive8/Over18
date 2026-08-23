import { Link } from 'react-router-dom';
import { BellIcon, ProfileIcon, SparkleIcon } from '../icons';

/**
 * Lobby top navigation (US-28 / v2 brief §1).
 *
 * Brand mark on the left; an action cluster on the right: a notification bell
 * with a numeric badge, a utility/profile action, and a highlighted promo CTA.
 * Sticky and dark with a safe-area top inset.
 *
 * NO SEARCH ICON (US-102.4). It used to sit here and scroll the page down to
 * the Discovery search box. The ticket removes it: Search lives in one place,
 * in the "Over18 AI Companions" section further down, and a header shortcut to
 * it was a second entry point to the same thing. The `onSearch` prop went with
 * it rather than being left dangling.
 */
export default function LobbyTopBar({
  notificationCount = 3,
}: {
  notificationCount?: number;
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-white/5 bg-zinc-950/85 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl">
      <Link to="/characters" aria-label="Over18 — Lobby" className="flex items-center gap-1.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-fuchsia-600 text-white shadow-lg shadow-rose-950/40">
          <SparkleIcon className="h-4 w-4" />
        </span>
        <span className="text-lg font-black italic uppercase tracking-tight text-white">
          Over<span className="text-rose-500">18</span>
        </span>
      </Link>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`Notifications${notificationCount ? `, ${notificationCount} unread` : ''}`}
          className="relative flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          <BellIcon className="h-[18px] w-[18px]" />
          {notificationCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
              {notificationCount > 9 ? '9+' : notificationCount}
            </span>
          )}
        </button>

        <Link
          to="/profile"
          aria-label="Your account"
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          <ProfileIcon className="h-[18px] w-[18px]" />
        </Link>

        <Link
          to="/subscription"
          className="ml-0.5 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-600 px-3 py-1.5 text-xs font-bold text-white shadow-lg shadow-rose-950/30 transition-transform active:scale-95"
        >
          <span className="text-[10px]">🔥</span> -85%
        </Link>
      </div>
    </header>
  );
}
