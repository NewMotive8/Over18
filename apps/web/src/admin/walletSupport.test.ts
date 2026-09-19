import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AdminAdjustmentAllowance } from '@over18/shared';
import {
  adjustmentBlocked,
  adjustmentRequest,
  confirmationBody,
  confirmationTitle,
  emptyAdjustment,
  entryLabel,
  limitFor,
  limitText,
  newIdempotencyKey,
  parseUserId,
  referenceText,
  signedAmount,
} from './walletSupport';

/**
 * P2.4 admin wallet support, as pure logic. The server owns every rule, cap
 * and balance; these helpers shape a request and present the server's answer.
 * Figures below are arbitrary test data.
 */

describe('looking a user up', () => {
  it('accepts a permanent User ID, trimmed and lower-cased, and refuses anything else', () => {
    expect(parseUserId('  3F2504E0-4F89-41D3-9A0C-0305E82C3301 ')).toEqual({ ok: true, value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
    expect(parseUserId('')).toMatchObject({ ok: false });
    expect(parseUserId('someone@example.com')).toMatchObject({ ok: false });
  });
});

describe('an adjustment request', () => {
  it('needs a whole number of Credits and a reason -- its shape only', () => {
    for (const amount of ['', '0', '1.5', '-3', 'lots', '2e3']) {
      expect(adjustmentRequest({ ...emptyAdjustment('credit'), amount, reason: 'Goodwill' }, 'k'), amount).toMatchObject({ ok: false });
    }
    expect(adjustmentRequest({ ...emptyAdjustment('debit'), amount: '5', reason: '   ' }, 'k')).toEqual({
      ok: false,
      errors: ['A reason is required for every adjustment.'],
    });
  });

  it('carries the direction, the trimmed reason, an optional reference and the key', () => {
    expect(adjustmentRequest({ direction: 'debit', amount: ' 12 ', reason: ' Duplicate grant ', reference: '  ' }, 'key-1')).toEqual({
      ok: true,
      value: { direction: 'debit', amount: 12, reason: 'Duplicate grant', reference: null, idempotencyKey: 'key-1' },
    });
    expect(adjustmentRequest({ direction: 'credit', amount: '3', reason: 'Goodwill', reference: 'T-9' }, 'key-2')).toMatchObject({
      ok: true,
      value: { reference: 'T-9' },
    });
  });

  it('gets a fresh key per intended adjustment', () => {
    const keys = new Set(Array.from({ length: 20 }, newIdempotencyKey));
    expect(keys.size).toBe(20);
  });

  it('asks a confirmation that names the direction, the amount, the account, the reason and the reference', () => {
    const credit = { direction: 'credit' as const, amount: 40, reason: 'Goodwill', reference: 'T-1', idempotencyKey: 'k' };
    expect(confirmationTitle(credit, 'credits', 'a@example.com')).toBe('Credit 40 credits to a@example.com?');
    expect(confirmationTitle({ ...credit, direction: 'debit' }, 'credits', 'a@example.com')).toBe('Debit 40 credits from a@example.com?');
    expect(confirmationBody(credit)).toContain('Reason: Goodwill. Reference: T-1.');
    expect(confirmationBody(credit)).toContain('cannot be edited or deleted');
  });
});

describe('when adjusting is possible', () => {
  it('never while the economy is off or without the permission', () => {
    expect(adjustmentBlocked({ economyEnabled: true, permitted: true })).toBeNull();
    expect(adjustmentBlocked({ economyEnabled: false, permitted: true })).toMatch(/economy is switched off/);
    expect(adjustmentBlocked({ economyEnabled: true, permitted: false })).toMatch(/does not permit/);
  });

  it("shows the server's limits, never its own", () => {
    const allowances: AdminAdjustmentAllowance[] = [
      { currency: 'credits', credit: { cap: 77, used: 7, remaining: 70 }, debit: { cap: 33, used: 33, remaining: 0 } },
    ];
    expect(limitText(limitFor(allowances, 'credits', 'credit'))).toBe('70 of 77 left today (UTC)');
    expect(limitText(limitFor(allowances, 'credits', 'debit'))).toBe('0 of 33 left today (UTC)');
    expect(limitText(limitFor(allowances, 'hearts', 'credit'))).toBe('—');
  });

  it('writes no cap into the web code: the limits come from the server', () => {
    for (const rel of ['./walletSupport.ts', '../pages/admin/AdminWalletPage.tsx']) {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      // Tailwind shades such as text-zinc-500 are not amounts: a figure preceded by "-" is ignored.
      expect(source, rel).not.toMatch(/(?<![-\w])(500|1000|1_000|1,000)(?![\w])/);
    }
  });
});

describe('the history', () => {
  it('labels each transaction, signs its amount and shows its reference', () => {
    expect(entryLabel('admin_adjustment')).toBe('Support adjustment');
    expect(entryLabel('paid_action')).toBe('Paid action');
    expect(signedAmount({ direction: 'credit', amount: 40 })).toBe('+40');
    expect(signedAmount({ direction: 'debit', amount: 5 })).toBe('-5');
    expect(referenceText({ source: { type: 'support_reference', id: 'T-1' } })).toBe('support_reference: T-1');
    expect(referenceText({ source: null })).toBe('—');
  });
});
