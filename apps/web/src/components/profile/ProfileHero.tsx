import { useRef, useState, type ReactNode } from 'react';
import type { CharacterMediaItem } from '../../lib/media';
import HeroMedia from '../HeroMedia';
import { ChevronLeftIcon, CrownIcon } from '../icons';

/**
 * Persona profile hero media player (US-29 / brief §2).
 *
 * A dominant, near-square media player that loops the character's REAL video
 * clips. A floating Back control, pagination dots that track the clip in view,
 * and an overlaid identity block (circular avatar, name, adult age, and a
 * premium identity badge). Native scroll-snap paging; tapping opens the
 * full-screen viewer. Falls back cleanly to a single image item if a character
 * has no video.
 *
 * THERE IS NO "MORE" BUTTON. One was drawn here with the rest of the US-29
 * design and never given anything to do: no handler, no menu, nothing in the
 * codebase referring to it. It sat in the tab order announcing "More options"
 * to a screen reader and then doing nothing, which reads as broken rather than
 * unfinished. If a menu is built later -- Report, Block, Share are the obvious
 * candidates -- the control comes back WITH it.
 */
export default function ProfileHero({
  items,
  name,
  age,
  avatarPoster,
  onBack,
  onOpen,
  topRight,
}: {
  items: CharacterMediaItem[];
  name: string;
  age: number;
  avatarPoster?: string;
  onBack: () => void;
  onOpen: (index: number) => void;
  /** Opposite Back -- the page puts the customer's Credits here. */
  topRight?: ReactNode;
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
            /**
             * `bg-zinc-900` IS THE LETTERBOX, not decoration. A contained video
             * does not fill this 4/5 box, and the slide had no background of its
             * own -- so without this the bars would show whatever happened to be
             * behind the carousel. Same background Admin's tile and
             * LockedContentCard use, so the three surfaces letterbox alike. It
             * is inert for an image: a covered image fills the box and this is
             * never visible.
             */
            className="relative aspect-[4/5] w-full shrink-0 snap-center bg-zinc-900"
          >
            {/*
              HER CLIPS ARE PORTRAIT AND THIS FRAME IS NOT.
              Measured in production (see HeroMedia's FOCAL_CLASS note): 9:16,
              640x1152, 544x960, 768x1168 -- every one narrower than 4/5 = 0.8.
              Filling this frame's width therefore threw away about 30% of a
              9:16 clip's height, and `center` split that evenly, so ~15% came
              off the top. That is where a head is, and heads were being cut.

              `contain` fits the whole clip inside the frame instead, so nothing
              is cropped; the cost is a dark bar down each side, which is the
              trade the 4/5 frame requires and which the background above
              provides.

              IMAGES AND PLACEHOLDERS KEEP `cover` -- stated rather than left to
              the default, so the difference between the two is visible here
              rather than inferred from HeroMedia.
            */}
            <HeroMedia
              media={item.media}
              alt={name}
              fit={item.media.kind === 'video' ? 'contain' : 'cover'}
            />
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
        {topRight && <span className="rounded-xl bg-black/40 backdrop-blur">{topRight}</span>}
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
