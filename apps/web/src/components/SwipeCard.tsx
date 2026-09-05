import type { PublicPlayWithMeCard } from '../lib/api';
import { resolveRailMedia } from '../lib/media';
import { adultAgeFromBand } from '../lib/lobbyContent';
import HeroMedia from './HeroMedia';

/**
 * The swipe deck's card. REAL PUBLISHED CONTENT OR NOTHING.
 *
 * ── WHAT IT REPLACED, AND WHY ────────────────────────────────────────────────
 *
 * This is the successor to `DiscoverCard`, which took a `PublicCharacter` and
 * resolved its media through `resolveHeroMedia` — a chain that walks a demo
 * override map, a never-populated `videoUrl`, a `clip` field the
 * `/api/characters` payload does not carry, the hard-coded local demo manifest,
 * the character's canonical REFERENCE portrait, her legacy `profileImage`, and
 * finally an initial-letter tile. Six of those seven are not published content,
 * and for a CMS character every one of the first four was empty, so the deck
 * reliably landed on her reference portrait or a letter and presented it as her
 * clip.
 *
 * ── WHAT IT DOES INSTEAD ─────────────────────────────────────────────────────
 *
 * `resolveRailMedia`, the same function the Play with me rail uses, whose only
 * source is the server's representative clip and which returns null when there
 * is not one. The card cannot reach a portrait, a profileImage, the manifest or
 * a placeholder, because none of them are in scope here — this is a structural
 * fix, not a hidden branch.
 *
 * NO REQUEST OF ITS OWN. `DiscoverCard` called `useCharacterVisual` per card to
 * read one age band out of an entire visual identity. The band arrives on the
 * card now, from the same composition Home uses, and `adultAgeFromBand` turns
 * it into the label the rail already shows.
 *
 * NO CARD WITHOUT MEDIA. Returning null here is the second lock: the server
 * already drops an ineligible character from this population, so this can only
 * fire if a future payload change tried to put one back.
 *
 * `resolveHeroMedia` is untouched and still serves the Character page, where
 * showing a character's own portrait is correct and intended.
 */
export default function SwipeCard({
  character,
  onOpen,
}: {
  character: PublicPlayWithMeCard;
  onOpen?: () => void;
}) {
  const media = resolveRailMedia(character);
  const age = adultAgeFromBand(character.apparentAgeBand);
  // Real App Category membership, exactly as the rail chips it.
  const tags = character.categories.slice(0, 2);

  if (!media) return null;

  return (
    <article className="relative h-full w-full overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40">
      <HeroMedia media={media} alt={character.displayName} />

      {/* Readability gradient. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-transparent" />

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-5">
        <div className="flex items-end gap-2">
          <h2 className="text-3xl font-bold leading-none tracking-tight text-white drop-shadow">
            {character.displayName}
          </h2>
          <span className="pb-0.5 text-lg font-medium text-zinc-300">{age}</span>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag.slug}
                className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur transition-colors hover:bg-white/20"
          >
            View profile <span aria-hidden>→</span>
          </button>
        )}
      </div>
    </article>
  );
}
