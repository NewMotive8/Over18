import type { CharacterMediaItem } from '../lib/media';
import HeroMedia from './HeroMedia';

/**
 * Character profile media gallery (US-19).
 *
 * A polished grid of the character's media. Free tiles open the full-screen
 * viewer; premium tiles render blurred behind a lock and open the Premium gate.
 * Presentation only — it decides nothing about entitlements; the caller supplies
 * the already-resolved `items` (from `characterMediaList`) and the handlers.
 */
export default function MediaGallery({
  items,
  onOpenFree,
  onLocked,
}: {
  items: CharacterMediaItem[];
  /** `freeIndex` is the item's position within the free-only subset (viewer order). */
  onOpenFree: (freeIndex: number) => void;
  onLocked: () => void;
}) {
  let freeIndex = -1;
  const premiumCount = items.filter((i) => i.premium).length;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Media</h3>
        {premiumCount > 0 && (
          <span className="rounded-full border border-amber-900/60 bg-amber-950/40 px-2 py-0.5 text-[10px] font-medium text-amber-300/80">
            {premiumCount} premium
          </span>
        )}
      </div>

      <ul className="mt-3 grid grid-cols-3 gap-2">
        {items.map((item) => {
          if (!item.premium) freeIndex += 1;
          const thisFreeIndex = freeIndex;
          const locked = item.premium;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => (locked ? onLocked() : onOpenFree(thisFreeIndex))}
                aria-label={locked ? 'Premium media — unlock with Premium' : 'View media'}
                className="group relative block aspect-[4/5] w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
              >
                <div className={locked ? 'h-full w-full blur-md' : 'h-full w-full transition-transform group-hover:scale-105'}>
                  <HeroMedia media={item.media} alt={locked ? 'Premium media' : 'Media'} />
                </div>
                {locked && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-zinc-950/40 text-zinc-100">
                    <span aria-hidden className="text-lg">🔒</span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide">Premium</span>
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-[11px] leading-snug text-zinc-500">
        Media is placeholder for the preview. Premium items are gated to demonstrate the flow — no
        payments are enabled and no adult media is generated.
      </p>
    </div>
  );
}
