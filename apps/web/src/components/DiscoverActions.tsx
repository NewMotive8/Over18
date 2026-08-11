import { LikeIcon, OpenProfileIcon, PassIcon } from './icons';

/**
 * Discovery action bar (US-19).
 *
 * The desktop-equivalent (and thumb-reachable on mobile) controls for the swipe
 * gestures: pass, open profile, like. Kept in sync with the deck so clicking a
 * button plays the same animated result as a swipe. Disabled while a decision
 * is animating or when the deck is empty.
 */
export default function DiscoverActions({
  onPass,
  onOpen,
  onLike,
  disabled = false,
}: {
  onPass: () => void;
  onOpen: () => void;
  onLike: () => void;
  disabled?: boolean;
}) {
  const round =
    'flex items-center justify-center rounded-full border transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="flex items-center justify-center gap-6">
      <button
        type="button"
        onClick={onPass}
        disabled={disabled}
        aria-label="Pass"
        className={`${round} h-14 w-14 border-zinc-700 bg-zinc-900 text-rose-500 hover:border-rose-500/60 hover:text-rose-400`}
      >
        <PassIcon width={26} height={26} />
      </button>

      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        aria-label="Open profile"
        className={`${round} h-11 w-11 border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:text-white`}
      >
        <OpenProfileIcon width={22} height={22} />
      </button>

      <button
        type="button"
        onClick={onLike}
        disabled={disabled}
        aria-label="Like"
        className={`${round} h-14 w-14 border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:border-emerald-400 hover:bg-emerald-500/20`}
      >
        <LikeIcon width={26} height={26} />
      </button>
    </div>
  );
}
