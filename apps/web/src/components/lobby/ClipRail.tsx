import { Link } from 'react-router-dom';
import type { PublicCategoryRail } from '../../lib/api';
import ClipMedia from './ClipMedia';

/**
 * A published App Category rail (US-102.4).
 *
 * Its contents are the category's approved merchandised clips, in the order an
 * operator arranged in US-102.2 — the app has no say in either. Tapping a clip
 * opens the character it belongs to, which is the only destination this ticket
 * has: there is no per-clip screen and inventing one would be inventing product.
 */
export default function ClipRail({ rail }: { rail: PublicCategoryRail }) {
  if (rail.clips.length === 0) return null;

  return (
    <section aria-label={rail.name} className="flex flex-col gap-3">
      <div className="px-4">
        <h3 className="text-base font-bold text-white">{rail.name}</h3>
        {rail.tagline && <p className="mt-0.5 text-xs text-zinc-400">{rail.tagline}</p>}
      </div>
      <div className="flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {rail.clips.map((clip) => (
          <Link
            key={clip.id}
            to={`/characters/${clip.characterId}`}
            aria-label={`Open ${clip.characterName}`}
            className="relative block aspect-[3/4] w-40 shrink-0 snap-start overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
          >
            <ClipMedia clip={clip} />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-zinc-950 to-transparent" />
            <span className="absolute inset-x-0 bottom-0 block truncate p-2.5 text-sm font-semibold text-white">
              {clip.characterName}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
