import { describe, expect, it } from 'vitest';
import {
  canApprove,
  canReject,
  cancel,
  IDLE,
  REJECT_ACTION_LABEL,
  REJECT_CONFIRM_BODY,
  requestReject,
} from './reviewDecisions';

describe('US-106 reject confirmation guard', () => {
  it('never rejects without an explicit confirmation', () => {
    expect(canReject(IDLE, 'asset-1')).toBe(false);
  });

  it('opening the prompt does not itself reject', () => {
    const intent = requestReject('asset-1');
    expect(intent).toEqual({ kind: 'confirm-reject', assetId: 'asset-1' });
    // Still requires the confirm action to pass the guard for that asset.
    expect(canReject(intent, 'asset-1')).toBe(true);
  });

  it('confirming one asset does not authorise rejecting another', () => {
    const intent = requestReject('asset-1');
    expect(canReject(intent, 'asset-2')).toBe(false);
  });

  it('cancelling clears the intent', () => {
    expect(canReject(cancel(), 'asset-1')).toBe(false);
  });

  it('approve needs no confirmation', () => {
    expect(canApprove()).toBe(true);
  });

  it('tells the operator that rejection removes content from the workflow', () => {
    expect(REJECT_ACTION_LABEL).toBe('Reject & Remove');
    expect(REJECT_CONFIRM_BODY).toMatch(/removed from the active content workflow/i);
    expect(REJECT_CONFIRM_BODY).toMatch(/cannot be published/i);
    // ...while being honest that the record is retained.
    expect(REJECT_CONFIRM_BODY).toMatch(/record and generation history are kept/i);
  });
});
