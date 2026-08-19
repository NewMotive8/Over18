import { useState } from 'react';
import type { ChatMessageMedia } from '@over18/shared';
import { API_URL } from '../lib/api';
import MediaViewer from './MediaViewer';

/**
 * Media attached to a character's chat message.
 *
 * INLINE RENDERING is deliberately not HeroMedia: that component fills its
 * frame with object-COVER and autoplays a muted silent loop with no controls,
 * which is right for a swipe card and wrong for a message. Media a character
 * deliberately sent must be shown whole, and a video must be playable.
 *
 * FULL SCREEN, however, reuses the app's existing MediaViewer rather than
 * inventing a second one. Video already had a full-screen affordance — the
 * browser's own control bar — while a tapped image did nothing at all. That
 * inconsistency is what this fixes: the image is now a real button that opens
 * the same viewer the character gallery uses, in its non-cropping mode.
 *
 * Video is left exactly as it was. Its native controls already give full
 * screen, playback and scrubbing, and routing it through MediaViewer would
 * have REMOVED those (HeroMedia renders video muted, looping and
 * control-less). Sharing the mechanism was not necessary to fix the image.
 *
 * The viewer is `fixed inset-0` and the chat is never unmounted or scrolled,
 * so closing returns to the exact same position — no scroll save/restore, and
 * nothing here touches the scroll anchor or the 2s/5s timing.
 *
 * The `url` is the message-scoped route: no asset id, storage key, path or
 * provenance, readable only by the owner of that conversation.
 */

/**
 * Preserve the aspect ratio, cap the size, never crop.
 *
 * max-w-full keeps it inside the bubble; max-h-80 stops a tall portrait taking
 * the whole viewport. With no forced width the browser uses the intrinsic
 * ratio, so nothing is distorted; object-contain guarantees it even when the
 * height cap is what binds. Deliberately NOT object-cover — see mediaTile.ts
 * for the same rule and the same reason.
 */
export const MESSAGE_MEDIA_CLASS = 'max-h-80 max-w-full rounded-lg object-contain';

export default function MessageMedia({
  media,
  characterName,
}: {
  media: ChatMessageMedia;
  characterName: string;
}) {
  const src = `${API_URL}${media.url}`;
  const [viewerOpen, setViewerOpen] = useState(false);

  if (media.type === 'video') {
    // Unchanged. The native control bar is the existing full-screen path.
    return (
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label={`Video from ${characterName}`}
        className={MESSAGE_MEDIA_CLASS}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        aria-label={`View photo from ${characterName} full screen`}
        aria-haspopup="dialog"
        className="block cursor-zoom-in rounded-lg"
      >
        <img
          src={src}
          alt={`Sent by ${characterName}`}
          loading="lazy"
          className={MESSAGE_MEDIA_CLASS}
        />
      </button>

      {viewerOpen && (
        <MediaViewer
          items={[{ id: media.url, media: { kind: 'image', src }, premium: false }]}
          startIndex={0}
          label={characterName}
          onClose={() => setViewerOpen(false)}
          fit="contain"
        />
      )}
    </>
  );
}
