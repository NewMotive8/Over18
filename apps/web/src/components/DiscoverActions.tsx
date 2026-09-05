import { HeartOutlineIcon, LikeIcon, OpenProfileIcon, PassIcon } from './icons';

/**
 * Swipe action bar: pass, open profile, favourite.
 *
 * ── THE HEART IS STATE, NOT A GESTURE BUTTON ─────────────────────────────────
 *
 * This control used to be "Like", a second way to fire a right swipe: it flung
 * the card away and advanced the deck. It is now the FAVOURITE control, and it
 * reports the persisted relationship:
 *
 *   not favourited → green outline, no fill
 *   favourited     → solid green
 *
 * Tapping it toggles that relationship and DOES NOT ADVANCE. Tapping the full
 * heart is the one documented way to drop a favourite from Swipe, which a
 * button that also flung the card could not offer — the card would be gone
 * before the user saw the fill change.
 *
 * Moving on is still the swipe's job: drag, arrow keys, or the pass button.
 * A right swipe saves and advances; the heart saves, or unsaves, in place.
 *
 * ── THE FILL IS NOT AN ANIMATION ─────────────────────────────────────────────
 *
 * `favourited` comes from what the server holds, so the fill is a readout of
 * the database rather than tap feedback. Reopening the page, signing in on
 * another device, or arriving from Favourites all show the same heart, because
 * they are all reading the same row.
 *
 * `aria-pressed` carries the same fact to assistive technology, so the state is
 * not conveyed by colour alone.
 */
export default function DiscoverActions({
  onPass,
  onOpen,
  onToggleFavourite,
  favourited,
  disabled = false,
  favouriteDisabled = false,
}: {
  onPass: () => void;
  onOpen: () => void;
  onToggleFavourite: () => void;
  /** The PERSISTED favourite state of the character on screen. */
  favourited: boolean;
  disabled?: boolean;
  /**
   * The heart alone is unavailable — a signed-out visitor can browse the deck
   * but has no account to save into. Passing and opening a profile still work,
   * so this is separate from `disabled`.
   */
  favouriteDisabled?: boolean;
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
        onClick={onToggleFavourite}
        disabled={disabled || favouriteDisabled}
        aria-pressed={favourited}
        aria-label={favourited ? 'Remove from Favourites' : 'Add to Favourites'}
        data-testid="favourite-heart"
        data-favourited={favourited ? 'true' : 'false'}
        className={`${round} h-14 w-14 ${
          favourited
            ? 'border-emerald-400 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
            : 'border-emerald-500/40 bg-transparent text-emerald-400 hover:border-emerald-400 hover:bg-emerald-500/10'
        }`}
      >
        {/* Solid when saved, stroked when not — the same heart either way. */}
        {favourited ? (
          <LikeIcon width={26} height={26} />
        ) : (
          <HeartOutlineIcon width={26} height={26} />
        )}
      </button>
    </div>
  );
}
