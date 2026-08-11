import type { CharacterVisualIdentityResponse, PublicCharacter } from '@over18/shared';
import { characterHeroVideo } from './characterMedia';

/**
 * Hero-media resolution for the Discover experience (US-19).
 *
 * The discovery card is media-first: it must show a character video when one
 * exists and fall back cleanly to an image otherwise, WITHOUT the card needing
 * a future rewrite when real video arrives. This module is the single, pure,
 * platform-independent place that decides which media a card should render.
 *
 * Data reality (US-19): the existing character API/data model has NO video
 * field — `PublicCharacter` exposes only `profileImage`, and the visual-identity
 * endpoint exposes canonical still images. Video-first is therefore implemented
 * as a forward-compatible SEAM here rather than a backend change. See
 * DEMO_MEDIA_OVERRIDES and `characterVideoUrl` below.
 */

export type HeroMedia =
  | { kind: 'video'; src: string; poster?: string }
  | { kind: 'image'; src: string }
  | { kind: 'placeholder'; initial: string };

/**
 * Clearly-isolated PoC video seam. EMPTY by default — nothing ships enabled.
 *
 * Because the character API has no video field yet, this map is the single
 * place a PoC video asset can be dropped in (keyed by character id) to exercise
 * the video-first path end-to-end without inventing a backend. Production video
 * will instead arrive as a real API field consumed by `characterVideoUrl`, at
 * which point this override map can simply be deleted.
 */
export const DEMO_MEDIA_OVERRIDES: Record<string, { videoUrl?: string; poster?: string }> = {};

/**
 * Defensively reads a possible future `videoUrl` off the character wire shape
 * without prematurely widening the shared `PublicCharacter` type. When the API
 * gains a real video field, this is the only line that needs to change.
 */
function characterVideoUrl(character: PublicCharacter): string | undefined {
  const maybe = (character as { videoUrl?: unknown }).videoUrl;
  return typeof maybe === 'string' && maybe.trim().length > 0 ? maybe : undefined;
}

/** First canonical reference image (by position) from a visual-identity response. */
export function firstCanonicalImage(
  visual: CharacterVisualIdentityResponse | null | undefined,
): string | undefined {
  if (!visual) return undefined;
  const first = visual.canonicalAssets
    .slice()
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
    )[0];
  const url = first?.imageUrl?.trim();
  return url && url.length > 0 ? url : undefined;
}

/**
 * Resolves the hero media for a character, video-first:
 *  1. a valid video (PoC override or a future API `videoUrl`) → video, using the
 *     best available still as its poster;
 *  2. otherwise the active Visual Identity's first canonical image, else the
 *     legacy `profileImage` → image;
 *  3. otherwise an initial-letter placeholder (never a broken image).
 */
export function resolveHeroMedia(
  character: PublicCharacter,
  visual?: CharacterVisualIdentityResponse | null,
): HeroMedia {
  const override = DEMO_MEDIA_OVERRIDES[character.id];
  // Real approved local clip (US-29) is the video-first source when present, so
  // the character's video loads across Lobby / Discovery / Profile. A future API
  // `videoUrl` or a PoC override still take precedence.
  const localHero = characterHeroVideo(character);
  const videoUrl = override?.videoUrl ?? characterVideoUrl(character) ?? localHero?.src;
  const stillImage = firstCanonicalImage(visual) ?? character.profileImage ?? undefined;

  if (videoUrl) {
    const poster = override?.poster ?? localHero?.poster ?? stillImage;
    return poster ? { kind: 'video', src: videoUrl, poster } : { kind: 'video', src: videoUrl };
  }

  if (stillImage) return { kind: 'image', src: stillImage };

  const source = character.displayName || character.name || '?';
  return { kind: 'placeholder', initial: source.charAt(0).toUpperCase() };
}

/** A single item in a character's profile media gallery. */
export interface CharacterMediaItem {
  id: string;
  media: HeroMedia;
  /** Premium-gated: viewing requires the Premium tier (US-19 gate). */
  premium: boolean;
  /** True for clearly-isolated placeholder tiles that have no real asset yet. */
  mock?: boolean;
}

/**
 * The ordered media set for a character's profile gallery (US-19),
 * provider-agnostic:
 *  - item 0 is the free hero (video-first when available);
 *  - any additional REAL canonical stills follow, free and viewable;
 *  - to keep the Premium gate demonstrable in the PoC (seed characters ship a
 *    single canonical asset today), a few clearly-flagged MOCK tiles are
 *    appended and marked premium.
 *
 * When a real media provider (selected in US-17) supplies multiple assets, the
 * mock tiles simply stop being generated — no UI change is needed, which is the
 * whole point of routing every media surface through this one function.
 */
export function characterMediaList(
  character: PublicCharacter,
  visual?: CharacterVisualIdentityResponse | null,
  opts: { minItems?: number } = {},
): CharacterMediaItem[] {
  const minItems = opts.minItems ?? 6;
  const items: CharacterMediaItem[] = [];

  items.push({
    id: `${character.id}:hero`,
    media: resolveHeroMedia(character, visual),
    premium: false,
  });

  const sorted = (visual?.canonicalAssets ?? [])
    .slice()
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
    );
  for (let i = 1; i < sorted.length; i += 1) {
    const url = sorted[i]?.imageUrl?.trim();
    if (url) items.push({ id: sorted[i]!.id, media: { kind: 'image', src: url }, premium: false });
  }

  const still = firstCanonicalImage(visual) ?? character.profileImage ?? undefined;
  const lockedMedia: HeroMedia = still
    ? { kind: 'image', src: still }
    : { kind: 'placeholder', initial: (character.displayName || character.name || '?').charAt(0).toUpperCase() };
  let n = 0;
  while (items.length < minItems) {
    n += 1;
    items.push({ id: `${character.id}:locked:${n}`, media: lockedMedia, premium: true, mock: true });
  }

  return items;
}

/**
 * The character's apparent-age band, if the public visual identity exposes one
 * (label "Apparent age", e.g. "adult (mid-20s)"). Returns undefined when the
 * data has no age — the card must degrade gracefully rather than invent one.
 */
export function apparentAge(
  visual: CharacterVisualIdentityResponse | null | undefined,
): string | undefined {
  const attr = visual?.identity?.attributes.find(
    (a) => a.label.trim().toLowerCase() === 'apparent age',
  );
  const value = attr?.value?.trim();
  return value && value.length > 0 ? value : undefined;
}
