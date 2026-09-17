import type { CharacterVisualAssetRow } from '../db/schema.js';

/**
 * The asset lifecycle model (P0.3) -- one vocabulary for what an asset IS,
 * where it CAME FROM, and where it STANDS, kept deliberately apart.
 *
 *   ROLE      what the asset is used for          <- `kind`
 *   ORIGIN    where it came from                  <- `origin`
 *   WORKFLOW  where it is in moderation           <- `status`
 *
 * And, deliberately NOT here:
 *
 *   DISTRIBUTION  where it is surfaced. `published_at` (Posts) and the
 *                 placement tables (Hero, categories, keywords) own that, and
 *                 approval never implies any of it.
 *   COMMERCIAL    free / paid / locked -- reserved for the economy work.
 *
 * NO FIELD STANDS IN FOR ANOTHER. Role is read from `kind` alone, origin from
 * `origin` alone, workflow from `status` alone. In particular:
 *   - `kind = 'generated'` is the CONTENT role and says nothing about origin: a
 *     manually uploaded clip has it too. The stored value keeps its historical
 *     name because renaming a Postgres enum value is not safe across a live
 *     deploy; this module is where it is read correctly.
 *   - `status = 'generated'` is a PENDING workflow state (the same queue as
 *     `under_review`) and says nothing about origin either.
 *
 * WHICH SURFACES MAY SEE WHICH ROLE stays in `asset-kinds.ts`, as positive
 * allow-lists. This module describes; that one authorises.
 */

export type AssetRole = 'reference' | 'content' | 'chat';
export type AssetOrigin = CharacterVisualAssetRow['origin'];
/**
 * Workflow as the product reads it (P0.4):
 *
 *   Ingest -> pending_review -> approved | rejected
 *             approved (released or not) -> archived
 *             archived -> (unarchive) approved, released nowhere: unarchiving
 *             restores no distribution, which stays an explicit act
 *
 * `deleted` is not a state at all -- a deleted asset has no row, and deletion
 * stays its own destructive operation.
 */
export type AssetWorkflow = 'pending_review' | 'approved' | 'rejected' | 'archived';

/** Exhaustive by type: a new `kind` value fails to compile until mapped here. */
const ROLE_BY_KIND: Readonly<Record<CharacterVisualAssetRow['kind'], AssetRole>> = {
  reference: 'reference',
  generated: 'content',
  chat: 'chat',
};

/**
 * Exhaustive by type, as above. Both pending statuses are one queue (Review's):
 * `generated` and `under_review` rows written before P0.4 keep working exactly
 * as they did, and nothing rewrites them.
 */
const WORKFLOW_BY_STATUS: Readonly<Record<CharacterVisualAssetRow['status'], AssetWorkflow>> = {
  generated: 'pending_review',
  under_review: 'pending_review',
  approved: 'approved',
  rejected: 'rejected',
  archived: 'archived',
};

export function assetRoleOf(kind: CharacterVisualAssetRow['kind']): AssetRole {
  return ROLE_BY_KIND[kind];
}

export function assetWorkflowOf(status: CharacterVisualAssetRow['status']): AssetWorkflow {
  return WORKFLOW_BY_STATUS[status];
}

/**
 * Still in the ACTIVE workflow: waiting for a decision, or approved.
 *
 * A POSITIVE test on purpose. Requirement counting used to ask "is it not
 * rejected?", which would have counted an archived clip toward a character's
 * required content -- and would count whatever state is added next as well.
 */
export function isInActiveWorkflow(status: CharacterVisualAssetRow['status']): boolean {
  const workflow = assetWorkflowOf(status);
  return workflow === 'pending_review' || workflow === 'approved';
}

/* ------------------------------------------------------------------ *
 * Transitions (P0.4)
 *
 * ONE TABLE OF RULES, used twice: the services call `checkTransition` before
 * they write, and the read models call `assetActionsOf` to tell the admin UI
 * which buttons to draw. A button the server would refuse therefore cannot be
 * offered, and the browser holds no lifecycle rule of its own.
 * ------------------------------------------------------------------ */

/**
 * The operator's verbs. `publish` / `unpublish` are the existing Posts release
 * routes (the product calls it Release). There is deliberately NO combined
 * verb: approval never releases, and releasing is always its own action.
 */
