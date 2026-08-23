/**
 * Shared media-tile fitting for the admin content screens.
 *
 * The Content Library and the Review queue both show a grid of fixed-ratio
 * tiles over assets whose real shapes vary. They had drifted into their own
 * copies of the same classes, and both copies used object-COVER — which fills
 * the frame by CROPPING the overflow. For review content that is the worst
 * failure available: the operator approves or rejects an asset by looking at a
 * version that is not the asset. A portrait upload in the square "recent" tile
 * lost its top and bottom silently.
 *
 * object-CONTAIN instead: the media scales down until it fits entirely inside
 * the frame, so the aspect ratio is preserved, nothing is stretched and nothing
 * is cut off. The frame's background shows through as letterboxing, which is
 * the right trade for a screen whose whole job is judging the content.
 *
 * DISPLAY ONLY. Nothing here reads, resamples, resizes or derives from the file
 * on disk — these are CSS classes. Upload, storage, approval and delete
 * behaviour are untouched.
 */

/**
 * How media fits its tile frame. Identical for images and video by
 * construction — one constant, so the two can never drift apart again.
 */
export const TILE_MEDIA_CLASS = 'h-full w-full object-contain';

/**
 * The fixed tile frame. Every asset gets the same one whatever its shape.
 *
 * `dense` is the Library's square "Recently Approved" strip; everything else
 * uses the 3/4 portrait frame. `relative` is here because the Library's video
 * badge is absolutely positioned inside the frame; it is inert on tiles that
 * have no absolutely positioned children. `bg-zinc-900` is what the letterboxed
 * margins show, so it is part of the frame, not decoration.
 */
export function tileFrameClass(dense?: boolean): string {
  return `${dense ? 'aspect-square' : 'aspect-[3/4]'} relative bg-zinc-900`;
}

/**
 * Playback for a preview `<video>`. PLAYBACK ONLY — no classes, no dimensions,
 * no layout. Spreading this changes what the element DOES, never how it looks.
 *
 * A preview tile showing a still first frame is not a preview of a video: an
 * operator judging a clip, or a visitor scanning a rail, sees one frozen frame
 * and cannot tell motion from a photograph. These four attributes are what make
 * a silent inline video actually start:
 *
 *   autoPlay + muted — browsers block autoplay WITH SOUND, and only with sound.
 *                      Muted is therefore not decoration here; it is the
 *                      permission that lets autoplay happen at all.
 *   loop             — a two-second clip that plays once and freezes reads as
 *                      broken, and freezes on a frame nobody chose.
 *   playsInline      — without it iOS Safari takes the video FULL SCREEN on
 *                      play, so a thumbnail would hijack the page.
 *
 * One constant rather than nine copies, so the set cannot drift between the
 * surfaces that render a preview. Deliberately NOT used for chat media, which
 * carries `controls` because a clip a character sent is watched on purpose
 * rather than glanced at.
 */
export const TILE_VIDEO_PLAYBACK = {
  autoPlay: true,
  muted: true,
  loop: true,
  playsInline: true,
} as const;
