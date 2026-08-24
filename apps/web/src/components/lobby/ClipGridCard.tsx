import { Link } from 'react-router-dom';
import type { PublicClip } from '../../lib/api';
import ClipMedia from './ClipMedia';

/**
 * One search result: a real CMS content asset.
 *
 * WHAT THIS REPLACED. The results grid used to render `PersonaGridCard`, which
 * resolved its media through `resolveHeroMedia` — so a character with nothing
 * published still appeared in results wearing her canonical reference image,
 * and the app presented her identity portrait as though it were content. Search
 * now returns the content itself: this card IS an asset.
 *
 * VIDEO ONLY. Search is a clip surface. The server already returns nothing but
 * videos; this component refuses anything else as well, so the rule holds even
 * if a payload changes. An image content asset is legitimate content elsewhere
 * in the product — it is simply not a search result.
 *
 * MEDIA COMES FROM `ClipMedia` AND NOWHERE ELSE. That is the shared clip
 * renderer the Hero, the category rails and the Posts tab use: a video plays
 * with the same autoplay/muted/loop/playsInline behaviour as every other clip
 * surface, and a clip that fails degrades to a neutral frame. It has NO
 * character-image fallback, which is what makes it impossible for a profile,
 * canonical or manifest image to appear here — there is no code path that
 * reaches one.
 *
 * PRESENTATION IS THE APPROVED GRID CARD: the same 3:4 frame, rounded corners,
 * border, bottom gradient and name treatment `PersonaGridCard` uses, so the
 * grid looks unchanged. What differs is only what fills the frame and what the
 * caption says — the character's name, because the asset belongs to her and
 * tapping still opens her profile.
 *
 * NO FABRICATED BADGE. `PersonaGridCard` carries a NEW/HOT badge derived from
 * the card's index (`index % 4`) — a decoration invented from position, not a
 * fact about the asset. It is deliberately absent here rather than reproduced
 * against a clip that has no such status.
 */
export default function ClipGridCard({ clip }: { clip: PublicClip }) {
  // The second lock. The server filters to video; this makes an image
  // unrenderable here rather than merely unexpected.
  if (clip.mediaType !== 'video') return null;

  return (
    <Link
      to={`/characters/${clip.characterId}`}
      aria-label={`Open ${clip.characterName}`}
      className="group relative block aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
    >
      <ClipMedia clip={clip} autoPlay />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex items-baseline gap-1.5 p-3">
        <span className="truncate text-base font-bold text-white drop-shadow">
          {clip.characterName}
        </span>
      </div>
    </Link>
  );
}
