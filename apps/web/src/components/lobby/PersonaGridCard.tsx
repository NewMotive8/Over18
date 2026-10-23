import { Link } from 'react-router-dom';
import type { PublicCharacterCard } from '../../lib/api';
import { resolveHeroMedia } from '../../lib/media';
import { personaBadge } from '../../lib/lobbyContent';
import { useCharacterVisual } from '../../hooks/useCharacterVisual';
import HeroMedia from '../HeroMedia';

/**
 * Discovery-grid persona card (US-28 / v2 brief §1).
 *
 * Full-bleed portrait media, a dark bottom gradient, name + a clearly-adult
 * age, and a floating NEW/HOT badge. Tapping opens the existing profile route.
 * Media resolves through the shared provider-agnostic abstraction.
 *
 * PRESENTATION IS FROZEN. This is the approved card, byte-for-byte, apart from
 * the character type: it now takes the CMS card payload instead of
 * `PublicCharacter`. Nothing about what it renders has changed — the badge, the
 * footer layout and the absence of chips are all the original's.
 *
 * -- THE AGE BAND IS GONE FROM HERE ------------------------------------------
 *
 * This read `adultAgeFromBand(apparentAge(visual))`, which turns the stored
 * band into a display number -- and the band is the bare string 'adult' for 62
 * of 65 characters, so it rendered the SAME age for almost the whole roster.
 * That is the defect `characters.age` was created to end, and this was the last
 * component still carrying it.
 *
 * It reaches no customer today: the results grid renders `ClipGridCard` now and
 * this is referenced only by its own test. That is exactly why it was worth
 * removing rather than leaving -- a dead component with the old behaviour is a
 * loaded gun for whoever revives it, and it would come back looking correct.
 */
export default function PersonaGridCard({
  character,
  index,
}: {
  character: PublicCharacterCard;
  index: number;
}) {
  const { visual } = useCharacterVisual(character.id);
  const media = resolveHeroMedia(character, visual);
  /**
   * NO AGE IS RENDERED HERE AT ALL.
   *
   * `PublicCharacterCard` carries no confirmed age, and the right answer to
   * that is not to reach for the band again -- it is to show nothing. Reviving
   * this component means wiring `characters.age` through its payload
   * deliberately, which is exactly the decision that should not be made by
   * accident.
   */
  const badge = personaBadge(index);

  return (
    <Link
      to={`/characters/${character.id}`}
      aria-label={`Open ${character.displayName}`}
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
      </div>
    </Link>
  );
}
