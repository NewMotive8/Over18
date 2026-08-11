import type { PublicCharacter } from '@over18/shared';
import { characterVideos } from '../../lib/characterMedia';
import { CrownIcon, LikeIcon, LockIcon } from '../icons';

/**
 * Posts tab with the content paywall (US-29 / brief §2 & §Posts).
 *
 * A two-column media feed: the first posts are accessible (tap opens the shared
 * viewer), then the feed hits a paywall — remaining posts blur heavily and a
 * premium gate banner invites the user to unlock. Tapping any locked post or
 * the banner opens the existing PremiumGate. Purely presentational gating; no
 * billing.
 */
export default function PostsTab({
  character,
  onOpenClip,
  onLocked,
}: {
  character: PublicCharacter;
  onOpenClip: (index: number) => void;
  onLocked: () => void;
}) {
  const clips = characterVideos(character);
  const posters = clips.length > 0 ? clips.map((c) => c.poster) : [character.profileImage ?? ''];

  // First two clips are free previews; everything past the paywall is locked.
  const accessible = clips.slice(0, 2).map((c, i) => ({ poster: c.poster, index: i, likes: 240 + i * 57 }));
  const locked = Array.from({ length: 6 }, (_, i) => ({ poster: posters[i % posters.length]!, id: `locked-${i}` }));

  return (
    <div className="flex flex-col gap-4">
      {/* Accessible previews */}
      <div className="grid grid-cols-2 gap-3">
        {accessible.map((post) => (
          <button
            key={post.index}
            type="button"
            onClick={() => onOpenClip(post.index)}
            className="group relative block aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
          >
            <img src={post.poster} alt="" loading="lazy" className="h-full w-full object-cover" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent" />
            <span className="absolute bottom-2 left-2 flex items-center gap-1 text-[11px] font-semibold text-white">
              <LikeIcon className="h-3.5 w-3.5 text-rose-400" /> {post.likes}
            </span>
          </button>
        ))}
      </div>

      {/* Paywall zone: blurred locked posts with a premium gate banner overlaid */}
      <div className="relative">
        <div aria-hidden className="grid grid-cols-2 gap-3">
          {locked.map((post) => (
            <div key={post.id} className="relative aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900">
              <img src={post.poster} alt="" loading="lazy" className="h-full w-full scale-110 object-cover blur-2xl" />
              <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/50 text-zinc-300">
                <LockIcon className="h-6 w-6" />
              </div>
            </div>
          ))}
        </div>

        {/* Gate banner */}
        <div className="absolute inset-x-0 bottom-0 top-16 flex items-end justify-center bg-gradient-to-t from-zinc-950 via-zinc-950/80 to-transparent">
          <button
            type="button"
            onClick={onLocked}
            className="mb-6 flex w-[85%] max-w-sm flex-col items-center gap-2 rounded-3xl border border-amber-400/30 bg-zinc-900/90 p-5 text-center shadow-xl backdrop-blur"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-amber-950">
              <CrownIcon className="h-5 w-5" />
            </span>
            <span className="text-base font-black text-white">Unlock {character.displayName}&rsquo;s posts</span>
            <span className="text-xs text-zinc-400">
              48 exclusive photos &amp; videos, and priority chat — with Premium.
            </span>
            <span className="mt-1 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-5 py-2 text-sm font-bold text-amber-950">
              Go Premium
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
