import { useEffect, useRef, useState } from 'react';
import { API_URL, type PublicClip } from '../../lib/api';
import { useInViewport } from '../../hooks/useInViewport';

/**
 * One CMS clip, rendered from its opaque locator (US-102.4).
 *
 * The `url` this takes is `/api/media/assets/:id/file` — an id-keyed route, not
 * a storage key, path or extension. That distinction is the whole point of the
 * public media work in this ticket: the component cannot leak a path because it
 * is never given one.
 *
 * Degrades to a neutral frame rather than a broken-media icon, because a clip
 * whose asset lost approval between the payload and the fetch will 404, and the
 * app should look unremarkable when that happens.
 *
 * ── LOADING AND PLAYBACK ARE DEFERRED ────────────────────────────────────────
 *
 * WHAT WAS MEASURED. Every clip on Home became a live `<video autoplay>` the
 * moment the page rendered: 24 elements, all 24 requests issued within 0.1s of
 * each other, 18 of them off screen and already buffering, an entire Search
 * section downloaded below the fold. Nothing waited to be seen.
 *
 * NOW: the element mounts immediately — same markup, same classes, same box, so
 * layout and the scroll-snap geometry are untouched — but its `src` is withheld
 * until it is within `useInViewport`'s load margin, and it plays only while it
 * is genuinely on screen.
 *
 * ONCE FETCHED, THE SRC STAYS. Scrolling away pauses playback but does not
 * remove the source, because dropping it would throw away bytes already paid
 * for and re-download them on the way back — trading one waste for another.
 *
 * `active` IS A SEPARATE, STRICTER GATE, used by the Hero: a slide can be
 * perfectly visible by the viewport's reckoning and still not be the slide the
 * carousel is showing. Visibility alone cannot express that, so the caller says
 * so directly.
 *
 * NOTHING VISUAL CHANGED: `autoPlay`, `muted`, `loop`, `playsInline` and
 * `preload="metadata"` are all exactly as before. `preload="metadata"` in
 * particular only became meaningful once the media route gained range support —
 * before that, a metadata sniff was answered with the entire file.
 */
export default function ClipMedia({
  clip,
  className,
  autoPlay = false,
  active = true,
}: {
  clip: PublicClip | null;
  className?: string;
  autoPlay?: boolean;
  /**
   * False when the caller knows this clip is not the one being presented, even
   * if it is technically on screen. Defaults to true so every existing caller
   * behaves exactly as it did.
   */
  active?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { near, visible } = useInViewport(videoRef);
  const [fetched, setFetched] = useState(false);

  const classes = className ?? 'h-full w-full object-cover';
  const isVideo = clip?.mediaType === 'video';
  const shouldLoad = near || fetched;
  /**
   * Whether this clip should be running right now.
   *
   * The `autoPlay` ATTRIBUTE is bound to this rather than left permanently on.
   * Leaving it on created a race: the effect below would pause an element that
   * had not started yet — `paused` was still true, so there was nothing to
   * pause — and the browser then began autoplaying it a moment later. Measured
   * as Hero slide 2 playing off screen despite being inactive. Binding the
   * attribute means the element is never told to start in the first place.
   *
   * In SSR both flags default true, so server-rendered markup keeps `autoplay`
   * exactly as before.
   */
  const shouldPlay = autoPlay && visible && active;

  useEffect(() => {
    if (shouldLoad && !fetched) setFetched(true);
  }, [shouldLoad, fetched]);

  // Play only while on screen AND active. Pausing an off-screen decoder is the
  // point: the browser keeps the buffered data, it just stops working on it.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !isVideo || !shouldLoad) return;
    if (shouldPlay) {
      const attempt = el.play();
      // Autoplay can still be refused (a policy change, reduced-motion). A
      // refusal is not an error worth surfacing — the frame simply stays put.
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    } else {
      // Unconditional: pausing an already-paused element is a no-op, and
      // checking `paused` first is exactly what lost the race above.
      el.pause();
    }
  }, [shouldPlay, isVideo, shouldLoad]);

  if (!clip || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-900 text-xs text-zinc-600">
        {clip?.characterName?.charAt(0).toUpperCase() ?? ''}
      </div>
    );
  }

  const src = `${API_URL}${clip.url}`;
  if (isVideo) {
    return (
      <video
        ref={videoRef}
        {...(shouldLoad ? { src } : {})}
        muted
        loop
        playsInline
        autoPlay={shouldPlay}
        preload="metadata"
        className={classes}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={classes}
      onError={() => setFailed(true)}
    />
  );
}
