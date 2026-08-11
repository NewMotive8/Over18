import type { PublicCharacter } from '@over18/shared';
import type { CharacterMediaItem, HeroMedia } from './media';

/**
 * Local PoC media manifest (US-29).
 *
 * Maps a character (by its stable `name`) to the REAL Kling video clips that
 * ship as static assets under `apps/web/public/media/<name>/`. This is the
 * single, provider-agnostic seam that connects the character API to on-disk
 * media: it deals only in opaque URLs, so when a real media provider (US-17)
 * arrives it replaces this map without any component change.
 *
 * These are genuine 9:16, muted, looping character clips — not placeholders and
 * not remote URLs. Each character exposes a hero clip plus its additional
 * "thematic" clips; no clip is duplicated to fill a slot.
 */
export interface CharacterVideo {
  role: 'hero' | 'profile';
  /** Opaque media locator (a local static path in the PoC). */
  src: string;
  poster: string;
  /** Human, in-character label — genuine content, never "tile 2". */
  label: string;
}

/**
 * The six APPROVED PoC clips only (US-16H set), mapped by role. Luna has a
 * single approved clip (Profile 04), which serves as her featured/hero media;
 * Ember and Sage use their approved Hero clip plus their profile clips. No
 * unapproved or invented media.
 */
const MANIFEST: Record<string, CharacterVideo[]> = {
  luna: [
    // Luna's only approved clip (Profile 04) — used wherever Luna video is required.
    { role: 'hero', src: '/media/luna/profile-04.mp4', poster: '/media/luna/profile-04.jpg', label: 'Just for you' },
  ],
  ember: [
    { role: 'hero', src: '/media/ember/hero.mp4', poster: '/media/ember/hero.jpg', label: 'Turning up the heat' },
    { role: 'profile', src: '/media/ember/profile-02.mp4', poster: '/media/ember/profile-02.jpg', label: 'Off the clock' },
    { role: 'profile', src: '/media/ember/profile-03.mp4', poster: '/media/ember/profile-03.jpg', label: 'Late night' },
  ],
  sage: [
    { role: 'hero', src: '/media/sage/hero.mp4', poster: '/media/sage/hero.jpg', label: 'Cabin evenings' },
    { role: 'profile', src: '/media/sage/profile-02.mp4', poster: '/media/sage/profile-02.jpg', label: 'Unwinding' },
  ],
};

function manifestKey(character: PublicCharacter): string {
  return (character.name || character.displayName || '').trim().toLowerCase();
}

/** All real video clips for a character (hero first), or [] if none on disk. */
export function characterVideos(character: PublicCharacter): CharacterVideo[] {
  return MANIFEST[manifestKey(character)] ?? [];
}

/** The character's hero clip (or the first available), if any. */
export function characterHeroVideo(character: PublicCharacter): CharacterVideo | undefined {
  const videos = characterVideos(character);
  return videos.find((v) => v.role === 'hero') ?? videos[0];
}

/** The character's non-hero "thematic" clips. */
export function characterAdditionalVideos(character: PublicCharacter): CharacterVideo[] {
  const hero = characterHeroVideo(character);
  return characterVideos(character).filter((v) => v !== hero);
}

/** Convert a manifest clip to the shared HeroMedia video shape. */
export function videoToHeroMedia(video: CharacterVideo): HeroMedia {
  return { kind: 'video', src: video.src, poster: video.poster };
}

/** The full clip set as gallery/viewer items (US-19 MediaViewer/Gallery compatible). */
export function characterVideoItems(character: PublicCharacter): CharacterMediaItem[] {
  return characterVideos(character).map((video) => ({
    id: video.src,
    media: videoToHeroMedia(video),
    premium: false,
  }));
}
