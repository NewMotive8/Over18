import { useEffect, useState } from 'react';
import type { CharacterMediaItem } from '../lib/media';
import HeroMedia from './HeroMedia';
import VideoSoundControl from './VideoSoundControl';
import { INITIAL_SOUND, setVolume, toggleMute, type VideoSound } from '../lib/videoSound';

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
  fit = 'cover',
  videoFit,
}: {
  items: CharacterMediaItem[];
  startIndex: number;
  label: string;
  onClose: () => void;
  /**
   * 'cover' — the default, and what the character gallery gets — shows the
   * media in a fixed 4/5 frame, cropping to fill.
   *
   * 'contain' drops the fixed frame and shows the whole asset letterboxed
   * against the backdrop. Opt-in, used by chat: a photo the character
   * deliberately sent has to be seen whole, at its own aspect ratio.
   */
  fit?: 'cover' | 'contain';
  /**
   * How VIDEO is fitted, when that should differ from `fit`.
   *
   * WHY A SECOND PROP RATHER THAN `fit="contain"`. A character's Posts gallery
   * mixes images and videos in one viewer, and it pages between them in here --
   * the caller never learns which item is on screen, so it cannot decide per
   * item. Passing `fit="contain"` would have moved her IMAGES out of their 4/5
   * frame too, which is a change nobody asked for.
   *
   * Undefined means "whatever `fit` says", so every existing caller -- chat
   * included, which passes `fit="contain"` for its own reasons -- renders
   * exactly as it did.
   */
  videoFit?: 'cover' | 'contain';
}) {
  const [index, setIndex] = useState(startIndex);
  const clamped = Math.max(0, Math.min(index, items.length - 1));
  const item = items[clamped];

  /**
   * SOUND LIVES HERE, FOR AS LONG AS THE VIEWER IS OPEN.
   *
   * Not in HeroMedia, which is keyed by the item and remounts on every page, so
   * a choice kept there would silence itself each time she moved to the next
   * clip. Held at this level, "unmute, set it to a third, keep going" survives
   * paging and resets only when the viewer closes — which is the right scope: a
   * volume is a decision about this sitting, not a preference to remember.
   *
   * Muted is the starting point and that is deliberate, not a limitation. See
   * VideoSoundControl for why it is also the only starting point a browser
   * would allow.
   */
  const [sound, setSound] = useState<VideoSound>(INITIAL_SOUND);

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

  /**
   * THE FIT THAT ACTUALLY APPLIES TO WHAT IS ON SCREEN.
   *
   * Used for BOTH the container and the media, and that pairing is the whole
   * point: the two `fit` branches below are different boxes, not just different
   * `object-fit` values. `contain` media inside the `cover` box would still be
   * cropped -- the box is a fixed 4/5 with `overflow-hidden` -- so honouring
   * this in one place and not the other would look like the fix had not worked.
   */
  const effectiveFit = item.media.kind === 'video' ? (videoFit ?? fit) : fit;
  const isVideo = item.media.kind === 'video';

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
        className={
          effectiveFit === 'contain'
            ? // A DEFINITE height, not max-h: HeroMedia's inner element is
              // `h-full`, which only resolves against a definite parent. With
              // max-h alone the height is indefinite, h-full collapses to auto
              // and the image sizes unpredictably. No fixed ratio and no
              // overflow clipping, so object-contain letterboxes inside these
              // bounds and nothing is ever cut off.
              'relative h-[85vh] w-full max-w-3xl'
            : 'relative aspect-[4/5] w-full max-w-md overflow-hidden rounded-2xl'
        }
        onClick={(e) => e.stopPropagation()}
      >
        <HeroMedia
          media={item.media}
          alt={label}
          fit={effectiveFit}
          // Images never take a sound prop, so they stay exactly as they were.
          sound={isVideo ? sound : undefined}
        />
      </div>

      {/*
        Anchored to the dialog, not to the media box, so it sits clear of a
        letterboxed clip instead of on top of it. Left-aligned because the close
        button owns the top right and the paging arrows own the sides; the
        bottom-left corner is the one place nothing else competes for, on a
        phone as much as on a desktop. The safe-area inset keeps it above a
        home indicator.
      */}
      {isVideo && (
        <div className="pointer-events-none absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-3 z-10">
          <VideoSoundControl
            sound={sound}
            onToggleMute={() => setSound(toggleMute)}
            onVolumeChange={(next) => setSound(setVolume(next))}
          />
        </div>
      )}

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
