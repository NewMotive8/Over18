import { useEffect, useState } from 'react';
import type { CharacterMediaItem } from '../lib/media';
import HeroMedia from './HeroMedia';

/**
 * Full-screen media viewer (US-19).
 *
 * A lightweight lightbox for the free items in a character's gallery, built on
 * the same provider-agnostic HeroMedia so a future video provider needs no
 * change here. Keyboard: ← / → to page, Esc to close. Backdrop click closes.
 */
export default function MediaViewer({
  items,
  startIndex,
  label,
  onClose,
}: {
  items: CharacterMediaItem[];
  startIndex: number;
  label: string;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const clamped = Math.max(0, Math.min(index, items.length - 1));
  const item = items[clamped];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setIndex((i) => Math.min(items.length - 1, i + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length, onClose]);

  if (!item) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${label} media`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close media viewer"
        className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
      >
        ✕
      </button>

      <div
        className="relative aspect-[4/5] w-full max-w-md overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <HeroMedia media={item.media} alt={label} />
      </div>

      {items.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => Math.max(0, i - 1));
            }}
            disabled={clamped === 0}
            aria-label="Previous"
            className="absolute left-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            }}
            disabled={clamped === items.length - 1}
            aria-label="Next"
            className="absolute right-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
          >
            ›
          </button>
          <span className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] text-xs text-zinc-400">
            {clamped + 1} / {items.length}
          </span>
        </>
      )}
    </div>
  );
}
