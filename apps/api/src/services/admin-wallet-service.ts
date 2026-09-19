import { eq } from 'drizzle-orm';
import type {
  AdminUserWallets,
  AdminWalletAdjustmentResult,
  AdminWalletHistory,
  AdminWalletSummary,
  AdminWalletTransaction,
  AdminWalletUser,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { recordAudit, type AuditActor } from './audit-service.js';
import {
  adjustWallet,
  isWalletCurrency,
  readAdjustmentAllowance,
  readWalletHistory,
  readWalletSummaries,
  type WalletTransactionView,
} from './wallet-service.js';

/**
 * ADMIN WALLET SUPPORT (P2.4, PRD §16, §18, §30.1, §34).
 *
 * A support operator looks up one user by their permanent User ID, sees every
 * wallet -- spendable, held and per class -- and the read-only ledger, and may
 * Credit or Debit it. This module composes; it owns no wallet rule. Every
 * balance rule, cap and idempotency guarantee is the wallet service's, and every
 * change is a new ledger transaction: nothing here can edit a balance or a
 * historical transaction.
 *
 * AN ADJUSTMENT AND ITS AUDIT RECORD COMMIT TOGETHER. The adjustment runs in a
 * savepoint of a transaction that also writes the audit entry (§34.2), so
 * there can be no adjustment without its record, nor a record of one that did
 * not happen. A replayed key changed nothing and records nothing.
 *
 * Reading is available whenever the operator may read; whether the economy is
 * on only decides whether an adjustment may be made (enforced by the route).
 */

export class AdminWalletError extends Error {
  constructor(
    public readonly code: 'user_not_found' | 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'AdminWalletError';
  }
}

export interface SupportActor extends AuditActor {
  userId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[a-z][a-z0-9_]{1,31}$/;
const REFERENCE_MAX = 100;
/** How a support reference is recorded on the transaction (P2.1 `source_type`). */
export const SUPPORT_REFERENCE_SOURCE = 'support_reference';

/** The audit object an adjustment is recorded against: one user's wallet in one currency. */
export const WALLET_AUDIT_OBJECT_TYPE = 'wallet';
export const walletAuditObjectId = (userId: string, currency: string) => `${userId}:${currency}`;

function invalid(message: string): never {
  throw new AdminWalletError('invalid_request', message);
}

/** The account, confirmed to exist: its id, email and when it was created -- nothing more. */
async function findUser(db: Pick<Db, 'select'>, userId: string): Promise<AdminWalletUser> {
  if (typeof userId !== 'string' || !UUID.test(userId)) invalid('The User ID must be a user id.');
  const [row] = await db.select({ id: users.id, email: users.email, createdAt: users.createdAt }).from(users).where(eq(users.id, userId));
  if (!row) throw new AdminWalletError('user_not_found', `No user has the ID ${userId}.`);
  return { id: row.id, email: row.email, createdAt: row.createdAt.toISOString() };
}

function requireCurrency(currency: string): void {
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) invalid('currency must be a wallet currency code.');
}

/** A ledger transaction as support sees it: an explicit allow-list, no key or request id. */
function toTransaction(t: WalletTransactionView): AdminWalletTransaction {
  return {
    id: t.id,
    sequence: t.sequence,
    entryType: t.entryType,
    direction: t.direction,
    amount: t.amount,
    creditClass: t.creditClass,
    balanceAfter: t.balanceAfter,
    heldAfter: t.heldAfter,
    relatedTransactionId: t.relatedTransactionId,
    source: t.source,
    reason: t.reason,
    actorUserId: t.actorUserId,
    createdAt: t.createdAt,
  };
}

/** The user, every wallet, and the operator's own adjustment limits per currency. */
export async function readUserWallets(db: Db, userId: string, operator: SupportActor, economyEnabled: boolean): Promise<AdminUserWallets> {
  const user = await findUser(db, userId);
  const wallets = await readWalletSummaries(db, userId);
  const allowances = await Promise.all(wallets.map((w) => readAdjustmentAllowance(db, operator.userId, w.currency)));
  return { user, economyEnabled, wallets, allowances };
}

function pageNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) invalid(`${name} must be a whole number, 1 or more.`);
  return n;
}

