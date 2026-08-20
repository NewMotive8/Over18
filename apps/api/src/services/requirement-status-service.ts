import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { characters, characterVisualAssets, type CharacterVisualAssetRow } from '../db/schema.js';
import { mediaTypeOf, type MediaType } from './content-review-service.js';
import {
  listEnabledContentRequirements,
  type ContentRequirement,
} from './content-requirements-service.js';

/**
 * What a character NEEDS, HAS and LACKS — derived, never stored.
 *
 * Everything here is computed at read time from two inputs: the configured
 * requirements and the character's actual assets. There is not a single
 * counter, cached total or slot record in the database, which is what makes
 * the product rules true by construction rather than by discipline:
 *
 *   - changing a requirement never deletes, rewrites or regenerates content;
 *   - existing qualifying content immediately counts toward a changed
 *     requirement, because matching happens now, not at write time;
 *   - raising a quantity creates missing capacity, lowering one leaves surplus
 *     content in place;
 *   - Review and the generation planner cannot disagree, because they call
 *     this same function.
 */

/** Statuses that still need a human decision — the same set Review uses. */
const PENDING = ['generated', 'under_review'] as const;

export interface RequirementAsset extends CharacterVisualAssetRow {
  mediaType: MediaType;
}

/**
 * Why an asset is not counting toward anything. Surfaced so "why doesn't this
 * count?" is answerable on screen instead of being invisible.
 */
export type TriageReason = 'uncategorised' | 'unknown_requirement' | 'media_mismatch';

export interface TriageAsset extends RequirementAsset {
  reason: TriageReason;
}

export interface RequirementStatusEntry {
  requirement: ContentRequirement;
  /** The configured quantity. The UI renders this many capacity slots. */
  required: number;
  approved: number;
  pending: number;
  /** What still has to be produced: max(0, required - approved). */
  remaining: number;
  /** Approved beyond the requirement. Never hidden, never deleted. */
  surplus: number;
  satisfied: boolean;
  /** Approved first, then pending; creation order within each. */
  assets: RequirementAsset[];
}

export interface CharacterRequirementStatus {
  characterId: string;
  entries: RequirementStatusEntry[];
  /** Assets counting toward nothing, each with the reason why. */
  triage: TriageAsset[];
  totals: {
    required: number;
    approved: number;
    pending: number;
    missing: number;
    complete: boolean;
  };
}

/**
 * Does this asset count toward this requirement?
 *
 * Deliberately NOT part of the rule:
 *  - `kind`: a primary REFERENCE image can satisfy an image requirement.
 *    Category is a production role; reference-vs-generated is origin.
 *  - `contentRating`: the requirement's rating is ADVISORY. A hidden rating
 *    filter would silently stop content counting with nothing on screen to
 *    explain it — and it would collide with video rating inheritance, where a
 *    null rating legitimately means "inherit from the source still".
 *  - `isCanonical` / `position`: gallery concerns, unrelated.
 */
function qualifies(asset: RequirementAsset, requirement: ContentRequirement): boolean {
  return (
    asset.requirementKey === requirement.key &&
    asset.mediaType === requirement.mediaType &&
    asset.status !== 'rejected'
  );
}

const isApproved = (a: RequirementAsset) => a.status === 'approved';
const isPending = (a: RequirementAsset) => (PENDING as readonly string[]).includes(a.status);

/** Approved first (they fill the slots), then pending; stable within each. */
function boardOrder(assets: RequirementAsset[]): RequirementAsset[] {
  return [...assets].sort((a, b) => {
    const rank = (x: RequirementAsset) => (isApproved(x) ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const at = a.createdAt.getTime();
    const bt = b.createdAt.getTime();
    return at !== bt ? at - bt : a.id.localeCompare(b.id);
  });
}

/** Pure: the whole calculation, given the two inputs. Exported for testing. */
export function computeRequirementStatus(
  characterId: string,
  requirements: readonly ContentRequirement[],
  assets: readonly RequirementAsset[],
): CharacterRequirementStatus {
  const live = assets.filter((a) => a.status !== 'rejected');
  const byKey = new Map(requirements.map((r) => [r.key, r] as const));

  const entries: RequirementStatusEntry[] = requirements.map((requirement) => {
    const matching = boardOrder(live.filter((a) => qualifies(a, requirement)));
    const approved = matching.filter(isApproved).length;
    const pending = matching.filter(isPending).length;
    return {
      requirement,
      required: requirement.requiredQuantity,
      approved,
      pending,
      remaining: Math.max(0, requirement.requiredQuantity - approved),
      surplus: Math.max(0, approved - requirement.requiredQuantity),
      satisfied: approved >= requirement.requiredQuantity,
      assets: matching,
    };
  });

  const counted = new Set(entries.flatMap((e) => e.assets.map((a) => a.id)));
  const triage: TriageAsset[] = live
    .filter((a) => !counted.has(a.id))
    .map((asset) => {
      const requirement = asset.requirementKey ? byKey.get(asset.requirementKey) : undefined;
      const reason: TriageReason = !asset.requirementKey
        ? 'uncategorised'
        : // A key with no ENABLED requirement behind it: the requirement was
          // disabled or removed. The asset keeps its key and returns to the
          // board untouched if that requirement comes back.
          !requirement
          ? 'unknown_requirement'
          : 'media_mismatch';
      return { ...asset, reason };
    });

  const required = entries.reduce((n, e) => n + e.required, 0);
  // Capped per requirement, so surplus in one category can never mask a
  // shortfall in another — 12 selfies must not read as "complete".
  const approved = entries.reduce((n, e) => n + Math.min(e.approved, e.required), 0);
  const pending = entries.reduce((n, e) => n + e.pending, 0);

  return {
    characterId,
    entries,
    triage,
    totals: {
      required,
      approved,
      pending,
      missing: entries.reduce((n, e) => n + e.remaining, 0),
      complete: entries.every((e) => e.satisfied),
    },
  };
}

/** Every asset of one character, with its media type resolved once. */
async function loadAssets(db: Db, characterId: string): Promise<RequirementAsset[]> {
  const rows = await db
    .select()
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.characterId, characterId))
    .orderBy(asc(characterVisualAssets.createdAt), asc(characterVisualAssets.id));
  return rows.map((row) => ({ ...row, mediaType: mediaTypeOf(row.storageKey, row.provenance) }));
}

