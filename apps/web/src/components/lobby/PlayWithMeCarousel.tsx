import { Link } from 'react-router-dom';
import type { PublicCharacterCard } from '../../lib/api';
import { apparentAge, resolveHeroMedia } from '../../lib/media';
import { adultAgeFromBand } from '../../lib/lobbyContent';
import { useCharacterVisual } from '../../hooks/useCharacterVisual';
import HeroMedia from '../HeroMedia';

/** A single portrait, video-first persona card for the horizontal rail. */
function PlayWithMeCard({ character }: { character: PublicCharacterCard }) {
  const { visual } = useCharacterVisual(character.id);
  const media = resolveHeroMedia(character, visual);
  const age = adultAgeFromBand(apparentAge(visual));
  // Real App Category membership, where the old version invented tags from the
  // card's index. Same chips, same place — sourced from the CMS instead.
  const tags = character.categories.slice(0, 2);

  return (
    <Link
      to={`/characters/${character.id}`}
      aria-label={`Open ${character.displayName}, ${age}`}
      className="group relative block aspect-[3/4] w-40 shrink-0 snap-start overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
    >
      <HeroMedia media={media} alt={character.displayName} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950 via-zinc-950/50 to-transparent" />
      <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 backdrop-blur">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online
      </span>
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-bold text-white">{character.displayName}</span>
          <span className="text-xs text-zinc-300">{age}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag.slug}
              className="rounded-full bg-white/15 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur"
            >
              {tag.name}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}

/**
 * "Play with me" horizontal carousel (US-28 / v2 brief §1).
 *
 * A media-first rail of portrait persona cards with dark bottom gradients,
 * attribute chips and name/age. Native horizontal scroll-snap for smooth
 * swiping; full-bleed so cards run to the screen edge.
 *
 * The original presentation, restored. Its CONTENT is now the CMS's
 * `home.playWithMe` — the active characters the server composed — rather than
 * whatever `/api/characters` happened to return first.
 */
export default function PlayWithMeCarousel({
  characters,
}: {
  characters: PublicCharacterCard[];
}) {
  if (characters.length === 0) return null;
  return (
    <section aria-label="Play with me" className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-4">
        <h3 className="text-base font-bold text-white">Play with me</h3>
        <Link to="/discover/swipe" className="text-xs font-semibold text-rose-400 hover:text-rose-300">
          Swipe mode →
        </Link>
      </div>
      <div className="flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {characters.map((character) => (
          <PlayWithMeCard key={character.id} character={character} />
        ))}
      </div>
    </section>
  );
}
