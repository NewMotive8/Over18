import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PublicCharacter } from '@over18/shared';

/**
 * Consumer-grade character card: portrait image with a gradient overlay,
 * name + bio on top, and explicit selection affordances (hover/press states,
 * a "Meet <name>" pill, and full-card tap target).
 */
export default function CharacterCard({ character }: { character: PublicCharacter }) {
  const navigate = useNavigate();
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = character.profileImage && !imageFailed;

  return (
    <button
      type="button"
      onClick={() => navigate(`/characters/${character.id}`)}
      aria-label={`View ${character.displayName}'s profile`}
      className="group relative block w-full overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-left transition-transform duration-150 active:scale-[0.98]"
    >
      <div className="aspect-[4/5] w-full">
        {showImage ? (
          <img
            src={character.profileImage!}
            alt={character.displayName}
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 text-6xl font-semibold text-rose-500/70">
            {character.displayName.charAt(0)}
          </div>
        )}
      </div>

      {/* Gradient so text stays readable over any image */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 p-3">
        <h3 className="text-base font-semibold leading-tight text-white">{character.displayName}</h3>
        <p className="line-clamp-2 text-xs leading-snug text-zinc-300">{character.shortBio}</p>
        <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-rose-600/90 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors group-hover:bg-rose-500">
          Meet {character.displayName}
          <span aria-hidden>→</span>
        </span>
      </div>
    </button>
  );
}
