import { useState } from 'react';

/**
 * A character's round avatar -- one component, so she looks the same in the
 * chat header and on her profile.
 *
 * FRAMED FROM THE TOP, SO HER HEAD IS NEVER CUT. Her portrait is her primary
 * reference, which is usually taller than it is wide: a half- or full-length
 * picture with her face in the upper part. A circle needs a square, and the
 * default crop takes the MIDDLE of the picture -- on a tall portrait that is
 * her chest, with the top of her head sliced off by the circle. Anchoring the
 * crop to the top edge keeps everything above her shoulders, whatever the
 * picture's proportions; a square picture is unaffected.
 *
 * A picture that fails to load falls back to her initial, as a missing one
 * does, rather than a broken-image icon.
 */

const SIZE = {
  sm: 'h-12 w-12 text-lg',
  md: 'h-14 w-14 text-xl',
  lg: 'h-20 w-20 text-3xl',
} as const;

export default function CharacterAvatar({
  name,
  src,
  size,
  className = '',
}: {
  name: string;
  src?: string | null;
  size: keyof typeof SIZE;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src) && failedSrc !== src;
  return (
    <span
      data-testid="character-avatar"
      className={`relative block shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-zinc-700 to-zinc-900 shadow-lg shadow-black/40 ring-2 ring-white/80 ${SIZE[size]} ${className}`}
    >
      {showImage ? (
        <img
          src={src!}
          alt=""
          draggable={false}
          onError={() => setFailedSrc(src!)}
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <span aria-hidden className="flex h-full w-full items-center justify-center font-bold text-rose-400">
          {name.trim().charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  );
}
