import type { PublicClip } from '../../lib/api';
import ClipMedia from '../lobby/ClipMedia';
import { LikeIcon } from '../icons';

/**
 * Posts tab — the character's real content collection.
 *
 * WHAT THIS REPLACED, and why none of it could stay. The tab used to read a
 * hard-coded four-name manifest (`characterVideos`), take two entries off it,
 * fabricate six more "locked" tiles by cycling whatever poster it could find,
 * and fall back to `character.profileImage` when the manifest had no entry —
 * which is every character created through the CMS. It rendered poster JPEGs,
 * never the clips. Not one tile corresponded to a record, and the tab claimed
 * "8" because 2 + 6 = 8.
 *
 * NOW IT IS THE COLLECTION. Every tile is a `character_visual_assets` row the
 * server has already confirmed publicly reachable, in full and unsliced. The
 * count is whatever she actually has.
 *
 * MEDIA COMES FROM `ClipMedia`, never a poster and never a fallback. That is
 * the shared clip renderer used by the Hero and the category rails: a video
 * plays with the same autoplay/muted/loop/playsInline behaviour as every other
 * clip surface, an image CONTENT asset renders as an image, and a clip that
 * fails degrades to a neutral frame. It has NO character-image fallback, which
 * is what makes it impossible for a profile or reference image to reappear
 * here.
 *
 * PRESENTATION IS THE APPROVED ONE: same two-column grid, same tile frame, same
 * gradient, same bottom-left heart mark in the same position and styling.
 *
 * THE HEART CARRIES NO NUMBER, and must never carry one again. The approved
 * tile printed `240 + index * 57` beside it — tile 1 said 240, tile 2 said 297,
 * tile 3 said 354. That was the tile's position dressed up as engagement; there
 * is no likes column, no reactions table, and no engagement source anywhere in
 * the schema. The mark itself is approved presentation and stays; the invented
 * count does not come back unless a real one exists to print.
 */
export default function PostsTab({
  clips,
  onOpenClip,
}: {
  clips: PublicClip[];
  onOpenClip: (index: number) => void;
}) {
  if (clips.length === 0) {
    // Said plainly rather than filled with invented tiles. An empty collection
    // is a real state, and pretending otherwise is what this tab used to do.
    return <p className="py-10 text-center text-sm text-zinc-500">No posts yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        {clips.map((clip, index) => (
          <button
            key={clip.id}
            type="button"
            onClick={() => onOpenClip(index)}
            className="group relative block aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
          >
            <ClipMedia clip={clip} autoPlay />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent" />
            {/* Approved mark, unchanged position and styling. Decorative: it
                states nothing, so it is hidden from assistive technology. */}
            <span
              aria-hidden
              className="absolute bottom-2 left-2 flex items-center gap-1 text-[11px] font-semibold text-white"
            >
              <LikeIcon className="h-3.5 w-3.5 text-rose-400" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
