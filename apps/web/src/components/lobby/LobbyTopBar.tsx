import { Link } from 'react-router-dom';
import { SparkleIcon } from '../icons';
import LobbyActions from './LobbyActions';
import CreditsPill from '../CreditsPill';

/**
 * Lobby top navigation (US-28 / v2 brief §1).
 *
 * Brand mark on the left; an action cluster on the right: search, a
 * notification bell with a numeric badge, a utility/profile action, and a
 * highlighted promo CTA. Sticky and dark with a safe-area top inset. Search is
 * a callback so the lobby can scroll to its Discovery search input.
 *
 * THE SEARCH ICON IS PART OF THE DESIGN. It was removed once on the reasoning
 * that Search should live in exactly one place; the header icon is not a second
 * search, it is the shortcut to the one below, and the product's own design
 * has it. Restored, with its `onSearch` callback.
 */
export default function LobbyTopBar({
  notificationCount = 3,
  onSearch,
}: {
  notificationCount?: number;
  onSearch?: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-white/5 bg-zinc-950/85 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl lg:hidden">
      <Link to="/characters" aria-label="Over18 — Lobby" className="flex shrink-0 items-center gap-1.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-fuchsia-600 text-white shadow-lg shadow-rose-950/40">
          <SparkleIcon className="h-4 w-4" />
        </span>
        {/* On a narrow phone the mark alone, so the Credits balance fits beside
            every existing action; the wordmark returns from \`sm\` up. */}
        <span className="hidden text-lg font-black italic uppercase tracking-tight text-white sm:inline">
          Over<span className="text-rose-500">18</span>
        </span>
      </Link>

      <div className="flex items-center gap-1.5">
        {/* The customer's Credits, one tap from the Credits Store. Coin and number
            only on a narrow phone; nothing at all while unknown. */}
        <CreditsPill tight />
        <LobbyActions notificationCount={notificationCount} onSearch={onSearch} />
      </div>
    </header>
  );
}
