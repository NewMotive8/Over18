import { Link } from 'react-router-dom';
import type { PublicClip } from '../../lib/api';
import ClipMedia from './ClipMedia';

/**
 * Feed view for discovery results (US-102.4).
 *
 * A full-screen vertical, snap-paged presentation of the SAME results the grid
 * shows — a different way to look at one result set, not a second product. The
 * ticket is explicit that Feed must not grow into a larger discovery/feed
 * project here, so this is deliberately the minimum that earns the name:
 * snap-scrolling full-height pages, the clip, who it belongs to, and a way out.
 *
 * WHAT IS NOT HERE, ON PURPOSE: infinite paging, preloading, view tracking,
 * autoplay policy, gestures, likes, comments, a recommendation feed. Every one
 * of those is a discovery/feed feature and none is specified in this ticket.
 */
export default function FeedView({
  clips,
  onClose,
}: {
  clips: PublicClip[];
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Feed view"
      className="fixed inset-0 z-50 bg-zinc-950"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close feed view"
        className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-lg text-white backdrop-blur"
      >
        ×
      </button>

      {clips.length === 0 ? (
        <div className="flex h-full items-center justify-center px-8 text-center text-sm text-zinc-400">
          Nothing to show here yet.
        </div>
      ) : (
        <div className="h-full snap-y snap-mandatory overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {clips.map((clip) => (
            <section
              key={clip.id}
              aria-label={clip.characterName}
              className="relative h-full w-full snap-start snap-always"
            >
              <ClipMedia clip={clip} autoPlay className="h-full w-full object-contain" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-zinc-950 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                <Link
                  to={`/characters/${clip.characterId}`}
                  className="inline-flex items-center gap-1 rounded-full bg-white px-4 py-2 text-sm font-bold text-zinc-950"
                >
                  {clip.characterName} <span aria-hidden>→</span>
                </Link>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
