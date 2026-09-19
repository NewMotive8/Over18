import type {
  AdminAdjustmentAllowance,
  AdminAdjustmentLimit,
  AdminWalletAdjustmentRequest,
  AdminWalletTransaction,
  WalletDirection,
  WalletEntryType,
} from '@over18/shared';

/**
 * Admin -> Wallets (P2.4), as pure logic. The web suite runs no effects, so
 * what the page decides lives here and is tested here.
 *
 * THE SERVER DECIDES. Caps, balances, the credit class, the spend order and
 * idempotency are all the wallet service's: this module only shapes a request
 * and presents what the server returns. No cap, amount or balance is written
 * here -- the limits shown are the ones the server sent.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** A permanent User ID, as typed or pasted. */
export function parseUserId(text: string): Parsed<string> {
  const id = text.trim();
  if (!id) return { ok: false, errors: ['Enter a User ID.'] };
  if (!UUID.test(id)) return { ok: false, errors: ['A User ID looks like 8-4-4-4-12 hexadecimal characters.'] };
  return { ok: true, value: id.toLowerCase() };
}

export interface AdjustmentForm {
  direction: WalletDirection;
  amount: string;
  reason: string;
  reference: string;
}

export const emptyAdjustment = (direction: WalletDirection): AdjustmentForm => ({ direction, amount: '', reason: '', reference: '' });

/**
 * The request for a confirmed adjustment. Checks only its SHAPE -- a whole
 * number, a reason -- never a cap or a balance: those are refused, with their
 * reason, by the server.
 */
export function adjustmentRequest(form: AdjustmentForm, idempotencyKey: string): Parsed<AdminWalletAdjustmentRequest> {
  const errors: string[] = [];
  const amountText = form.amount.trim();
  const amount = Number(amountText);
  if (!/^\d+$/.test(amountText) || !Number.isSafeInteger(amount) || amount < 1) errors.push('Enter a whole number of Credits, 1 or more.');
  if (!form.reason.trim()) errors.push('A reason is required for every adjustment.');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      direction: form.direction,
      amount,
      reason: form.reason.trim(),
      reference: form.reference.trim() || null,
      idempotencyKey,
    },
  };
}

/** One key per intended adjustment: made when its confirmation opens, reused by any retry of it. */
export function newIdempotencyKey(): string {
  return `admin-adjust-${crypto.randomUUID()}`;
}

export const DIRECTION_LABEL: Record<WalletDirection, string> = { credit: 'Credit', debit: 'Debit' };

/** The confirmation question, naming exactly what will happen and to whom. */
export function confirmationTitle(request: AdminWalletAdjustmentRequest, currency: string, email: string): string {
  return request.direction === 'credit'
    ? `Credit ${request.amount} ${currency} to ${email}?`
    : `Debit ${request.amount} ${currency} from ${email}?`;
}

export function confirmationBody(request: AdminWalletAdjustmentRequest): string {
  const reference = request.reference ? ` Reference: ${request.reference}.` : '';
  return `Reason: ${request.reason}.${reference} This adds a new ledger transaction; it cannot be edited or deleted afterwards, only corrected by another adjustment.`;
}

/** Why adjusting is not possible right now, or null when it is. */
export function adjustmentBlocked(state: { economyEnabled: boolean; permitted: boolean }): string | null {
  if (!state.permitted) return 'Your role does not permit wallet adjustments.';
  if (!state.economyEnabled) return 'The economy is switched off: adjustments are disabled. Reading is unaffected.';
  return null;
}

/** The server's limit for one currency and direction, or null when it sent none. */
export function limitFor(allowances: readonly AdminAdjustmentAllowance[], currency: string, direction: WalletDirection): AdminAdjustmentLimit | null {
  return allowances.find((a) => a.currency === currency)?.[direction] ?? null;
}

export function limitText(limit: AdminAdjustmentLimit | null): string {
  return limit ? `${limit.remaining} of ${limit.cap} left today (UTC)` : '—';
}

const ENTRY_LABEL: Record<WalletEntryType, string> = {
  grant: 'Grant',
  reward: 'Reward',
  purchase: 'Purchase',
  paid_action: 'Paid action',
  refund: 'Refund',
  reversal: 'Reversal',
  admin_adjustment: 'Support adjustment',
  hold: 'Hold',
  capture: 'Capture',
  release: 'Release',
};

export const entryLabel = (type: WalletEntryType): string => ENTRY_LABEL[type] ?? type;

/** The signed amount a transaction moved, e.g. "+40" or "-5". Holds and captures are signed by direction too. */
export const signedAmount = (t: Pick<AdminWalletTransaction, 'direction' | 'amount'>): string => `${t.direction === 'credit' ? '+' : '-'}${t.amount}`;

export const referenceText = (t: Pick<AdminWalletTransaction, 'source'>): string => (t.source ? `${t.source.type}: ${t.source.id}` : '—');
