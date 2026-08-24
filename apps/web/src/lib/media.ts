import type { CharacterVisualIdentityResponse, PublicCharacter } from '@over18/shared';

/**
 * The only character fields media resolution actually reads.
 *
 * Narrowed from `PublicCharacter` so the lobby's CMS card payload — which
 * carries identity and locators but not the persona prose — can use the same
 * resolution path. Every existing caller passes a full `PublicCharacter`, which
 * satisfies this structurally, so nothing else changes.
 */
export type MediaCharacter = Pick<
  PublicCharacter,
  'id' | 'name' | 'displayName' | 'profileImage'
> & {
  /**
   * The character's ONE representative publicly-reachable clip, as the server
   * chose it. Optional, because the older `/api/characters` payload has no such
   * field and every existing caller must keep working unchanged.
   *
   * This is the CMS's answer to "what does this character look like right now",
   * and it is the field that lets an operator's uploaded video reach a card.
   * It carries no authority of its own: the server only puts a clip here when
   * `publiclyReachableCondition` passes, so an unapproved clip, a clip placed
   * nowhere, or a clip belonging to an unpublished character simply is not in
   * the payload and cannot be selected here.
   */
  clip?: { url: string; mediaType: 'image' | 'video' } | null;
};
import { characterHeroVideo } from './characterMedia';
import { API_URL } from './api';

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
function characterVideoUrl(character: MediaCharacter): string | undefined {
  const maybe = (character as { videoUrl?: unknown }).videoUrl;
  return typeof maybe === 'string' && maybe.trim().length > 0 ? maybe : undefined;
}

/**
 * Resolves a media locator to something a browser can actually fetch.
 *
 * US-102.4 replaced the public `imageUrl` with an API-relative opaque route
 * (`/api/media/assets/:id/file`) — it used to be the server's raw storage path.
 * A root-relative path resolves against the WEB origin, which is not where the
 * API lives in any deployed configuration, so it has to be prefixed. Absolute
 * URLs (a PoC override, a future CDN) are passed through untouched.
 */
export function absoluteMediaUrl(raw: string | null | undefined): string | undefined {
  const url = raw?.trim();
  if (!url) return undefined;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return url.startsWith('/') ? `${API_URL}${url}` : url;
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
  // US-102.4: imageUrl is now an API-relative opaque route
  // (/api/media/assets/:id/file), not an absolute URL. It has to be resolved
  // against the API origin — the web app and the API are separate origins in
  // every deployed configuration.
  const url = absoluteMediaUrl(first?.imageUrl);
  return url && url.length > 0 ? url : undefined;
}

/**
 * The character's CMS clip, when it is a video the browser can be pointed at.
 *
 * This is the seam that connects an operator's upload to a public card. Before
 * it, the only video a card could ever show came from the hard-coded local
 * manifest below, so a character created through the CMS — however many clips
 * were uploaded and approved for her — was permanently a still image.
 *
 * IT RELAXES NOTHING. `clip` is only present when the server's
 * `publiclyReachableCondition` passed: approved, owned by an ACTIVE character,
 * and reachable via the Hero, a published category, a canonical reference or a
 * discovery keyword. An unapproved clip, one placed nowhere, or one belonging
 * to an unpublished character never arrives here to be chosen.
 */
function cmsVideoUrl(character: MediaCharacter): string | undefined {
  if (character.clip?.mediaType !== 'video') return undefined;
  // API-relative opaque route — the web app and the API are separate origins.
  return absoluteMediaUrl(character.clip.url);
}

/**
 * Media for a HOME CHARACTER RAIL — Play with me and Recently Added.
 *
 * CLIP-ONLY, BY CONSTRUCTION. These rails represent a character by her own
 * content and nothing else. The one and only source here is the server's
 * representative clip, which `representativeClips` has already restricted to a
 * publicly reachable, non-reference VIDEO belonging to that character.
 *
 * WHAT THIS DELIBERATELY CANNOT DO, and why it is a separate function rather
 * than a flag on `resolveHeroMedia`: it cannot reach her canonical image, her
 * `profileImage`, her visual-identity image, or the hard-coded local manifest.
 * The card used to show her portrait when she had no video, which read as "here
 * is her clip" and was not. None of those sources are in scope here, so no
 * future edit to the fallback chain can reintroduce them on a rail.
 *
 * NO ELIGIBLE VIDEO ⇒ the existing neutral placeholder — the same
 * initial-letter treatment `HeroMedia` already renders. No new visual design,
 * no substitute image, and the operator's curation is still honoured: she keeps
 * her place on the rail rather than silently vanishing.
 *
 * `resolveHeroMedia` is untouched and still serves the discovery grid, the
 * swipe card and the Character page, where showing a character's own image is
 * correct and intended.
 */
export function resolveRailMedia(character: MediaCharacter): HeroMedia {
  const src = cmsVideoUrl(character);
  if (src) return { kind: 'video', src };
  const source = character.displayName || character.name || '?';
  return { kind: 'placeholder', initial: source.charAt(0).toUpperCase() };
}

/**
 * Resolves the hero media for a character, video-first:
 *  1. a valid video → video, using the best available still as its poster;
 *  2. otherwise the active Visual Identity's first canonical image, else the
 *     legacy `profileImage` → image;
 *  3. otherwise an initial-letter placeholder (never a broken image).
 *
 * VIDEO PRECEDENCE, and why the CMS sits above the manifest. A PoC override
 * wins first (it exists to force a specific asset during a demo), then a real
 * API `videoUrl` if one ever ships. Then the CMS clip — what an operator
 * actually published — and only then the hard-coded manifest, which is
 * explicitly a stopgap "single, provider-agnostic seam" to be replaced. An
 * operator's published choice must outrank a constant in the source.
 *
 * The seeded characters are unaffected in practice: their representative clip
 * is a canonical IMAGE, so `cmsVideoUrl` returns nothing for them and their
 * manifest clips still play, exactly as before.
 */
export function resolveHeroMedia(
  character: MediaCharacter,
  visual?: CharacterVisualIdentityResponse | null,
): HeroMedia {
  const override = DEMO_MEDIA_OVERRIDES[character.id];
  // Real approved local clip (US-29) is the video-first source when present, so
  // the character's video loads across Lobby / Discovery / Profile. A future API
  // `videoUrl`, a PoC override and the CMS's own clip all take precedence.
  const localHero = characterHeroVideo(character);
  const videoUrl =
    override?.videoUrl ?? characterVideoUrl(character) ?? cmsVideoUrl(character) ?? localHero?.src;
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
  character: MediaCharacter,
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
    const url = absoluteMediaUrl(sorted[i]?.imageUrl);
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
