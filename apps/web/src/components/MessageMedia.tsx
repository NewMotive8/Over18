import type { ChatMessageMedia } from '@over18/shared';
import { API_URL } from '../lib/api';

/**
 * Media attached to a character's chat message.
 *
 * WHY NOT HeroMedia / MediaViewer. Both exist and both were considered, but
 * they are discovery-card infrastructure: HeroMedia fills its frame with
 * object-COVER and autoplays a muted silent loop with no controls, and
 * MediaViewer wraps it in a fixed aspect-[4/5] box. That is right for a swipe
 * card and wrong here — a photo a character deliberately sent must be shown
 * whole, not cropped to a card's shape, and a video must be playable. Reusing
 * them would have contradicted the requirement to preserve aspect ratio, and
 * changing them would have altered the existing gallery. So this is a small,
 * separate component; nothing about the chat bubble itself is redesigned.
 *
 * The `url` is the message-scoped route from commit 1. It is opaque: no asset
 * id, no storage key, no provenance, no filesystem path, and it is readable
 * only by the owner of the conversation the message belongs to.
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

  if (media.type === 'video') {
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
    <img
      src={src}
      alt={`Sent by ${characterName}`}
      loading="lazy"
      className={MESSAGE_MEDIA_CLASS}
    />
  );
}
