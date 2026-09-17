import type { Db } from '../db/client.js';
import type { AdminCharacter, ProfileField } from './character-service.js';
import {
  getRequirementStatus,
  type CharacterRequirementStatus,
} from './requirement-status-service.js';

/**
 * Character READINESS and PUBLISHABILITY -- the two authoritative answers.
 *
 * They are deliberately separate, because they answer different questions and
 * have different consequences:
 *
 *   READINESS       "Is the production work done?" Has she got the content the
 *                   configured requirements ask for, on an identity that is
 *                   actually in use? An operator's to-do list.
 *
 *   PUBLISHABILITY  "May she be shown to users right now?" Is she live, is her
 *                   persona written, does she have an approved identity image to
 *                   be recognised by? A gate on user-facing exposure.
 *
 * A character can be publishable without being ready: raising a content
 * requirement in Settings must not retroactively make every live character
 * ineligible to be seen. And she can be ready without being publishable: all
 * her content can be finished while she is still offline.
 *
 * NEITHER IS DISTRIBUTION. Being publishable does not put her on her Posts tab,
 * on Home, in a category or in Discovery. Those remain explicit operator
 * decisions (publication and placement), and neither calculation looks at them.
 *
 * DERIVED, NEVER STORED. Both are computed from existing state on every read,
 * the same rule `requirement-status-service` follows, so they cannot drift from
 * what they describe and a Settings change is reflected immediately.
 *
 * REUSED, NOT REIMPLEMENTED:
 *   - content requirements   -> `getRequirementStatus`, the function Review and
 *                               the generation planner already share;
 *   - profile completeness   -> `missingProfileFields`, via `AdminCharacter`;
 *   - active identity        -> the one-active-version rule of visual identity;
 *   - primary references     -> `listCanonicalReferences` (approved, canonical
 *                               reference assets of the active identity).
 * This module only combines them.
 */

/* ------------------------------------------------------------------ *
 * Blockers
 * ------------------------------------------------------------------ */

export type ReadinessBlocker =
  | { code: 'no_active_visual_identity'; message: string }
  | { code: 'no_approved_primary_reference'; message: string }
  | {
      code: 'requirement_unmet';
      message: string;
      requirementKey: string;
      label: string;
      mediaType: 'image' | 'video';
      required: number;
      approved: number;
      /** Awaiting review: not counted until approved, but worth saying. */
      pending: number;
      remaining: number;
    };

export type PublishabilityBlocker =
  | { code: 'character_inactive'; message: string }
  | { code: 'profile_incomplete'; message: string; fields: ProfileField[] }
  | { code: 'no_active_visual_identity'; message: string }
  | { code: 'no_approved_primary_reference'; message: string };

export interface ReadinessResult {
  ready: boolean;
  /** Empty exactly when `ready` is true. Ordered: identity first, then content. */
  blockers: ReadinessBlocker[];
  /** The totals the requirement blockers come from, for context. */
  requirements: CharacterRequirementStatus['totals'];
}

export interface PublishabilityResult {
  publishable: boolean;
  /** Empty exactly when `publishable` is true. */
  blockers: PublishabilityBlocker[];
}

export interface CharacterAssessment {
  readiness: ReadinessResult;
  publishability: PublishabilityResult;
}

/* ------------------------------------------------------------------ *
 * The rules -- pure, so every case is testable without a database
 * ------------------------------------------------------------------ */

export interface AssessmentInputs {
  character: Pick<AdminCharacter, 'status' | 'missingProfileFields'>;
  /** The active visual identity version, or null when none is active. */
  activeIdentity: { id: string; version: number } | null;
  /** Approved canonical reference assets of the ACTIVE identity. */
  approvedPrimaryReferenceCount: number;
  requirements: CharacterRequirementStatus;
}

const NO_ACTIVE_IDENTITY = 'She has no active visual identity. Create or activate one.';
const NO_PRIMARY_REFERENCE =
  'Her active visual identity has no approved primary reference image.';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * READY when:
 *   1. she has an active visual identity;
 *   2. that identity has at least one approved primary reference; and
 *   3. every ENABLED content requirement is satisfied by approved content.
 *
 * Content awaiting review does not count (the same rule Review applies) but is
 * reported on the blocker, so "not ready" is not mistaken for "nothing done".
 * With no requirements configured, rule 3 is trivially met: the configuration
 * is the source of truth, and it asks for nothing.
 */
export function computeReadiness(inputs: AssessmentInputs): ReadinessResult {
  const blockers: ReadinessBlocker[] = [];

  if (!inputs.activeIdentity) {
    blockers.push({ code: 'no_active_visual_identity', message: NO_ACTIVE_IDENTITY });
  } else if (inputs.approvedPrimaryReferenceCount === 0) {
    blockers.push({ code: 'no_approved_primary_reference', message: NO_PRIMARY_REFERENCE });
  }

  for (const entry of inputs.requirements.entries) {
    if (entry.satisfied) continue;
    const awaiting = entry.pending > 0 ? `; ${plural(entry.pending, 'item')} awaiting review` : '';
    blockers.push({
      code: 'requirement_unmet',
      message: `${entry.requirement.label}: ${entry.approved} of ${entry.required} approved${awaiting}.`,
      requirementKey: entry.requirement.key,
      label: entry.requirement.label,
      mediaType: entry.requirement.mediaType,
      required: entry.required,
      approved: entry.approved,
      pending: entry.pending,
      remaining: entry.remaining,
    });
  }

  return { ready: blockers.length === 0, blockers, requirements: inputs.requirements.totals };
}

/**
 * PUBLISHABLE when:
 *   1. she is `active` -- the lifecycle state every public surface already
 *      filters on;
 *   2. her profile is complete -- a character with no persona must not reach
 *      users (the reason quick-created characters start inactive);
 *   3. she has an active visual identity; and
 *   4. that identity has at least one approved primary reference -- the image
 *      she is recognised by. An unapproved one is still in moderation.
 *
 * NOT considered, deliberately: content requirements (that is readiness), and
 * whether any content is published to Posts or placed on Home, in a category or
 * in Discovery (that is distribution).
 */
export function computePublishability(inputs: AssessmentInputs): PublishabilityResult {
  const blockers: PublishabilityBlocker[] = [];

  if (inputs.character.status !== 'active') {
    blockers.push({ code: 'character_inactive', message: 'She is not live. Publish her to make her visible.' });
  }
  const missing = inputs.character.missingProfileFields;
  if (missing.length > 0) {
    blockers.push({
      code: 'profile_incomplete',
      message: `Her profile is incomplete: ${plural(missing.length, 'field')} still empty.`,
      fields: [...missing],
    });
  }
  if (!inputs.activeIdentity) {
    blockers.push({ code: 'no_active_visual_identity', message: NO_ACTIVE_IDENTITY });
  } else if (inputs.approvedPrimaryReferenceCount === 0) {
    blockers.push({ code: 'no_approved_primary_reference', message: NO_PRIMARY_REFERENCE });
  }

  return { publishable: blockers.length === 0, blockers };
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

/**
 * Both answers for one character. The caller passes what it has already
 * loaded (the admin detail route loads the character, active identity and
 * primary references anyway); this adds only the requirement status.
 */
export async function assessCharacter(
  db: Db,
  characterId: string,
  loaded: Omit<AssessmentInputs, 'requirements'>,
): Promise<CharacterAssessment> {
  const inputs: AssessmentInputs = { ...loaded, requirements: await getRequirementStatus(db, characterId) };
  return { readiness: computeReadiness(inputs), publishability: computePublishability(inputs) };
}