export async function getRequirementStatus(
  db: Db,
  characterId: string,
): Promise<CharacterRequirementStatus> {
  const [requirements, assets] = await Promise.all([
    listEnabledContentRequirements(db),
    loadAssets(db, characterId),
  ]);
  return computeRequirementStatus(characterId, requirements, assets);
}

export interface CharacterProgress {
  characterId: string;
  characterName: string;
  displayName: string;
  required: number;
  approved: number;
  pending: number;
  missing: number;
  complete: boolean;
}

/**
 * The Review rail: every character with its progress. One requirements read and
 * one asset read for the whole list, rather than N queries per character.
 */
export async function summariseRequirementProgress(db: Db): Promise<CharacterProgress[]> {
  const requirements = await listEnabledContentRequirements(db);
  const characterRows = await db
    .select({ id: characters.id, name: characters.name, displayName: characters.displayName })
    .from(characters)
    .orderBy(asc(characters.displayName), asc(characters.id));
  if (characterRows.length === 0) return [];

  const assetRows = await db
    .select()
    .from(characterVisualAssets)
    .where(
      inArray(
        characterVisualAssets.characterId,
        characterRows.map((c) => c.id),
      ),
    );

  const grouped = new Map<string, RequirementAsset[]>();
  for (const row of assetRows) {
    const list = grouped.get(row.characterId) ?? [];
    list.push({ ...row, mediaType: mediaTypeOf(row.storageKey, row.provenance) });
    grouped.set(row.characterId, list);
  }

  return characterRows.map((character) => {
    const status = computeRequirementStatus(
      character.id,
      requirements,
      grouped.get(character.id) ?? [],
    );
    return {
      characterId: character.id,
      characterName: character.name,
      displayName: character.displayName,
      required: status.totals.required,
      approved: status.totals.approved,
      pending: status.totals.pending,
      missing: status.totals.missing,
      complete: status.totals.complete,
    };
  });
}

export interface MissingContentPlanItem {
  requirementKey: string;
  label: string;
  mediaType: MediaType;
  /** How many still have to be produced. */
  quantity: number;
  /** Advisory rating for the job, straight from the requirement. */
  contentRating: 'sfw' | 'explicit' | null;
  /**
   * Video generation is image-to-video and needs an approved still to animate.
   * The planner REPORTS that rather than choosing one: silently picking a
   * source image is how identity drift gets in.
   */
  needsSourceImage: boolean;
}

/**
 * "What is missing?" — the function the Generation Studio and any future
 * automation call. Pure, so it can be reasoned about and tested without a
 * database, and derived from the same status Review renders, so a planner and
 * the board can never disagree.
 *
 * Pending content is deliberately NOT subtracted: something awaiting review may
 * still be rejected, so treating it as done would under-generate. Callers that
 * want to wait for the queue can read `pending` from the status.
 */
export function planMissingContent(
  status: CharacterRequirementStatus,
): MissingContentPlanItem[] {
  return status.entries
    .filter((entry) => entry.remaining > 0)
    .map((entry) => ({
      requirementKey: entry.requirement.key,
      label: entry.requirement.label,
      mediaType: entry.requirement.mediaType,
      quantity: entry.remaining,
      contentRating: entry.requirement.contentRating,
      needsSourceImage: entry.requirement.mediaType === 'video',
    }));
}

export async function planMissingContentFor(
  db: Db,
  characterId: string,
): Promise<MissingContentPlanItem[]> {
  return planMissingContent(await getRequirementStatus(db, characterId));
}
