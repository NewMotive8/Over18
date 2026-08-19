import { useEffect, useState } from 'react';
import type { HeroMedia as HeroMediaModel } from '../lib/media';

/**
 * The visual hero of a discovery card (US-19).
 *
 * Renders, in order of preference, a looping muted inline video, a still image,
 * or an initial-letter placeholder. Degrades gracefully at runtime:
 *   - a video that fails to load falls back to its poster image, then to the
 *     placeholder;
 *   - an image that fails to load falls back to the placeholder;
 * so the card never shows a broken-media icon. A subtle shimmer covers the
 * media until it can paint.
 *
 * Media-provider agnostic: it only consumes opaque URLs resolved upstream by
 * `resolveHeroMedia`, so a future real video provider drops in with no change
 * here.
 */
/**
 * Full class names, never interpolated. Tailwind scans source text for literal
 * class strings, so `object-${fit}` would be invisible to it and could be
 * purged from the build.
 */
const FIT_CLASS = {
  cover: 'h-full w-full object-cover',
  contain: 'h-full w-full object-contain',
} as const;

export default function HeroMedia({
  media,
  alt,
  className,
  fit = 'cover',
}: {
  media: HeroMediaModel;
  alt: string;
  className?: string;
  /**
   * How the media fills its frame.
   *
   * 'cover' — the default, and what every pre-existing caller gets — crops to
   * fill, which is right for the edge-to-edge discovery cards this component
   * was built for.
   *
   * 'contain' shows the whole asset, letterboxed. Opt-in, added for the chat
   * full-screen viewer, where a photo someone was deliberately sent has to be
   * seen whole rather than cropped to a card's shape.
   */
  fit?: 'cover' | 'contain';
}) {
  const [videoFailed, setVideoFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [ready, setReady] = useState(false);

  // Reset transient state whenever the underlying media changes (e.g. deck advances).
  const mediaKey = media.kind === 'placeholder' ? `p:${media.initial}` : `${media.kind}:${media.src}`;
  useEffect(() => {
    setVideoFailed(false);
    setImageFailed(false);
    setReady(false);
  }, [mediaKey]);

  // Decide the effective element after applying runtime failures.
  const showVideo = media.kind === 'video' && !videoFailed;
  const posterAsImage =
    media.kind === 'video' && videoFailed && media.poster
      ? ({ kind: 'image', src: media.poster } as const)
      : null;
  const effectiveImage =
    media.kind === 'image' ? media : posterAsImage ? posterAsImage : null;
  const showImage = !!effectiveImage && !imageFailed;

  const initial =
    media.kind === 'placeholder' ? media.initial : (alt.charAt(0) || '?').toUpperCase();

  return (
    <div className={`relative h-full w-full overflow-hidden bg-zinc-900 ${className ?? ''}`}>
      {showVideo ? (
        <video
          key={mediaKey}
          src={media.src}
          poster={media.poster}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={alt}
          onCanPlay={() => setReady(true)}
          onLoadedData={() => setReady(true)}
          onError={() => setVideoFailed(true)}
          className={FIT_CLASS[fit]}
        />
      ) : showImage && effectiveImage ? (
        <img
          key={mediaKey}
          src={effectiveImage.src}
          alt={alt}
          loading="lazy"
          onLoad={() => setReady(true)}
          onError={() => setImageFailed(true)}
          className={FIT_CLASS[fit]}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-950">
          <span className="text-8xl font-semibold text-rose-500/70">{initial}</span>
        </div>
      )}

      {/* Loading shimmer — hidden once the media can paint or when showing the placeholder. */}
      {!ready && (showVideo || showImage) && (
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-800 to-zinc-900"
        />
      )}
    </div>
  );
}
