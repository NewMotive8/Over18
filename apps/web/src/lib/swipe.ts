/**
 * Pure swipe-decision logic (US-19), split out of the gesture component so the
 * "did this drag commit, and in which direction" rule is deterministic and
 * unit-testable without simulating pointer events or a DOM.
 *
 *   swipe left  → 'pass'
 *   swipe right → 'like'
 */

export type SwipeDecision = 'like' | 'pass';

/** Fraction of the card width a horizontal drag must exceed to commit. */
export const COMMIT_RATIO = 0.28;

/** Absolute floor (px) so tiny cards still need a deliberate drag to commit. */
export const COMMIT_MIN_PX = 72;

/** Movement (px) below which a pointer interaction is treated as a tap, not a drag. */
export const TAP_SLOP_PX = 8;

/** The distance a horizontal drag must pass to commit, for a given card width. */
export function commitThreshold(width: number): number {
  return Math.max(COMMIT_MIN_PX, width * COMMIT_RATIO);
}

/**
 * Decision for a horizontal drag of `dx` px on a card `width` px wide:
 * 'like' past the right threshold, 'pass' past the left, null otherwise.
 */
export function swipeDecisionFor(dx: number, width: number): SwipeDecision | null {
  const threshold = commitThreshold(width);
  if (dx >= threshold) return 'like';
  if (dx <= -threshold) return 'pass';
  return null;
}

/** 0..1 progress toward the commit threshold in the drag's direction (for UI feedback). */
export function swipeProgress(dx: number, width: number): number {
  const threshold = commitThreshold(width);
  if (threshold <= 0) return 0;
  const p = Math.abs(dx) / threshold;
  return p > 1 ? 1 : p;
}
