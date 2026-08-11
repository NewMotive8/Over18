import type { PublicCharacter, PublicVisualIdentityAttribute } from '@over18/shared';
import { characterVideos } from '../../lib/characterMedia';

/**
 * About tab (US-29 / brief §2): bio, personality/conversation style, a
 * structured attribute grid (from the public Visual Identity), interests, and a
 * horizontally scrolling THEMATIC media rail built from the character's real
 * additional clips — genuine in-character content with human labels, not demo
 * tiles. Tapping a clip opens the shared media viewer.
 */
export default function AboutTab({
  character,
  attributes,
  onOpenClip,
}: {
  character: PublicCharacter;
  attributes: PublicVisualIdentityAttribute[];
  /** Opens the media viewer at the given clip index (into the full clip set). */
  onOpenClip: (index: number) => void;
}) {
  const videos = characterVideos(character);
  const thematic = videos.map((v, i) => ({ ...v, index: i })).filter((v) => v.role !== 'hero');

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
        <p className="text-sm leading-relaxed text-zinc-200">{character.shortBio}</p>
      </div>

      {thematic.length > 0 && (
        <section aria-label="Media">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            More of {character.displayName}
          </h3>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {thematic.map((clip) => (
              <button
                key={clip.src}
                type="button"
                onClick={() => onOpenClip(clip.index)}
                aria-label={`Play ${clip.label}`}
                className="group relative aspect-[3/4] w-32 shrink-0 overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
              >
                <img src={clip.poster} alt={clip.label} loading="lazy" className="h-full w-full object-cover" />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 to-transparent" />
                <span className="absolute bottom-2 left-2 right-2 truncate text-left text-[11px] font-semibold text-white">
                  {clip.label}
                </span>
                <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-[10px] text-white backdrop-blur">
                  ▶
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Personality</h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">{character.personality}</p>
      </div>

      {attributes.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Details</h3>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
            {attributes.map((attr) => (
              <div key={attr.label} className="flex flex-col">
                <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{attr.label}</dt>
                <dd className="text-sm text-zinc-300">{attr.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {character.interests.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Interests</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {character.interests.map((interest) => (
              <li
                key={interest}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-300"
              >
                {interest}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Conversation style
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">{character.conversationStyle}</p>
      </div>
    </div>
  );
}
