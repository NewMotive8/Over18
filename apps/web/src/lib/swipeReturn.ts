/**
 * Coming back to Swipe mode where you left it.
 *
 * THE PROBLEM. Opening a character from Swipe and pressing Back used to drop
 * the visitor on Home: the profile's Back was hard-wired to the lobby, and the
 * deck kept its place only in component state, so even the browser's own Back
 * button returned to card 1.
 *
 * TWO SMALL PIECES FIX IT, and neither touches the gate or the deck's rules:
 *
 *  1. WHERE BACK GOES. Swipe opens a profile with `{ from: SWIPE_PATH }` in the
 *     navigation state. The profile's Back reads it through `cameFromSwipe` --
 *     an exact match against one fixed path, never a URL taken from state -- and
 *     steps back one history entry, to the Swipe screen it came from. Anything
 *     else keeps the existing behaviour (Home).
 *
 *  2. WHICH CARD. The deck's place is remembered per HISTORY ENTRY (the
 *     router's `location.key`), in sessionStorage. Returning to that entry --
 *     by the profile's Back or the browser's -- restores the card. A fresh
 *     visit to Swipe is a new entry with a new key, so it starts at the first
 *     card exactly as before.
 */

export const SWIPE_PATH = '/discover/swipe';

/** True only for the exact state Swipe sets when it opens a profile. */
export function cameFromSwipe(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { from?: unknown }).from === SWIPE_PATH;
}

const PREFIX = 'over18.swipe.position.';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SwipePosition {
  index: number;
  /** The character on that card, so a changed list cannot land on somebody else. */
  characterId: string;
}

/** The deck's remembered place for one history entry. */
export const swipePosition = {
  read(entryKey: string): SwipePosition | null {
    try {
      const value: unknown = JSON.parse(globalThis.sessionStorage?.getItem(PREFIX + entryKey) ?? 'null');
      if (typeof value !== 'object' || value === null) return null;
      const { index, characterId } = value as Partial<SwipePosition>;
      return Number.isInteger(index) && (index as number) >= 0 && typeof characterId === 'string' && ID.test(characterId)
        ? { index: index as number, characterId }
        : null;
    } catch {
      return null;
    }
  },
  write(entryKey: string, position: SwipePosition): void {
    try {
      globalThis.sessionStorage?.setItem(PREFIX + entryKey, JSON.stringify(position));
    } catch {
      /* storage refused: the deck simply starts from the first card next time */
    }
  },
};

/**
 * Where the deck should be, given what was remembered and the list as it is
 * now. The remembered index is used only while it still holds the remembered
 * character; if the list changed, she is found by id; if she is gone, the deck
 * starts from the first card. Never an index past the end.
 */
export function resolveSwipeIndex(remembered: SwipePosition | null, characterIds: readonly string[]): number {
  if (!remembered) return 0;
  if (characterIds[remembered.index] === remembered.characterId) return remembered.index;
  const found = characterIds.indexOf(remembered.characterId);
  return found >= 0 ? found : 0;
}
