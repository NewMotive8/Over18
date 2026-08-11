import { useRef, useState } from 'react';
import type { CharacterMediaItem } from '../../lib/media';
import HeroMedia from '../HeroMedia';
import { ChevronLeftIcon, CrownIcon, MoreIcon } from '../icons';

/**
 * Persona profile hero media player (US-29 / brief §2).
 *
 * A dominant, near-square media player that loops the character's REAL video
 * clips. Floating Back + More controls, pagination dots that track the clip in
 * view, and an overlaid identity block (circular avatar, name, adult age, and a
 * premium identity badge). Native scroll-snap paging; tapping opens the
 * full-screen viewer. Falls back cleanly to a single image item if a character
 * has no video.
 */
export default function ProfileHero({
  items,
  name,
  age,
  avatarPoster,
  onBack,
  onOpen,
}: {
  items: CharacterMediaItem[];
  name: string;
  age: number;
  avatarPoster?: string;
  onBack: () => void;
  onOpen: (index: number) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== active) setActive(i);
  };

  return (
    <div className="relative overflow-hidden rounded-b-3xl">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(i)}
            aria-label={`View ${name} media ${i + 1}`}
            className="relative aspect-[4/5] w-full shrink-0 snap-center"
          >
            <HeroMedia media={item.media} alt={name} />
          </button>
        ))}
      </div>

      {/* Readability gradients top + bottom */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/60 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent" />

      {/* Floating top controls */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/60"
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="More options"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/60"
        >
          <MoreIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Pagination dots */}
      {items.length > 1 && (
        <div className="absolute left-1/2 top-14 flex -translate-x-1/2 gap-1.5">
          {items.map((item, i) => (
            <span
              key={item.id}
              aria-current={i === active}
              className={`h-1.5 rounded-full transition-all ${i === active ? 'w-5 bg-white' : 'w-1.5 bg-white/40'}`}
            />
          ))}
        </div>
      )}

      {/* Identity block */}
      <div className="absolute inset-x-0 bottom-0 flex items-end gap-3 p-4">
        <span className="h-14 w-14 shrink-0 overflow-hidden rounded-full border-2 border-white/80 bg-zinc-800">
          {avatarPoster ? (
            <img src={avatarPoster} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-xl font-bold text-rose-400">
              {name.charAt(0)}
            </span>
          )}
        </span>
        <div className="min-w-0 pb-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-black tracking-tight text-white drop-shadow">{name}</h1>
            <span className="text-lg font-semibold text-zinc-200">{age}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/90 px-2 py-0.5 text-[10px] font-bold text-amber-950">
              <CrownIcon className="h-3 w-3" /> VIP
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online now
          </p>
        </div>
      </div>
    </div>
  );
}
