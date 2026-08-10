import type { PublicCharacter } from '@over18/shared';
import { apparentAge, resolveHeroMedia } from '../lib/media';
import { useCharacterVisual } from '../hooks/useCharacterVisual';
import HeroMedia from './HeroMedia';

/**
 * The dominant Swipye-style discovery card (US-19).
 *
 * Media is the hero: it fills the card, with a bottom gradient so the identity
 * text stays readable over any image or video. Metadata is deliberately sparse —
 * name, apparent age (only when the data provides one), and a short tagline —
 * so the card reads as entertainment-first, not a data table.
 *
 * The card resolves its own media/age from the character's visual identity
 * (cached), mirroring the US-16B.1 CharacterCard pattern so discovery and the
 * profile page stay visually consistent.
 *
 * `online` and `premium` are optional and OFF by default: the current data
 * model exposes neither, so the badges only appear if a caller supplies them
 * (a future API field). This keeps the visual affordance ready without
 * inventing state.
 */
export default function DiscoverCard({
  character,
  onOpen,
  online,
  premium,
}: {
  character: PublicCharacter;
  onOpen?: () => void;
  online?: boolean;
  premium?: boolean;
}) {
  const { visual } = useCharacterVisual(character.id);
  const media = resolveHeroMedia(character, visual);
  const age = apparentAge(visual);

  return (
    <article className="relative h-full w-full overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40">
      <HeroMedia media={media} alt={character.displayName} />

      {/* Top badges (only render when the data supports them). */}
      {(online || premium) && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-3">
          {online ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-950/70 px-2.5 py-1 text-[11px] font-medium text-emerald-300 backdrop-blur">
              <span className="h-2 w-2 rounded-full bg-emerald-400" /> Online
            </span>
          ) : (
            <span />
          )}
          {premium && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/90 px-2.5 py-1 text-[11px] font-semibold text-amber-950">
              Premium
            </span>
          )}
        </div>
      )}

      {/* Readability gradient. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-transparent" />

      {/* Identity + tagline. */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-5">
        <div className="flex items-end gap-2">
          <h2 className="text-3xl font-bold leading-none tracking-tight text-white drop-shadow">
            {character.displayName}
          </h2>
          {age && <span className="pb-0.5 text-lg font-medium text-zinc-300">{age}</span>}
        </div>
        <p className="line-clamp-2 max-w-md text-sm leading-snug text-zinc-200/90">
          {character.shortBio}
        </p>
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
