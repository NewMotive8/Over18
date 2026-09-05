import type { PublicPlayWithMeCard } from './api';
import type { SwipeDecision } from './swipe';

/**
 * The Favourites rules, as pure functions.
 *
 * WHY THEY ARE NOT IN THE COMPONENTS. "Swipe right never removes a favourite"
 * is a product rule, not a rendering detail, and this repo's web tests run in
 * node with no DOM — a rule buried in a click handler could only be checked by
 * reading it. Here it is a function with a truth table, exactly as `swipe.ts`
 * already does for the gesture thresholds.
 *
 * These decide WHAT SHOULD HAPPEN. They issue no request and hold no state; the
 * hook that calls them owns both, and the server owns the truth.
 */

/** What a gesture or a tap should do to the stored relationship. */
export type FavouriteAction = 'add' | 'remove' | 'none';

/**
 * What a completed swipe does to Favourites.
 *
 *   pass (left)                    → none. Passing is not a decision this
 *                                    product records anywhere, and it must
 *                                    never touch a favourite the user already
 *                                    has.
 *   like (right), not favourited   → add.
 *   like (right), already saved    → none. She REMAINS favourited. This arm is
 *                                    the reason the function exists: the
 *                                    obvious implementation of a heart is a
 *                                    toggle, and a toggle here would have made
 *                                    a second right swipe silently un-save her.
 *
 * THERE IS NO INPUT THAT MAKES THIS RETURN 'remove'. Swiping cannot unfavourite
 * anyone; only `heartAction` can, and only from the filled state.
 */
export function swipeAction(decision: SwipeDecision, favourited: boolean): FavouriteAction {
  if (decision === 'pass') return 'none';
  return favourited ? 'none' : 'add';
}

/**
 * What tapping the heart does.
 *
 * Filled → remove, outline → add. This IS a toggle, and it is the only one:
 * tapping the full green heart is the single documented way to drop a favourite
 * from Swipe.
 *
 * The heart does not advance the deck. It changes a stored fact about the
 * character on screen, so the card stays put and the fill flips under the
 * user's thumb — moving on is what the swipe gestures and the pass button are
 * for.
 */
export function heartAction(favourited: boolean): FavouriteAction {
  return favourited ? 'remove' : 'add';
}

/**
 * The heart's appearance, from the PERSISTED state and nothing else.
 *
 * Named rather than inlined so a test can assert the mapping without a DOM, and
 * so there is one place that could ever be wrong. `outline` is green stroke on
 * no fill; `filled` is solid green. There is no third state and no animation
 * state: the fill is a readout of the database, not feedback for a tap.
 */
export function heartState(favourited: boolean): 'filled' | 'outline' {
  return favourited ? 'filled' : 'outline';
}

/** The set after applying an action — the optimistic view the hook renders. */
export function applyAction(
  favourited: ReadonlySet<string>,
  characterId: string,
  action: FavouriteAction,
): Set<string> {
  const next = new Set(favourited);
  if (action === 'add') next.add(characterId);
  if (action === 'remove') next.delete(characterId);
  return next;
}

/**
 * The cards the Favourites gallery may actually render.
 *
 * A SAVED CHARACTER WITH NO CURRENT CLIP PRODUCES NO TILE. She is still
 * favourited — the server still returns her, her heart is still filled, and she
 * reappears here the moment eligible content does — but a gallery card claiming
 * she has something to show, wearing a portrait or a letter, would be the exact
 * dishonesty this feature was built to remove.
 *
 * THE SAME PREDICATE THE SERVER APPLIES (`isEligibleCard`), restated at the
 * render boundary as a second lock. It is not the primary defence: the server
 * already refuses to put a non-video or unreachable asset in `clip`. It is here
 * so that no future payload change can put a tile back that the rail would
 * have dropped.
 */
export function galleryCards(
  cards: readonly PublicPlayWithMeCard[],
): PublicPlayWithMeCard[] {
  return cards.filter((card) => card.clip !== null && card.clip.mediaType === 'video');
}
