import { Link } from 'react-router-dom';
import type { PublicCharacterCard } from '../../lib/api';
import ClipMedia from './ClipMedia';

/**
 * A horizontal rail of CHARACTER cards, each showing one representative clip
 * (US-102.4).
 *
 * Backs both Play with Me and Recently Added, because they are the same shape:
 * one card per character, media chosen server-side, entry to the character's
 * profile. Two rails, one component — the difference between them is which
 * characters the API put in each, not how they look.
 *
 * NO ONLINE/OFFLINE CHIP. The previous rail stamped a green "Online" dot on
 * every card, which was decoration rather than a fact: this product has no
 * presence system, and the ticket defers it to later work. A card that cannot
 * tell the truth about presence says nothing about presence.
 *
 * NO INVENTED BADGE OR AGE. The old grid derived NEW/HOT from `index % 4` and
 * an age from a text band. Neither came from the CMS, so neither is here.
 */
export default function CharacterRail({
  title,
  characters,
  action,
}: {
  title: string;
  characters: PublicCharacterCard[];
  action?: { label: string; to: string };
}) {
  if (characters.length === 0) return null;

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-4">
        <h3 className="text-base font-bold text-white">{title}</h3>
        {action && (
          <Link
            to={action.to}
            className="text-xs font-semibold text-rose-400 hover:text-rose-300"
          >
            {action.label} →
          </Link>
        )}
      </div>
      <div className="flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {characters.map((character) => (
          <Link
            key={character.id}
            to={`/characters/${character.id}`}
            aria-label={`Open ${character.displayName}`}
            className="relative block aspect-[3/4] w-40 shrink-0 snap-start overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
          >
            <ClipMedia clip={character.clip} />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950 via-zinc-950/50 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 p-2.5">
              <span className="block truncate text-sm font-bold text-white">
                {character.displayName}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