/** One page of a wallet's transactions, newest first. */
export async function readUserWalletHistory(
  db: Db,
  userId: string,
  currency: string,
  query: { before?: unknown; limit?: unknown } = {},
): Promise<AdminWalletHistory> {
  requireCurrency(currency);
  const before = pageNumber(query.before, 'before');
  const limit = pageNumber(query.limit, 'limit');
  await findUser(db, userId);
  const page = await readWalletHistory(db, userId, currency, { before, limit });
  return { currency, transactions: page.transactions.map(toTransaction), nextBefore: page.nextBefore };
}

interface ParsedAdjustment {
  direction: 'credit' | 'debit';
  amount: number;
  reason: string;
  reference: string | null;
  idempotencyKey: string;
}

/** The request's SHAPE. Amounts, balances and caps are the wallet service's to judge. */
function parseAdjustment(body: unknown): ParsedAdjustment {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('The adjustment must be a JSON object.');
  const b = body as Record<string, unknown>;
  if (b.direction !== 'credit' && b.direction !== 'debit') invalid('direction must be "credit" or "debit".');
  if (typeof b.amount !== 'number' || !Number.isSafeInteger(b.amount) || b.amount < 1) invalid('amount must be a whole number of Credits, 1 or more.');
  if (typeof b.reason !== 'string' || b.reason.trim() === '') invalid('A reason is required for every adjustment.');
  let reference: string | null = null;
  if (b.reference !== undefined && b.reference !== null) {
    if (typeof b.reference !== 'string' || b.reference.length > REFERENCE_MAX) invalid(`reference must be text of at most ${REFERENCE_MAX} characters.`);
    reference = b.reference.trim() || null;
  }
  if (typeof b.idempotencyKey !== 'string' || b.idempotencyKey.trim() === '') invalid('idempotencyKey is required.');
  return { direction: b.direction, amount: b.amount, reason: b.reason, reference, idempotencyKey: b.idempotencyKey };
}

/**
 * Credits or Debits one user's wallet in one currency, and records it. Returns
 * the transaction, the wallet as it now stands, and the operator's remaining
 * allowance -- so the result shows immediately.
 */
export async function adjustUserWallet(
  db: Db,
  userId: string,
  currency: string,
  body: unknown,
  ctx: { actor: SupportActor; requestId: string | null },
): Promise<AdminWalletAdjustmentResult> {
  requireCurrency(currency);
  const request = parseAdjustment(body);
  await findUser(db, userId);
  if (!(await isWalletCurrency(db, currency))) invalid(`There is no ${currency} currency.`);

  const result = await db.transaction(async (tx) => {
    const adjusted = await adjustWallet(tx, {
      userId,
      currency,
      direction: request.direction,
      amount: request.amount,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      source: request.reference ? { type: SUPPORT_REFERENCE_SOURCE, id: request.reference } : null,
      actorUserId: ctx.actor.userId,
      requestId: ctx.requestId,
    });
    if (!adjusted.replayed) {
      const t = adjusted.transaction;
      const delta = t.direction === 'credit' ? t.amount : -t.amount;
      await recordAudit(tx, {
        actor: ctx.actor,
        action: `wallet.adjust.${t.direction}`,
        objectType: WALLET_AUDIT_OBJECT_TYPE,
        objectId: walletAuditObjectId(userId, currency),
        before: { balance: t.balanceAfter - delta, held: t.heldAfter },
        after: { balance: t.balanceAfter, held: t.heldAfter },
        reason: t.reason,
        requestId: ctx.requestId,
        metadata: {
          userId,
          currency,
          transactionId: t.id,
          sequence: t.sequence,
          direction: t.direction,
          amount: t.amount,
          creditClass: t.creditClass,
          reference: request.reference,
        },
      });
    }
    return adjusted;
  });

  const [wallets, allowance] = await Promise.all([readWalletSummaries(db, userId), readAdjustmentAllowance(db, ctx.actor.userId, currency)]);
  const wallet = wallets.find((w) => w.currency === currency) as AdminWalletSummary;
  return { transaction: toTransaction(result.transaction), replayed: result.replayed, wallet, allowance };
}
