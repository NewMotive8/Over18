import type { CharacterContentAsset } from '../lib/api';

/**
 * A character's content shelf — presentation logic, React-free.
 *
 * WHY THIS EXISTS. Everything here was already reachable, but only from four
 * different screens and none of them the character's own: Review knew her
 * pending items, the Library her approved ones, the merchandising screens her
 * category membership and the Home composer her Hero clips. "What content does
 * Maria have?" had no single answer. This is only the arrangement and wording
 * of the answer the server now assembles.
 *
 * React-free because this repo's web tests run in node with no DOM, and a shelf
 * that silently groups an item into the wrong bucket is exactly the kind of bug
 * a static render cannot catch.
 */

/** The buckets the shelf renders, in the order an operator reads them. */
export interface ContentShelf {
  /** Approved canonical references — the character's primary set. */
  primary: CharacterContentAsset[];
  /** Approved content that is not a primary reference. */
  approved: CharacterContentAsset[];
  /** Awaiting an approve/reject decision in Review. */
  pending: CharacterContentAsset[];
  /** Rejected. Shown rather than hidden, so nothing appears to have vanished. */
  rejected: CharacterContentAsset[];
}

const PENDING_STATUSES = new Set(['generated', 'under_review']);

/**
 * Splits the shelf.
 *
 * The buckets are mutually exclusive and cover every asset — an item cannot be
 * counted twice, and none can fall through and appear nowhere. That total is
 * what makes the section trustworthy as an answer to "is this everything?".
 */
export function groupCharacterContent(
  assets: readonly CharacterContentAsset[],
): ContentShelf {
  const shelf: ContentShelf = { primary: [], approved: [], pending: [], rejected: [] };
  for (const asset of assets) {
    if (asset.status === 'rejected') shelf.rejected.push(asset);
    else if (PENDING_STATUSES.has(asset.status)) shelf.pending.push(asset);
    else if (asset.isPrimary) shelf.primary.push(asset);
    else shelf.approved.push(asset);
  }
  return shelf;
}

/** Operator-facing status wording. Never an upstream term like "generated". */
export function statusLabel(asset: CharacterContentAsset): string {
  switch (asset.status) {
    case 'approved':
      return asset.isPrimary ? 'Primary reference' : 'Approved';
    case 'rejected':
      return 'Rejected';
    default:
      return 'In review';
  }
}

/**
 * Where this item currently appears, in one line.
 *
 * States placement plainly because approved is NOT the same as visible: an
 * approved clip reaches the public app only through the Hero, a published
 * category, or a discovery keyword. An operator who cannot see that difference
 * assumes approval was the last step.
 */
export function placementLabel(asset: CharacterContentAsset): string {
  const parts: string[] = [];
  if (asset.placement.heroPosition !== null) {
    parts.push(`Hero #${asset.placement.heroPosition + 1}`);
  }
  for (const category of asset.placement.categories) {
    parts.push(`${category.name} #${category.position + 1}`);
  }
  if (parts.length > 0) return parts.join(' · ');
  return asset.status === 'approved' ? 'Approved, not placed anywhere yet' : 'Not placed';
}

/** True when this item is approved but reaches no public surface. */
export function isUnplaced(asset: CharacterContentAsset): boolean {
  return (
    asset.status === 'approved' &&
    !asset.isPrimary &&
    asset.placement.heroPosition === null &&
    asset.placement.categories.length === 0
  );
}

