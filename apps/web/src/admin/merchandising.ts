import type { AddOutcome, CandidateAssetView, CategoryAssetView } from '../lib/api';

/**
 * Merchandising workspace logic (US-102.2) — React-free, like categoryBoard.
 *
 * The workspace is two thumbnail grids and a lot of selection state, and
 * selection state is where this kind of screen goes wrong: a range-select that
 * includes an item the picker has since filtered out, a "remove 12 items"
 * button that acts on a stale set, a bulk result that reports success for
 * assets the server refused. All of that is decided here, over plain arrays,
 * where the node-only web test environment can reach it.
 *
 * Ordering primitives are NOT redefined here — moveItem / moveBy / canMove /
 * sameOrder / reconcileOrder in categoryBoard.ts are generic over `{ id }` and
 * are reused via `withId` below, so the two workspaces cannot drift apart.
 */

/** Adapts an asset-keyed row to the `{ id }` shape the ordering helpers take. */
export function withId<T extends { assetId: string }>(item: T): T & { id: string } {
  return { ...item, id: item.assetId };
}

export function withIds<T extends { assetId: string }>(items: readonly T[]): Array<T & { id: string }> {
  return items.map(withId);
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

/** Toggles one id in a selection, returning a new set. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Shift-click range selection.
 *
 * `visible` is the list AS DISPLAYED, so a range never reaches across items the
 * current filter has hidden — selecting "everything between these two tiles"
 * must mean what the operator can actually see.
 */
export function selectRange(
  selected: ReadonlySet<string>,
  visible: readonly string[],
  anchorId: string | null,
  targetId: string,
): Set<string> {
  const next = new Set(selected);
  const to = visible.indexOf(targetId);
  const from = anchorId === null ? -1 : visible.indexOf(anchorId);
  if (to === -1 || from === -1) {
    next.add(targetId);
    return next;
  }
  const [start, end] = from <= to ? [from, to] : [to, from];
  for (let index = start; index <= end; index++) {
    const id = visible[index];
    if (id) next.add(id);
  }
  return next;
}

/**
 * Drops anything no longer visible from a selection.
 *
 * Called whenever the picker's filters change. Without it, "Add 12 items" can
 * quietly include assets the operator filtered away and can no longer see —
 * the selection has to mean what is on screen.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  visible: readonly string[],
): Set<string> {
  const allowed = new Set(visible);
  const next = new Set<string>();
  for (const id of selected) if (allowed.has(id)) next.add(id);
  return next;
}

export function selectAll(visible: readonly string[]): Set<string> {
  return new Set(visible);
}

/* ------------------------------------------------------------------ *
 * Reporting what a bulk add actually did
 * ------------------------------------------------------------------ */

export interface AddSummary {
  added: number;
  alreadyPresent: number;
  notApproved: number;
  missing: number;
  /**
   * Refused because the app could not render them even though they are
   * approved — a retired character, a non-content kind, or no file.
   */
  notRenderable: number;
  /** One sentence for the banner. Never claims more than happened. */
  message: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Turns per-asset outcomes into one honest sentence.
 *
 * A bulk add is allowed to partially succeed, so the summary must never round
 * "17 of 20" up to "added". Refusals are named by cause, because "3 items were
 * not added" is useless and "3 are still awaiting review" is actionable.
 */
export function summariseAdd(outcomes: readonly AddOutcome[]): AddSummary {
  const added = outcomes.filter((o) => o.added).length;
  const alreadyPresent = outcomes.filter((o) => o.reason === 'already_present').length;
  const notApproved = outcomes.filter((o) => o.reason === 'not_approved').length;
  const missing = outcomes.filter((o) => o.reason === 'not_found').length;
  /**
   * The three refusals that are NOT about approval, counted together.
   *
   * Named as one line because the operator's next action is the same for all
   * three — the item cannot go in this category as things stand — while the
   * per-item cause is already on the tile. Splitting the banner three ways
   * would bury the number that matters.
   */
  const notRenderable = outcomes.filter(
    (o) =>
      o.reason === 'character_inactive' || o.reason === 'no_media' || o.reason === 'not_content',
  ).length;

  const parts: string[] = [];
  parts.push(added === 0 ? 'Nothing added' : `Added ${plural(added, 'item', 'items')}`);
  if (alreadyPresent > 0) parts.push(`${plural(alreadyPresent, 'item', 'items')} already here`);
  if (notApproved > 0) {
    parts.push(`${plural(notApproved, 'item is', 'items are')} not approved and cannot be published`);
  }
  if (notRenderable > 0) {
    parts.push(
      `${plural(notRenderable, 'item', 'items')} the app cannot show, so ${notRenderable === 1 ? 'it was' : 'they were'} not added`,
    );
  }
  if (missing > 0) parts.push(`${plural(missing, 'item', 'items')} no longer exists`);

  return {
    added,
    alreadyPresent,
    notApproved,
    missing,
    notRenderable,
    message: `${parts.join(' · ')}.`,
  };
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

/**
 * What the app would actually show for this category: approved content only.
 *
 * The server already filters its public read; this is the same rule applied to
 * the admin list so the preview pane cannot show something the app would not.
 * Two independent enforcements of one rule, deliberately.
 */
export function publishableOnly(assets: readonly CategoryAssetView[]): CategoryAssetView[] {
  return assets.filter((asset) => asset.publishable);
}

/** Items whose assignment survives but which have stopped being publishable. */
export function blockedItems(assets: readonly CategoryAssetView[]): CategoryAssetView[] {
  return assets.filter((asset) => !asset.publishable);
}

/**
 * Why an assigned item is not currently publishable, in the operator's words.
 *
 * Deliberately explains that the assignment is intact and will come back — the
 * item is not lost, and the fix named in each sentence restores it with no
 * action here.
 *
 * IT READS THE SERVER'S REASON FIRST. This used to switch on `status` alone,
 * which silently assumed approval was the only way to be unpublishable. Once
 * the API started applying the rail's full rule, an approved clip whose
 * character had been retired arrived here as "not publishable" with a status of
 * `approved`, and the old default answered "Not approved (approved)" — a
 * sentence that is both wrong and impossible to act on.
 *
 * The `status` switch is kept as the fallback for `not_approved`, because
 * WHICH non-approved state an item is in changes what the operator does about
 * it, and only this side knows those state names.
 */
export function blockedReason(asset: CategoryAssetView): string {
  switch (asset.ineligibleReason) {
    case 'character_inactive':
      // Covers BOTH directions of the same flag: a character who has not been
      // published yet, and one who has been retired. The sentence names the
      // action rather than guessing which of the two happened.
      return 'Her character is not published, so the app hides all of her content. Still assigned — publishing the character brings it back.';
    case 'no_media':
      return 'This item has no media file, so there is nothing for the app to show. Still assigned — re-uploading the file brings it back.';
    case 'not_content':
      return 'This is not a content clip, so it cannot appear in a category. Still assigned — remove it here, and manage identity images under Visual identity.';
    case 'not_approved':
    default:
      break;
  }
  switch (asset.status) {
    case 'rejected':
      return 'Rejected in Review, so it is hidden from the app. Still assigned — approving it again brings it back.';
    case 'under_review':
    case 'generated':
      return 'Waiting on Review, so it is hidden from the app. Still assigned — approving it brings it back.';
    default:
      return `Not approved (${asset.status}), so it is hidden from the app. Still assigned.`;
  }
}

/**
 * The warning a PICKER tile carries, or null when it has none.
 *
 * A candidate can be perfectly assignable and still not renderable — an
 * unpublished character's clips are offered on purpose, because merchandising
 * her before publishing her is the intended journey. Saying so on the tile is
 * what stops the operator adding five and finding one on Home.
 */
export function candidateWarning(candidate: CandidateAssetView): string | null {
  if (candidate.ineligibleReason !== 'character_inactive') return null;
  return 'Her character is not published yet — this will not appear on Home until she is.';
}

export interface MerchandisingSummary {
  assigned: number;
  publishable: number;
  blocked: number;
  featured: number;
  images: number;
  videos: number;
}

export function summarise(assets: readonly CategoryAssetView[]): MerchandisingSummary {
  const publishable = publishableOnly(assets);
  return {
    assigned: assets.length,
    publishable: publishable.length,
    blocked: assets.length - publishable.length,
    featured: assets.filter((asset) => asset.featured).length,
    images: publishable.filter((asset) => asset.mediaType === 'image').length,
    videos: publishable.filter((asset) => asset.mediaType === 'video').length,
  };
}

/** Short caption under a candidate tile: where else this asset is used. */
export function membershipLabel(candidate: CandidateAssetView): string {
  if (candidate.inThisCategory) return 'Already in this category';
  if (candidate.categoryCount === 0) return 'Not in any category yet';
  return candidate.categoryCount === 1 ? 'In 1 other category' : `In ${candidate.categoryCount} other categories`;
}

/**
 * The sentence shown before removing items.
 *
 * States what removal does AND what it does not, because the whole rule this
 * ticket has to hold is that removing from a category never touches the
 * Library asset.
 */
export function removalMessage(count: number): string {
  const items = plural(count, 'item', 'items');
  return `${items} will be removed from this category. Nothing is deleted, rejected or changed in the Library — ${
    count === 1 ? 'it stays' : 'they stay'
  } approved and available to every other category.`;
}
