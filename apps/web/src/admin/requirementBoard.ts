import type {
  ContentRequirementView,
  RequirementEntryView,
  ReviewAssetView,
  TriageReason,
} from '../lib/api';

/**
 * The Review board's pure logic.
 *
 * Kept out of the component for the same reason the chat timing and scroll
 * state machines are: this is where the rules live, and rules deserve tests
 * that do not need a DOM.
 *
 * The rule that matters most: SLOTS ARE DERIVED. A requirement stores a
 * category and a quantity, never individual slot records, so the board renders
 * `required` capacity slots at read time and lowering a quantity can never
 * orphan or delete anything. Nothing in this file knows a category name or a
 * quantity — both arrive from the server.
 */

export type SlotState = 'approved' | 'pending' | 'empty';

export interface BoardSlot {
  /** Stable within one render, so React keys never collide across requirements. */
  id: string;
  state: SlotState;
  asset: ReviewAssetView | null;
  /** True for approved items beyond the required quantity. Shown, never hidden. */
  surplus: boolean;
}

/**
 * Lays a requirement's assets into its capacity.
 *
 * Approved items fill the slots first (they are what actually satisfies the
 * requirement), then pending ones occupy the remaining capacity so an operator
 * can see the shortfall closing. Anything past capacity is kept and marked as
 * surplus rather than dropped — content is never hidden because a quantity was
 * lowered.
 */
export function buildSlots(entry: RequirementEntryView): BoardSlot[] {
  const approved = entry.assets.filter((a) => a.status === 'approved');
  const pending = entry.assets.filter((a) => a.status !== 'approved');
  const queue = [...approved, ...pending];

  const slots: BoardSlot[] = [];
  for (let i = 0; i < entry.required; i++) {
    const asset = queue[i] ?? null;
    slots.push({
      id: asset ? asset.assetId : `${entry.key}-empty-${i}`,
      state: asset ? (asset.status === 'approved' ? 'approved' : 'pending') : 'empty',
      asset,
      surplus: false,
    });
  }
  for (let i = entry.required; i < queue.length; i++) {
    const asset = queue[i]!;
    const approved = asset.status === 'approved';
    slots.push({
      id: asset.assetId,
      state: approved ? 'approved' : 'pending',
      asset,
      // Only APPROVED content beyond the requirement is surplus. A pending item
      // past capacity may still be rejected, so badging it "extra" would claim
      // the requirement is over-filled while nothing is actually approved.
      surplus: approved,
    });
  }
  return slots;
}

/** "2 / 4", with the awaiting count kept separate so it never inflates progress. */
export function requirementSummary(entry: RequirementEntryView): string {
  const base = `${entry.approved} / ${entry.required}`;
  if (entry.surplus > 0) return `${base} (+${entry.surplus})`;
  return base;
}

/** Groups the board by medium, preserving the configured order within each. */
export function groupByMedia(
  entries: readonly RequirementEntryView[],
): Array<{ mediaType: 'image' | 'video'; label: string; entries: RequirementEntryView[] }> {
  const groups: Array<{ mediaType: 'image' | 'video'; label: string; entries: RequirementEntryView[] }> = [
    { mediaType: 'image', label: 'Images', entries: [] },
    { mediaType: 'video', label: 'Videos', entries: [] },
  ];
  for (const entry of entries) {
    groups.find((g) => g.mediaType === entry.mediaType)?.entries.push(entry);
  }
  return groups.filter((g) => g.entries.length > 0);
}

/** Percentage of the required work that is approved. 100 when nothing is required. */
export function progressPercent(approved: number, required: number): number {
  if (required <= 0) return 100;
  return Math.min(100, Math.round((approved / required) * 100));
}

/** Says why an item counts toward nothing, in words an operator can act on. */
export function triageExplanation(reason: TriageReason): string {
  switch (reason) {
    case 'uncategorised':
      return 'No category yet';
    case 'unknown_requirement':
      return 'Category is no longer configured';
    case 'media_mismatch':
      return "Wrong medium for its category";
  }
}

/** Options for a category picker — always exactly the configured requirements. */
export function categoryOptions(
  requirements: readonly ContentRequirementView[],
  mediaType?: 'image' | 'video',
): Array<{ value: string; label: string }> {
  return requirements
    .filter((r) => !mediaType || r.mediaType === mediaType)
    .map((r) => ({ value: r.key, label: r.label }));
}

/**
 * One line describing the whole configuration, e.g.
 * "Every character needs 10 items — 2 images and 8 videos."
 * Built from the configuration, so it is right by construction.
 */
export function configurationSummary(totals: {
  items: number;
  images: number;
  videos: number;
}): string {
  if (totals.items === 0) return 'No content requirements are configured yet.';
  const parts: string[] = [];
  if (totals.images > 0) parts.push(`${totals.images} image${totals.images === 1 ? '' : 's'}`);
  if (totals.videos > 0) parts.push(`${totals.videos} video${totals.videos === 1 ? '' : 's'}`);
  return `Every character needs ${totals.items} item${totals.items === 1 ? '' : 's'} — ${parts.join(' and ')}.`;
}

/**
 * The consequence of an unsaved quantity change, stated before it is saved.
 *
 * The reassurance is the point: an operator changing a number needs to know it
 * re-plans rather than deletes.
 */
export function impactOf(
  label: string,
  from: number,
  to: number,
  affectedCharacters: number,
): string | null {
  if (from === to) return null;
  const delta = Math.abs(to - from);
  const each = `${delta} ${delta === 1 ? 'item' : 'items'}`;
  if (to > from) {
    return `${affectedCharacters} character${affectedCharacters === 1 ? '' : 's'} would each need ${each} more for ${label}. Nothing existing is affected.`;
  }
  return `${label} drops by ${each}. Existing content is kept — anything over the new number simply counts as surplus.`;
}