export type AssetAction =
  | 'approve'
  | 'reject'
  | 'publish'
  | 'unpublish'
  | 'archive'
  | 'unarchive';

export type TransitionCheck =
  /** `noop`: already in the target state; succeed without writing. */
  | { allowed: true; noop: boolean }
  | { allowed: false; reason: string };

export type TransitionSubject = Pick<CharacterVisualAssetRow, 'kind' | 'status' | 'publishedAt'>;

const ok: TransitionCheck = { allowed: true, noop: false };
const noop: TransitionCheck = { allowed: true, noop: true };
const refuse = (reason: string): TransitionCheck => ({ allowed: false, reason });

const NOT_CONTENT =
  'Only character content can be published to Posts. References are identity, and chat media is private.';

export function checkTransition(asset: TransitionSubject, action: AssetAction): TransitionCheck {
  const role = assetRoleOf(asset.kind);
  const workflow = assetWorkflowOf(asset.status);

  switch (action) {
    case 'approve':
      if (workflow === 'rejected') return refuse('Cannot approve a rejected asset.');
      if (workflow === 'archived') {
        return refuse('This asset is archived. Unarchive it to restore it; it was already approved.');
      }
      return workflow === 'approved' ? noop : ok;

    case 'reject':
      // Unchanged from before P0.4: reject is accepted from any state (the
      // Primary-reference removal relies on rejecting an approved reference).
      // The admin UI offers it only while a decision is outstanding.
      return workflow === 'rejected' ? noop : ok;

    case 'publish':
      if (workflow === 'archived') {
        return refuse('Archived content cannot be published. Unarchive it first.');
      }
      if (workflow !== 'approved') {
        return refuse('Only approved content can be published. Approve it in Review first.');
      }
      if (role !== 'content') return refuse(NOT_CONTENT);
      return asset.publishedAt ? noop : ok;

    case 'unpublish':
      // Taking something down never exposes anything, so it is refused in no
      // state; it is simply nothing to do when there is no release.
      return asset.publishedAt ? ok : noop;

    case 'archive':
      if (workflow === 'archived') return noop;
      if (role === 'reference') {
        return refuse(
          'Identity references are not archived. Manage the primary set from Visual identity.',
        );
      }
      if (workflow === 'pending_review') {
        return refuse('Only approved content can be archived. Approve or reject it first.');
      }
      if (workflow === 'rejected') {
        return refuse('Rejected content is already out of the workflow, so there is nothing to archive.');
      }
      return ok;

    case 'unarchive':
      if (workflow === 'archived') return ok;
      if (workflow === 'approved') return noop;
      return refuse('Only archived content can be unarchived.');
  }
}

/**
 * The operator matrix: which verbs an asset in each workflow state is OFFERED.
 * `checkTransition` then removes any the role forbids or that would do nothing.
 *
 *   Pending review -> Approve / Reject
 *   Approved       -> Release / Archive
 *   Released       -> Archive (and Take off Posts, the pre-existing release
 *                     toggle -- a distribution control, not a workflow step)
 *   Archived       -> Unarchive
 *   Rejected       -> nothing (deletion is separate)
 */
const OFFERED: Readonly<Record<AssetWorkflow, readonly AssetAction[]>> = {
  pending_review: ['approve', 'reject'],
  approved: ['publish', 'unpublish', 'archive'],
  rejected: [],
  archived: ['unarchive'],
};

export function assetActionsOf(asset: TransitionSubject): AssetAction[] {
  return OFFERED[assetWorkflowOf(asset.status)].filter((action) => {
    const check = checkTransition(asset, action);
    return check.allowed && !check.noop;
  });
}

export interface AssetLifecycleView {
  role: AssetRole;
  origin: AssetOrigin;
  workflow: AssetWorkflow;
  /** What an operator may do next, from the same rules the server enforces. */
  actions: AssetAction[];
}

/**
 * The independent facts about an asset, each from its own column, plus the
 * actions they permit. The shared read model for every admin surface that
 * shows an asset.
 */
export function assetLifecycleOf(
  row: Pick<CharacterVisualAssetRow, 'kind' | 'origin' | 'status' | 'publishedAt'>,
): AssetLifecycleView {
  return {
    role: assetRoleOf(row.kind),
    origin: row.origin,
    workflow: assetWorkflowOf(row.status),
    actions: assetActionsOf(row),
  };
}
