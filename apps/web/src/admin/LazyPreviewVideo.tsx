import { useEffect, useRef, useState } from 'react';

/**
 * A video tile for admin screens that list MANY clips at once.
 *
 * The category page drew its whole approved library with autoplaying, looping
 * videos -- 182 of them on staging, every one a full file fetched and decoded
 * at the same moment. The page flickered and would not scroll.
 *
 * So a tile here costs nothing until it matters:
 *
 *   OFF SCREEN   no `src` at all: nothing is fetched, nothing is decoded.
 *   ON SCREEN    a still. `preload="metadata"` fetches the header, and the
 *                `#t=0.1` fragment shows the frame a tenth of a second in (a
 *                frame at exactly 0 is often black).
 *   POINTED AT   it plays, muted and looping, and stops when the pointer
 *                leaves -- motion is still there for whoever wants to see it,
 *                one clip at a time instead of all of them.
 *
 * Once a tile has been on screen it keeps its still, so scrolling back does
 * not blank and reload it.
 */
export default function LazyPreviewVideo({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      // Start a little before it scrolls in, so the still is there on arrival.
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);

  return (
    <video
      ref={ref}
      data-testid="lazy-preview-video"
      src={seen ? `${src}#t=0.1` : undefined}
      preload="metadata"
      muted
      loop
      playsInline
      onMouseEnter={(event) => void event.currentTarget.play().catch(() => {})}
      onMouseLeave={(event) => event.currentTarget.pause()}
      className={className}
    />
  );
}
