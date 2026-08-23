import { useState } from 'react';
import { API_URL, type PublicClip } from '../../lib/api';

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
 */
export default function ClipMedia({
  clip,
  className,
  autoPlay = false,
}: {
  clip: PublicClip | null;
  className?: string;
  autoPlay?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const classes = className ?? 'h-full w-full object-cover';

  if (!clip || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-900 text-xs text-zinc-600">
        {clip?.characterName?.charAt(0).toUpperCase() ?? ''}
      </div>
    );
  }

  const src = `${API_URL}${clip.url}`;
  if (clip.mediaType === 'video') {
    return (
      <video
        src={src}
        muted
        loop
        playsInline
        autoPlay={autoPlay}
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
