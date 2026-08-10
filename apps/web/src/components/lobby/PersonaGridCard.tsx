import { Link } from 'react-router-dom';
import type { PublicCharacter } from '@over18/shared';
import { apparentAge, resolveHeroMedia } from '../../lib/media';
import { adultAgeFromBand, personaBadge } from '../../lib/lobbyContent';
import { useCharacterVisual } from '../../hooks/useCharacterVisual';
import HeroMedia from '../HeroMedia';

/**
 * Discovery-grid persona card (US-28 / v2 brief §1).
 *
 * Full-bleed portrait media, a dark bottom gradient, name + a clearly-adult
 * age, and a floating NEW/HOT badge. Tapping opens the existing profile route.
 * Media resolves through the shared provider-agnostic abstraction.
 */
export default function PersonaGridCard({
  character,
  index,
}: {
  character: PublicCharacter;
  index: number;
}) {
  const { visual } = useCharacterVisual(character.id);
  const media = resolveHeroMedia(character, visual);
  const age = adultAgeFromBand(apparentAge(visual));
  const badge = personaBadge(index);

  return (
    <Link
      to={`/characters/${character.id}`}
      aria-label={`Open ${character.displayName}, ${age}`}
      className="group relative block aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
    >
      <HeroMedia media={media} alt={character.displayName} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent" />

      {badge && (
        <span
          className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${
            badge === 'HOT' ? 'bg-rose-500 text-white' : 'bg-emerald-400 text-emerald-950'
          }`}
        >
          {badge === 'HOT' ? '🔥 Hot' : 'New'}
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-baseline gap-1.5 p-3">
        <span className="truncate text-base font-bold text-white drop-shadow">{character.displayName}</span>
        <span className="text-sm font-medium text-zinc-200">{age}</span>
      </div>
    </Link>
  );
}
