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
