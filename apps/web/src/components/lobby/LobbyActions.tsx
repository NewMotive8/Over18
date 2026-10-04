import { Link } from 'react-router-dom';
import { BellIcon, ProfileIcon, SearchIcon } from '../icons';

/**
 * Home's own header actions: search, notifications, account and the offer.
 *
 * ONE COPY, TWO HEADERS. The phone's `LobbyTopBar` and the desktop header
 * (`DesktopHeader`) both render these, so the two can never drift apart. The
 * desktop header already has a Profile tab, so it leaves out the account icon
 * (`withAccount={false}`); everything else is identical.
 */
export default function LobbyActions({
  notificationCount = 3,
  onSearch,
  withAccount = true,
}: {
  notificationCount?: number;
  onSearch?: () => void;
  withAccount?: boolean;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search"
        className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
      >
        <SearchIcon className="h-[18px] w-[18px]" />
      </button>

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

      {withAccount && (
        <Link
          to="/profile"
          aria-label="Your account"
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          <ProfileIcon className="h-[18px] w-[18px]" />
        </Link>
      )}

      <Link
        to="/subscription"
        className="ml-0.5 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-600 px-3 py-1.5 text-xs font-bold text-white shadow-lg shadow-rose-950/30 transition-transform active:scale-95"
      >
        <span className="text-[10px]">🔥</span> Upgrade
      </Link>
    </>
  );
}

/** Home's search, from anywhere on the page: the one search input, centred and focused. */
export const LOBBY_SEARCH_ID = 'lobby-search';
export function focusLobbySearch(): void {
  const input = globalThis.document?.getElementById(LOBBY_SEARCH_ID);
  input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  input?.focus();
}
