/**
 * US-106 revision — the review decision guard.
 *
 * Pure, so it is testable without a DOM (this repo tests logic directly rather
 * than driving components). It exists because "reject" is destructive from the
 * operator's point of view: the content leaves the active workflow and can
 * never be published. Approve is recoverable-by-comparison and immediate.
 *
 * The guard is per ASSET, not a global boolean. Confirming a rejection for one
 * item must never authorise rejecting a different item — the operator could
 * click a different tile between opening the prompt and confirming it.
 */

export type DecisionIntent = { kind: 'idle' } | { kind: 'confirm-reject'; assetId: string };

export const IDLE: DecisionIntent = { kind: 'idle' };

export const REJECT_CONFIRM_TITLE = 'Reject this content?';
export const REJECT_CONFIRM_BODY =
  'This content will be removed from the active content workflow and cannot be published. Its record and generation history are kept.';
export const REJECT_ACTION_LABEL = 'Reject & Remove';

/** Asking to reject never rejects — it only opens the confirmation. */
export function requestReject(assetId: string): DecisionIntent {
  return { kind: 'confirm-reject', assetId };
}

export function cancel(): DecisionIntent {
  return IDLE;
}

/** Rejection is permitted ONLY for the exact asset the operator confirmed. */
export function canReject(intent: DecisionIntent, assetId: string): boolean {
  return intent.kind === 'confirm-reject' && intent.assetId === assetId;
}

/** Approve is a single, immediate action — no confirmation step. */
export function canApprove(): boolean {
  return true;
}
