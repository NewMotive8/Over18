import { useEffect, useState, type ReactNode } from 'react';
import type { PublicClip } from '../lib/api';
import { nextIndex } from '../lib/headerRotation';
import { absoluteMediaUrl } from '../lib/media';

/** A clip that never ends or stalls still hands over after this long. */
const MAX_CLIP_MS = 12_000;

/**
 * One header, many characters: plays `clips` one after another and loops.
 *
 * Each clip moves on when it ends (or fails to load, or runs past
 * MAX_CLIP_MS); after the last comes the first. With no clips it renders
 * `fallback` -- the header as it was -- so a slow or empty list never leaves
 * the header blank.
 */
export default function RotatingHeaderClip({
  clips,
  fallback,
  className = 'absolute inset-0 h-full w-full object-cover',
}: {
  clips: readonly PublicClip[];
  fallback: ReactNode;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const count = clips.length;
  const current = count > 0 ? clips[index % count]! : null;

  // Safety net: hand over even if a clip never fires `ended`.
  useEffect(() => {
    if (count < 2) return;
    const timer = setTimeout(() => setIndex((i) => nextIndex(i, count)), MAX_CLIP_MS);
    return () => clearTimeout(timer);
  }, [index, count]);

  if (!current) return <>{fallback}</>;

  const advance = () => setIndex((i) => nextIndex(i, count));
  return (
    <video
      key={current.id}
      data-testid="header-rotation"
      data-index={index % count}
      data-count={count}
      src={absoluteMediaUrl(current.url)}
      autoPlay
      muted
      playsInline
      // One clip alone loops; several hand over to each other.
      loop={count === 1}
      onEnded={advance}
      onError={advance}
      aria-label={current.characterName}
      className={className}
    />
  );
}