/** "12 items · 8 approved · 3 in review · 1 rejected" — the shelf in one line. */
export function shelfSummary(shelf: ContentShelf): string {
  const total =
    shelf.primary.length + shelf.approved.length + shelf.pending.length + shelf.rejected.length;
  if (total === 0) return 'No content yet';
  const parts = [`${total} item${total === 1 ? '' : 's'}`];
  const approved = shelf.primary.length + shelf.approved.length;
  if (approved > 0) parts.push(`${approved} approved`);
  if (shelf.pending.length > 0) parts.push(`${shelf.pending.length} in review`);
  if (shelf.rejected.length > 0) parts.push(`${shelf.rejected.length} rejected`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * What can an operator DO with one item, from here?
 *
 * The shelf could already answer "what content does she have?" but not "and
 * now what?" — approving meant Review, categorising meant the merchandising
 * screen, the Hero meant the Home composer. Every one of those endpoints
 * already existed; only the character's own page could not reach them.
 *
 * These rules decide which controls an item offers. They live here rather than
 * in the tile because the rule is the thing worth testing: offering Approve on
 * something already approved, or "Add to Hero" on something that is not, is a
 * button whose only effect is an error message.
 * ------------------------------------------------------------------ */

export interface AssetActions {
  /** Awaiting a decision: Approve and Reject apply. */
  canApprove: boolean;
  canReject: boolean;
  /** Approved: it may be placed on a public surface. */
  canAddToCategory: boolean;
  canAddToHero: boolean;
  /** Already in the Hero, so adding again would do nothing. */
  inHero: boolean;
}

/**
 * The controls one item offers.
 *
 * Mirrors the SERVER'S rules rather than inventing gentler ones: Review accepts
 * approve/reject only on an undecided item, and both the category picker and
 * the Hero accept approved content only. A rejected item offers nothing here —
 * re-approving is a Review decision, and this page is not a second Review.
 */
export function assetActions(asset: CharacterContentAsset): AssetActions {
  const pending = PENDING_STATUSES.has(asset.status);
  const approved = asset.status === 'approved';
  const inHero = asset.placement.heroPosition !== null;
  return {
    canApprove: pending,
    canReject: pending,
    canAddToCategory: approved,
    canAddToHero: approved && !inHero,
    inHero,
  };
}

/** The categories this item is NOT in yet — the only ones worth offering. */
export function categoryChoices(
  asset: CharacterContentAsset,
  categories: readonly { id: string; name: string }[],
): { id: string; name: string }[] {
  const already = new Set(asset.placement.categories.map((c) => c.id));
  return categories.filter((category) => !already.has(category.id));
}

/**
 * What approving will and will NOT do, said before the operator commits.
 *
 * The failure this prevents is the common one: approving and assuming the item
 * is now on the app. It is not — approval clears it for use, placement makes it
 * visible, and publishing the character is a third, separate thing.
 */
export function approveConsequence(characterIsLive: boolean): string {
  return characterIsLive
    ? 'Approving clears it for use. It appears on the app only once it is in the Hero or a published category.'
    : 'Approving clears it for use. Nothing of hers is public until she is published.';
}

/* ------------------------------------------------------------------ *
 * Per-clip keywords
 *
 * REUSES THE EXISTING KEYWORD SYSTEM AND ADDS NOTHING TO IT. The server
 * already stores tags in `asset_keywords`, and one endpoint —
 * `PUT /admin/discovery/content/:assetId/keywords` — REPLACES the whole set
 * for one asset. Add, remove and edit are therefore all the same operation on
 * the client: build the next set, send it once, for that asset only.
 *
 * These helpers exist so the draft-set arithmetic is testable. Getting it
 * wrong is silent and destructive — a botched "remove" sends a set that drops
 * keywords the operator never touched.
 * ------------------------------------------------------------------ */

/**
 * Normalises one typed keyword the way the operator means it.
 *
 * Trims and collapses inner whitespace, and lowercases — the server keys
 * keywords canonically, so "Beach" and "beach " must not read as two tags in
 * the editor when they will be one in the database.
 */
export function normaliseKeyword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Accepts one entry, or several separated by commas.
 *
 * Operators paste comma-separated lists; refusing them means retyping. Empty
 * and duplicate entries are dropped rather than rejected, because neither is a
 * mistake worth an error message.
 */
export function addKeywords(current: readonly string[], input: string): string[] {
  const next = [...current];
  for (const part of input.split(',')) {
    const keyword = normaliseKeyword(part);
    if (keyword.length > 0 && !next.includes(keyword)) next.push(keyword);
  }
  return next;
}

/** Removes exactly one keyword. Every other keyword survives untouched. */
export function removeKeyword(current: readonly string[], keyword: string): string[] {
  const target = normaliseKeyword(keyword);
  return current.filter((k) => normaliseKeyword(k) !== target);
}

/**
 * Whether the draft differs from what is saved — order-insensitively.
 *
 * Order carries no meaning in a keyword set, so a reordering is not an unsaved
 * change and must not light up the Save button.
 */
export function keywordsDiffer(saved: readonly string[], draft: readonly string[]): boolean {
  if (saved.length !== draft.length) return true;
  const a = [...saved].map(normaliseKeyword).sort();
  const b = [...draft].map(normaliseKeyword).sort();
  return a.some((keyword, index) => keyword !== b[index]);
}

/* ------------------------------------------------------------------ *
 * Is she live, and if not, what is missing?
 *
 * A name-only character is created INACTIVE on purpose — nothing half-written
 * reaches real users until someone says so, and that rule is not relaxed here.
 * What was missing is the explanation: the operator saw a character that
 * existed, was not public, and gave no indication of why or what to do. State
 * the three facts plainly instead.
 * ------------------------------------------------------------------ */

export interface CharacterReadiness {
  live: boolean;
  /** What is true right now, in one line. */
  headline: string;
  /** The single next action, or null when she is already live. */
  nextStep: string | null;
  /** True while content management is available regardless of being unpublished. */
  contentAllowed: boolean;
}

export function characterReadiness(character: {
  status: string;
  profileComplete: boolean;
}): CharacterReadiness {
  if (character.status === 'active') {
    return {
      live: true,
      headline: 'Live — visitors can find her.',
      nextStep: null,
      contentAllowed: true,
    };
  }
  return {
    live: false,
    headline: 'She exists, but is not published — nobody can see her yet.',
    // The publish button is gated on the profile, so name the gate rather than
    // leaving a disabled control unexplained.
    nextStep: character.profileComplete
      ? 'Press Publish to make her public.'
      : 'Write her profile — or use Autofill — then press Publish.',
    // UPLOADING IS NOT GATED ON PUBLISHING. Content can be built up while she
    // is unpublished, which is the whole point of creating her by name first.
    contentAllowed: true,
  };
}
