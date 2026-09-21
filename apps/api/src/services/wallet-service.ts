import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { CommercialWallet } from '@over18/shared';
import type { Db } from '../db/client.js';
import { walletCurrencies, wallets, walletTransactions, type WalletTransactionRow } from '../db/schema.js';

/**
 * THE WALLET SERVICE (P2.2) -- hold, capture, release, refund and reversal;
 * and, since P2.4, an operator's support adjustment.
 *
 * The one application module that writes a wallet. It adds no second ledger and
 * no balance of its own: every operation appends exactly ONE row to the P2.1
 * ledger, and the database (migration 0034) applies it to the cached wallet,
 * stamps the resulting balance and refuses anything inconsistent. This module
 * decides WHETHER an operation may happen; the database guarantees that what is
 * written is internally consistent either way.
 *
 *   hold      spendable -> held, for an action in flight
 *   capture   consume part or all of a hold's remaining Credits
 *   release   return part or all of a hold's remaining Credits to spendable
 *   refund    return Credits charged by a paid action or a capture
 *   reversal  undo part or all of an earlier transaction, opposite to it
 *   adjust    an operator's Credit or Debit, capped per day (P2.4)
 *   grant     Credits a confirmed payment entitles a customer to (P9.2)
 *
 * ONE TRANSACTION, ONE WALLET LOCK. Every operation runs in a database
 * transaction that first locks its wallet row, so operations on one wallet are
 * serialised: balances, remaining holds and refundable amounts are read after
 * the lock and cannot change underneath a check. If anything fails, nothing is
 * written. Passing a transaction as `db` nests the operation in a savepoint, so
 * a caller can make it part of a larger unit of work.
 *
 * IDEMPOTENT. Every operation carries a caller-chosen idempotency key, unique
 * per wallet (P2.1). The key is checked AFTER the lock, so a retry -- even one
 * racing the original -- finds the original and gets its result back, with
 * `replayed: true`, writing nothing. Reusing a key for a MATERIALLY DIFFERENT
 * operation (another type, amount, original transaction or source) is refused
 * with `idempotency_conflict`. A reason, request id, actor or metadata that
 * differs on a retry is not material.
 *
 * THE IDEMPOTENCY BOUNDARY (P2.3), the same for every operation:
 *   - A key names ONE operation in ONE wallet (user and currency), and one
 *     operation is exactly one ledger transaction. The same key in another
 *     currency's wallet is another operation.
 *   - The stable result of a key is the transaction it recorded, exactly as it
 *     was recorded -- including the balance it left then, whatever has
 *     happened to the wallet since.
 *   - A REFUSED operation records nothing, so it leaves no result and does not
 *     use up its key: a retry is evaluated afresh. There is one financial
 *     effect per key, never two.
 *
 * `wallet-reconciliation.ts` proves the other half of §19.2 from the outside:
 * that every wallet still equals its ledger.
 *
 * CREDIT CLASSES (PRD §18: included -> earned -> purchased, expiring before
 * permanent). A capture, release, refund or reversal moves Credits of the class
 * of the transaction it names -- Credits go back to, or leave, the class they
 * came from. A new hold takes its class from the spend order: the first class,
 * included -> earned -> purchased, whose spendable Credits cover the whole
 * amount. Per-class balances are derived from the ledger under the wallet lock
 * (P2.1 caches totals only) and must add up to the cached wallet, or the
 * operation is refused as `ledger_inconsistent`.
 *
 * THE LIMITATION, stated rather than papered over: in P2.1 a hold is ONE ledger
 * row of ONE class, and captures and releases name one hold. A hold whose
 * amount no single class covers -- though the classes together do -- would have
 * to be split across several rows that P2.1 has no way to group into one
 * operation. It is refused with `credit_class_split_required` rather than
 * misattributed to a single class. Likewise a hold is taken from a later class
 * when an earlier one holds some Credits but not enough.
 *
 * NOT HERE: purchasing, rewards, expiry, paid-action charging, and any route.
 * `grantCredits` gives Credits but decides nothing about WHY -- it is called
 * only by the payment service, after a provider has confirmed the money, and it
 * refuses to invent a reason of its own.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type WalletDb = Pick<Db, 'transaction'>;

export type CreditClass = WalletTransactionRow['creditClass'];
type EntryType = WalletTransactionRow['entryType'];
type Direction = WalletTransactionRow['direction'];

/** PRD §18: expiring balances before permanent ones. */
export const CREDIT_SPEND_ORDER: readonly CreditClass[] = ['included', 'earned', 'purchased'];

export type WalletErrorCode =
  | 'invalid_request'
  | 'wallet_not_found'
  | 'transaction_not_found'
  | 'invalid_reference'
  | 'insufficient_credits'
  | 'credit_class_split_required'
  | 'exceeds_remaining'
  | 'idempotency_conflict'
  | 'adjustment_cap_exceeded'
  | 'own_wallet'
  | 'ledger_inconsistent'
  | 'ledger_refused';

export class WalletError extends Error {
  constructor(
    public readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

/** What caused a transaction: a payment event, an action, a support ticket. */
export interface WalletSourceRef {
  type: string;
  id: string;
}

interface OperationInput {
  /** The wallet owner. An operation never reaches another user's wallet or transactions. */
  userId: string;
  /** Whole Credits, 1 or more. */
  amount: number;
  idempotencyKey: string;
  source?: WalletSourceRef | null;
  reason?: string | null;
  /** Who acted, when a person did. */
  actorUserId?: string | null;
  requestId?: string | null;
  /** Context for audit. Never a credential or payment instrument. */
  metadata?: Record<string, unknown>;
}

export interface HoldInput extends OperationInput {
  currency: string;
}

export interface SettleHoldInput extends OperationInput {
  holdTransactionId: string;
}

export interface CompensateInput extends OperationInput {
  /** The transaction being refunded or reversed. */
  transactionId: string;
}

export interface WalletTransactionView {
  id: string;
  userId: string;
  currency: string;
  sequence: number;
  entryType: EntryType;
  direction: Direction;
  amount: number;
  creditClass: CreditClass;
  /** The wallet's spendable Credits right after this transaction. */
  balanceAfter: number;
  /** The wallet's held Credits right after this transaction. */
  heldAfter: number;
  idempotencyKey: string;
  relatedTransactionId: string | null;
  source: WalletSourceRef | null;
  reason: string | null;
  actorUserId: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface WalletOperationResult {
  transaction: WalletTransactionView;
  /** True when the idempotency key had already been used for this same operation: nothing was written. */
  replayed: boolean;
}

/* ------------------------------------------------------------------ *
 * Validation -- the request's shape; every balance rule is checked under the lock
 * ------------------------------------------------------------------ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[a-z][a-z0-9_]{1,31}$/;
const SOURCE_TYPE = /^[a-z][a-z0-9_]{1,63}$/;
/** The ledger's integer columns. */
const AMOUNT_MAX = 2 ** 31 - 1;
const KEY_MAX = 200;
const REASON_MAX = 500;

function invalid(message: string): never {
  throw new WalletError('invalid_request', message);
}

function validate(input: OperationInput): void {
  if (typeof input.userId !== 'string' || !UUID.test(input.userId)) invalid('userId must be a user id.');
  if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > AMOUNT_MAX) {
    invalid('amount must be a whole number of Credits, 1 or more.');
  }
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.trim() === '' || key.length > KEY_MAX) {
    invalid(`idempotencyKey must be non-blank text of at most ${KEY_MAX} characters.`);
  }
  if (input.source != null) {
    const { type, id } = input.source;
    if (typeof type !== 'string' || !SOURCE_TYPE.test(type) || typeof id !== 'string' || id.trim() === '') {
      invalid('source must name a lower-case source type and a non-blank id.');
    }
  }
  if (input.reason != null && (typeof input.reason !== 'string' || input.reason.length > REASON_MAX)) {
    invalid(`reason must be text of at most ${REASON_MAX} characters.`);
  }
  if (input.actorUserId != null && (typeof input.actorUserId !== 'string' || !UUID.test(input.actorUserId))) {
    invalid('actorUserId must be a user id.');
  }
  if (input.metadata !== undefined && (typeof input.metadata !== 'object' || input.metadata === null || Array.isArray(input.metadata))) {
    invalid('metadata must be an object.');
  }
}

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(`${name} must be a transaction id.`);
  return value;
}

/* ------------------------------------------------------------------ *
 * The transaction scaffolding
 * ------------------------------------------------------------------ */

function pgError(error: unknown): { code: string; constraint: string | null; message: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const candidate = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : null,
        message: typeof candidate.message === 'string' ? candidate.message : '',
      };
    }
    current = candidate.cause;
  }
  return null;
}

/**
 * Runs one operation in its own transaction. A duplicate-key refusal can only
 * come from a writer that did not take the wallet lock; the operation is then
 * run once more, and replays or conflicts like any retry. A database refusal
 * after this module's own checks passed means the two disagree: it is surfaced,
 * never swallowed.
 */
async function operate(db: WalletDb, work: (tx: Tx) => Promise<WalletOperationResult>): Promise<WalletOperationResult> {
  try {
    return await db.transaction(work);
  } catch (error) {
    if (error instanceof WalletError) throw error;
    const pg = pgError(error);
    if (pg?.code === '23505' && pg.constraint === 'wallet_transactions_idempotency_idx') return db.transaction(work);
    if (pg && (pg.code === '23514' || pg.code === '23503' || pg.code === '42501')) throw new WalletError('ledger_refused', pg.message);
    throw error;
  }
}

async function lockWallet(tx: Tx, userId: string, currency: string) {
  const [wallet] = await tx
    .select({ balance: wallets.balance, held: wallets.held })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)))
    .for('update');
  return wallet ?? null;
}

/** A transaction of this user's. Another user's, or none, is `transaction_not_found` alike. */
async function ownTransaction(tx: Tx, userId: string, id: string): Promise<WalletTransactionRow> {
  const [row] = await tx.select().from(walletTransactions).where(eq(walletTransactions.id, id));
  if (!row || row.userId !== userId) throw new WalletError('transaction_not_found', `No transaction ${id} in this user's wallets.`);
  return row;
}

async function byKey(tx: Tx, userId: string, currency: string, key: string): Promise<WalletTransactionRow | null> {
  const [row] = await tx
    .select()
    .from(walletTransactions)
    .where(and(eq(walletTransactions.userId, userId), eq(walletTransactions.currency, currency), eq(walletTransactions.idempotencyKey, key)));
  return row ?? null;
}

interface Material {
  entryType: EntryType;
  /** Stated where the type does not decide it: an adjustment may go either way. */
  direction?: Direction;
  amount: number;
  relatedTransactionId: string | null;
  source: WalletSourceRef | null;
}

/** The earlier result for this key -- or `idempotency_conflict` if it was a different operation. */
function replay(existing: WalletTransactionRow, expected: Material): WalletOperationResult {
  const differences: string[] = [];
  if (existing.entryType !== expected.entryType) differences.push(`type ${existing.entryType}, not ${expected.entryType}`);
  if (expected.direction && existing.direction !== expected.direction) differences.push(`direction ${existing.direction}, not ${expected.direction}`);
  if (existing.amount !== expected.amount) differences.push(`amount ${existing.amount}, not ${expected.amount}`);
  if (existing.relatedTransactionId !== expected.relatedTransactionId) differences.push('a different original transaction');
  if (existing.sourceType !== (expected.source?.type ?? null) || existing.sourceId !== (expected.source?.id ?? null)) {
    differences.push('a different source');
  }
  if (differences.length > 0) {
    throw new WalletError(
      'idempotency_conflict',
      `Idempotency key "${existing.idempotencyKey}" was already used in this wallet for a different operation (${differences.join('; ')}).`,
    );
  }
  return { transaction: view(existing), replayed: true };
}

/** Sum of the amounts of the transactions of `types` that name `id`. */
async function namedBy(tx: Tx, id: string, types: EntryType[]): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${walletTransactions.amount}), 0)` })
    .from(walletTransactions)
    .where(and(eq(walletTransactions.relatedTransactionId, id), inArray(walletTransactions.entryType, types)));
  return Number(row!.total);
}

type ClassBalances = Record<CreditClass, { spendable: number; held: number }>;

/**
 * Spendable and held Credits per class, derived from the ledger exactly as
 * migration 0034 applies each row to the wallet -- in one statement, so from
 * one consistent instant. A user with no transactions has none of either.
 */
async function deriveClassBalances(db: Pick<Db, 'execute'> | Tx, userId: string, currency: string): Promise<ClassBalances> {
  const t = walletTransactions;
  const result = await db.execute<{ credit_class: CreditClass; spendable: string; held: string }>(sql`
    select ${t.creditClass} as credit_class,
           coalesce(sum(case when ${t.entryType} = 'capture' then 0
                             when ${t.direction} = 'credit' then ${t.amount}
                             else -${t.amount} end), 0) as spendable,
           coalesce(sum(case when ${t.entryType} = 'hold' then ${t.amount}
                             when ${t.entryType} in ('capture', 'release') then -${t.amount}
                             else 0 end), 0) as held
      from ${t}
     where ${t.userId} = ${userId} and ${t.currency} = ${currency}
     group by ${t.creditClass}`);
  const balances = Object.fromEntries(CREDIT_SPEND_ORDER.map((c) => [c, { spendable: 0, held: 0 }])) as ClassBalances;
  for (const row of result.rows) balances[row.credit_class] = { spendable: Number(row.spendable), held: Number(row.held) };
  return balances;
}

const reconciles = (balances: ClassBalances) => Object.values(balances).every((b) => b.spendable >= 0 && b.held >= 0);

/**
 * The per-class balances an operation builds on, under the wallet lock. They
 * must be non-negative and add up to the cached wallet; otherwise the class
 * accounting cannot be trusted and nothing is built on it.
 */
async function classBalances(tx: Tx, userId: string, currency: string, cached: { balance: number; held: number }): Promise<ClassBalances> {
  const balances = await deriveClassBalances(tx, userId, currency);
  const all = Object.values(balances);
  const spendable = all.reduce((sum, b) => sum + b.spendable, 0);
  const held = all.reduce((sum, b) => sum + b.held, 0);
  if (!reconciles(balances) || spendable !== cached.balance || held !== cached.held) {
    throw new WalletError(
      'ledger_inconsistent',
      `The ${currency} wallet's Credit classes do not reconcile with its balance (${JSON.stringify(balances)}; balance ${cached.balance}, held ${cached.held}).`,
    );
  }
  return balances;
}

/**
 * The class a spend of `amount` comes from, by the spend order: the first
 * class, included -> earned -> purchased, whose spendable Credits cover it
 * whole. Held Credits are never spendable. A spend that no single class covers,
 * though the classes together do, is refused: one P2.1 transaction is one
 * class, and splitting across classes is not supported (the P2.2 limitation).
 */
async function spendClass(
  tx: Tx,
  userId: string,
  currency: string,
  wallet: { balance: number; held: number },
  amount: number,
  what: string,
): Promise<CreditClass> {
  if (wallet.balance < amount) {
    throw new WalletError('insufficient_credits', `${what} ${amount} needs ${amount} spendable Credits; the wallet has ${wallet.balance}.`);
  }
  const classes = await classBalances(tx, userId, currency, wallet);
  const creditClass = CREDIT_SPEND_ORDER.find((c) => classes[c].spendable >= amount);
  if (!creditClass) {
    throw new WalletError(
      'credit_class_split_required',
      `${what} ${amount} would need Credits from more than one class (${CREDIT_SPEND_ORDER.map((c) => `${c} ${classes[c].spendable}`).join(', ')}); one transaction is one class.`,
    );
  }
  return creditClass;
}

async function append(
  tx: Tx,
  input: OperationInput,
  row: { currency: string; entryType: EntryType; direction: Direction; creditClass: CreditClass; relatedTransactionId: string | null },
): Promise<WalletTransactionRow> {
  const [inserted] = await tx
    .insert(walletTransactions)
    .values({
      userId: input.userId,
      currency: row.currency,
      entryType: row.entryType,
      direction: row.direction,
      amount: input.amount,
      creditClass: row.creditClass,
      idempotencyKey: input.idempotencyKey,
      relatedTransactionId: row.relatedTransactionId,
      sourceType: input.source?.type ?? null,
      sourceId: input.source?.id ?? null,
      reason: input.reason?.trim() || null,
      actorUserId: input.actorUserId ?? null,
      requestId: input.requestId ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();
  return inserted!;
}

function view(row: WalletTransactionRow): WalletTransactionView {
  return {
    id: row.id,
    userId: row.userId,
    currency: row.currency,
    sequence: row.sequence,
    entryType: row.entryType,
    direction: row.direction,
    amount: row.amount,
    creditClass: row.creditClass,
    balanceAfter: row.balanceAfter,
    heldAfter: row.heldAfter,
    idempotencyKey: row.idempotencyKey,
    relatedTransactionId: row.relatedTransactionId,
    source: row.sourceType !== null && row.sourceId !== null ? { type: row.sourceType, id: row.sourceId } : null,
    reason: row.reason,
    actorUserId: row.actorUserId,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Reading (P3.1)
 * ------------------------------------------------------------------ */

/** The customer-facing Credits currency (seeded by migration 0034). */
export const CREDITS_CURRENCY = 'credits';

/**
 * A user's Credits in the P0 `CommercialWallet` shape, READ-ONLY: spendable
 * Credits by class, and held Credits (not spendable). Derived from the ledger
 * -- the record, not the cache -- in one statement, taking no lock and writing
 * nothing. A user with no wallet has no Credits. `null` when a class does not
 * reconcile: a balance that cannot be trusted is not reported.
 */
export async function readCommercialWallet(db: Pick<Db, 'execute'>, userId: string, currency: string): Promise<CommercialWallet | null> {
  const balances = await deriveClassBalances(db, userId, currency);
  if (!reconciles(balances)) return null;
  const all = Object.values(balances);
  return {
    included: balances.included.spendable,
    earned: balances.earned.spendable,
    purchased: balances.purchased.spendable,
    held: all.reduce((sum, b) => sum + b.held, 0),
    spendable: all.reduce((sum, b) => sum + b.spendable, 0),
  };
}

/* ------------------------------------------------------------------ *
 * The operations
 * ------------------------------------------------------------------ */

/**
 * HOLD: moves `amount` spendable Credits to held, for an action in flight.
 * Held Credits are not spendable: a later hold or debit cannot use them.
 */
export async function holdCredits(db: WalletDb, input: HoldInput): Promise<WalletOperationResult> {
  validate(input);
  if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) invalid('currency must be a wallet currency code.');
  const expected: Material = { entryType: 'hold', amount: input.amount, relatedTransactionId: null, source: input.source ?? null };
  return operate(db, async (tx) => {
    const wallet = await lockWallet(tx, input.userId, input.currency);
    if (!wallet) throw new WalletError('wallet_not_found', `The user has no ${input.currency} wallet.`);
    const existing = await byKey(tx, input.userId, input.currency, input.idempotencyKey);
    if (existing) return replay(existing, expected);

    const creditClass = await spendClass(tx, input.userId, input.currency, wallet, input.amount, 'Holding');
    const row = await append(tx, input, { currency: input.currency, entryType: 'hold', direction: 'debit', creditClass, relatedTransactionId: null });
    return { transaction: view(row), replayed: false };
  });
}

async function settleHold(db: WalletDb, input: SettleHoldInput, entryType: 'capture' | 'release'): Promise<WalletOperationResult> {
  validate(input);
  const holdId = requireId(input.holdTransactionId, 'holdTransactionId');
  const expected: Material = { entryType, amount: input.amount, relatedTransactionId: holdId, source: input.source ?? null };
  return operate(db, async (tx) => {
    const hold = await ownTransaction(tx, input.userId, holdId);
    await lockWallet(tx, hold.userId, hold.currency);
    const existing = await byKey(tx, hold.userId, hold.currency, input.idempotencyKey);
    if (existing) return replay(existing, expected);

    if (hold.entryType !== 'hold') {
      throw new WalletError('invalid_reference', `A ${entryType} settles a hold; transaction ${hold.id} is a ${hold.entryType}.`);
    }
    const remaining = hold.amount - (await namedBy(tx, hold.id, ['capture', 'release']));
    if (input.amount > remaining) {
      throw new WalletError('exceeds_remaining', `The hold has ${remaining} Credits remaining; cannot ${entryType} ${input.amount}.`);
    }
    const row = await append(tx, input, {
      currency: hold.currency,
      entryType,
      direction: entryType === 'capture' ? 'debit' : 'credit',
      creditClass: hold.creditClass,
      relatedTransactionId: hold.id,
    });
    return { transaction: view(row), replayed: false };
  });
}

/** CAPTURE: consumes part or all of a hold's remaining Credits. */
export function captureHold(db: WalletDb, input: SettleHoldInput): Promise<WalletOperationResult> {
  return settleHold(db, input, 'capture');
}

/** RELEASE: returns part or all of a hold's remaining Credits to spendable. */
export function releaseHold(db: WalletDb, input: SettleHoldInput): Promise<WalletOperationResult> {
  return settleHold(db, input, 'release');
}

/**
 * REFUND: returns Credits charged by a paid action or a capture, to the class
 * they were charged from. Together with any reversals of it, never more than
 * the original.
 */
export async function refundTransaction(db: WalletDb, input: CompensateInput): Promise<WalletOperationResult> {
  validate(input);
  const originalId = requireId(input.transactionId, 'transactionId');
  const expected: Material = { entryType: 'refund', amount: input.amount, relatedTransactionId: originalId, source: input.source ?? null };
  return operate(db, async (tx) => {
    const original = await ownTransaction(tx, input.userId, originalId);
    await lockWallet(tx, original.userId, original.currency);
    const existing = await byKey(tx, original.userId, original.currency, input.idempotencyKey);
    if (existing) return replay(existing, expected);

    if (original.entryType !== 'paid_action' && original.entryType !== 'capture') {
      throw new WalletError('invalid_reference', `A refund returns Credits charged by a paid action or a capture; transaction ${original.id} is a ${original.entryType}.`);
    }
    const refundable = original.amount - (await namedBy(tx, original.id, ['refund', 'reversal']));
    if (input.amount > refundable) {
      throw new WalletError('exceeds_remaining', `${refundable} Credits of that transaction remain refundable; cannot refund ${input.amount}.`);
    }
    const row = await append(tx, input, {
      currency: original.currency,
      entryType: 'refund',
      direction: 'credit',
      creditClass: original.creditClass,
      relatedTransactionId: original.id,
    });
    return { transaction: view(row), replayed: false };
  });
}

/**
 * REVERSAL: undoes part or all of an earlier transaction with one running the
 * other way, in the same class. Together with any refunds of it, never more
 * than the original; a reversal that takes Credits back needs them spendable
 * in that class -- held Credits are never taken. A hold is settled by a
 * capture or release, never reversed.
 */
export async function reverseTransaction(db: WalletDb, input: CompensateInput): Promise<WalletOperationResult> {
  validate(input);
  const originalId = requireId(input.transactionId, 'transactionId');
  const expected: Material = { entryType: 'reversal', amount: input.amount, relatedTransactionId: originalId, source: input.source ?? null };
  return operate(db, async (tx) => {
    const original = await ownTransaction(tx, input.userId, originalId);
    const wallet = (await lockWallet(tx, original.userId, original.currency))!;
    const existing = await byKey(tx, original.userId, original.currency, input.idempotencyKey);
    if (existing) return replay(existing, expected);

    if (original.entryType === 'hold' || original.entryType === 'release') {
      throw new WalletError('invalid_reference', `A ${original.entryType} is settled by a capture or release, not reversed.`);
    }
    const reversible = original.amount - (await namedBy(tx, original.id, ['refund', 'reversal']));
    if (input.amount > reversible) {
      throw new WalletError('exceeds_remaining', `${reversible} Credits of that transaction remain reversible; cannot reverse ${input.amount}.`);
    }
    const direction: Direction = original.direction === 'credit' ? 'debit' : 'credit';
    if (direction === 'debit') {
      const classes = await classBalances(tx, original.userId, original.currency, wallet);
      const available = classes[original.creditClass].spendable;
      if (available < input.amount) {
        throw new WalletError(
          'insufficient_credits',
          `Reversing ${input.amount} ${original.creditClass} Credits needs them spendable; the wallet has ${available} spendable ${original.creditClass} Credits.`,
        );
      }
    }
    const row = await append(tx, input, {
      currency: original.currency,
      entryType: 'reversal',
      direction,
      creditClass: original.creditClass,
      relatedTransactionId: original.id,
    });
    return { transaction: view(row), replayed: false };
  });
}

/* ------------------------------------------------------------------ *
 * Support adjustments (P2.4, PRD §30.1, §34.1-§34.3)
 * ------------------------------------------------------------------ */

/**
 * The daily caps on one operator's adjustments (PRD §34.3; decided
 * 2026-09-19): per operator, per currency, per UTC calendar day on the
 * database clock. A support safety rail, not an economy value: the admin page
 * is told them, never written with them. An adjustment that would pass its cap
 * is refused whole. There is no second-approver path.
 */
export const ADJUSTMENT_DAILY_CAPS: Readonly<Record<Direction, number>> = { credit: 500, debit: 1000 };

/** An operator's Credit lands in `earned` (decided 2026-09-19). A Debit follows the spend order. */
export const ADJUSTMENT_CREDIT_CLASS: CreditClass = 'earned';

export interface AdjustInput extends OperationInput {
  currency: string;
  direction: Direction;
  /** The operator: always recorded, and the one the caps count against. */
  actorUserId: string;
  /** Why. Required for every adjustment (§30.1, §34.2). */
  reason: string;
}

export interface AdjustmentLimit {
  cap: number;
  used: number;
  remaining: number;
}

export interface AdjustmentAllowance {
  currency: string;
  credit: AdjustmentLimit;
  debit: AdjustmentLimit;
}

const START_OF_UTC_DAY = sql`(date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')`;

/** What an operator has adjusted in a currency since the start of today (UTC), by direction. */
async function adjustedToday(db: Pick<Db, 'select'> | Tx, actorUserId: string, currency: string): Promise<Record<Direction, number>> {
  const t = walletTransactions;
  const rows = await db
    .select({ direction: t.direction, total: sql<string>`coalesce(sum(${t.amount}), 0)` })
    .from(t)
    .where(and(eq(t.entryType, 'admin_adjustment'), eq(t.actorUserId, actorUserId), eq(t.currency, currency), gte(t.createdAt, START_OF_UTC_DAY)))
    .groupBy(t.direction);
  const used: Record<Direction, number> = { credit: 0, debit: 0 };
  for (const row of rows) used[row.direction] = Number(row.total);
  return used;
}

const limit = (cap: number, used: number): AdjustmentLimit => ({ cap, used, remaining: Math.max(cap - used, 0) });

/** How much more an operator may Credit and Debit in a currency today. */
export async function readAdjustmentAllowance(db: Pick<Db, 'select'>, actorUserId: string, currency: string): Promise<AdjustmentAllowance> {
  const used = await adjustedToday(db, actorUserId, currency);
  return { currency, credit: limit(ADJUSTMENT_DAILY_CAPS.credit, used.credit), debit: limit(ADJUSTMENT_DAILY_CAPS.debit, used.debit) };
}

/**
 * ADJUSTMENT: an operator's Credit or Debit, as one `admin_adjustment` ledger
 * transaction carrying the operator and the reason -- the sixth operation,
 * under exactly the same rules as the other five: one transaction, the wallet
 * locked first, the idempotency key checked after the lock, nothing edited.
 *
 *   Credit  lands in `earned`. A user without a wallet in the currency gets
 *           one, created in the same transaction -- if the Credit is refused,
 *           no wallet is left behind.
 *   Debit   takes spendable Credits only (never held ones) from the class the
 *           spend order gives; refused when the classes would have to be
 *           split, or when the user has no wallet.
 *
 * NEVER ONE'S OWN WALLET (P2.5.3). An operator cannot Credit or Debit their
 * own wallet in any currency: another operator must. Refused before anything is
 * locked, opened or written, so it opens no wallet and uses no allowance --
 * and, being here, it holds for every way an adjustment can be made.
 *
 * THE CAPS HOLD UNDER CONCURRENCY. An operator's adjustments in a currency are
 * serialised by a transaction-scoped advisory lock taken BEFORE the wallet
 * lock, so two at once cannot both fit under the cap. No other operation takes
 * it, and it is always taken first, so it cannot deadlock with them. A replay
 * writes nothing and so counts nothing.
 *
 * Passing a transaction as `db` nests the adjustment in a savepoint: the admin
 * service commits it together with its audit record.
 */
export async function adjustWallet(db: WalletDb, input: AdjustInput): Promise<WalletOperationResult> {
  validate(input);
  if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) invalid('currency must be a wallet currency code.');
  if (input.direction !== 'credit' && input.direction !== 'debit') invalid('direction must be credit or debit.');
  if (typeof input.actorUserId !== 'string' || !UUID.test(input.actorUserId)) invalid('An adjustment must name the operator making it.');
  // User IDs are compared as UUIDs, not as text: a path may spell one in upper case.
  if (input.actorUserId.toLowerCase() === input.userId.toLowerCase()) {
    throw new WalletError('own_wallet', 'You cannot adjust your own wallet. Another operator must make this adjustment.');
  }
  if (typeof input.reason !== 'string' || input.reason.trim() === '') invalid('An adjustment needs a reason.');
  const expected: Material = {
    entryType: 'admin_adjustment',
    direction: input.direction,
    amount: input.amount,
    relatedTransactionId: null,
    source: input.source ?? null,
  };
  return operate(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wallet-adjustment:${input.actorUserId}:${input.currency}`}, 0))`);
    let wallet = await lockWallet(tx, input.userId, input.currency);
    if (!wallet) {
      if (input.direction === 'debit') throw new WalletError('wallet_not_found', `The user has no ${input.currency} wallet to debit.`);
      await tx.insert(wallets).values({ userId: input.userId, currency: input.currency }).onConflictDoNothing();
      wallet = (await lockWallet(tx, input.userId, input.currency))!;
    }
    const existing = await byKey(tx, input.userId, input.currency, input.idempotencyKey);
    if (existing) return replay(existing, expected);

    const cap = ADJUSTMENT_DAILY_CAPS[input.direction];
    const used = (await adjustedToday(tx, input.actorUserId, input.currency))[input.direction];
    if (used + input.amount > cap) {
      throw new WalletError(
        'adjustment_cap_exceeded',
        `This ${input.direction} of ${input.amount} would take your ${input.currency} ${input.direction}s today to ${used + input.amount}, over the daily cap of ${cap}; ${Math.max(cap - used, 0)} remain.`,
      );
    }

    const creditClass =
      input.direction === 'credit'
        ? ADJUSTMENT_CREDIT_CLASS
        : await spendClass(tx, input.userId, input.currency, wallet, input.amount, 'Debiting');
    const row = await append(tx, input, {
      currency: input.currency,
      entryType: 'admin_adjustment',
      direction: input.direction,
      creditClass,
      relatedTransactionId: null,
    });
    return { transaction: view(row), replayed: false };
  });
}

/* ------------------------------------------------------------------ *
 * Granting (P9.2) -- Credits a confirmed payment entitles a customer to
 * ------------------------------------------------------------------ */

export interface GrantInput extends OperationInput {
  currency: string;
  /**
   * Which class the Credits land in. A plan's included allowance is
   * `included`; Credits bought outright are `purchased`. The caller states it
   * because only the caller knows what was paid for -- this module will not
   * guess, and the class decides expiry and refund treatment later (§6.3).
   */
  creditClass: CreditClass;
}

/**
 * GRANT: adds Credits to a wallet, as one `grant` ledger transaction.
 *
 * THE SEVENTH OPERATION, under exactly the same rules as the other six: one
 * transaction, the wallet locked first, the idempotency key checked after the
 * lock, nothing edited. A replay returns the original grant and adds nothing,
 * which is what makes a redelivered payment event safe.
 *
 * IT PROVES NOTHING ABOUT PAYMENT. This module cannot tell a confirmed payment
 * from an imagined one, so it does not try: the caller must already have the
 * provider's confirmation, and `source` must name what it was. Passing a
 * transaction as `db` commits the grant with the subscription it came from, so
 * a customer can never end up with the Credits but not the plan, or the plan
 * but not the Credits.
 *
 * A user without a wallet in the currency gets one, created in the same
 * transaction -- if the grant is refused, no wallet is left behind.
 */
export async function grantCredits(db: WalletDb, input: GrantInput): Promise<WalletOperationResult> {
  validate(input);
  if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) invalid('currency must be a wallet currency code.');
  if (!CREDIT_SPEND_ORDER.includes(input.creditClass)) {
    invalid(`creditClass must be one of: ${CREDIT_SPEND_ORDER.join(', ')}.`);
  }
  const expected: Material = { entryType: 'grant', amount: input.amount, relatedTransactionId: null, source: input.source ?? null };
  return operate(db, async (tx) => {
    let wallet = await lockWallet(tx, input.userId, input.currency);
    if (!wallet) {
      await tx.insert(wallets).values({ userId: input.userId, currency: input.currency }).onConflictDoNothing();
      wallet = (await lockWallet(tx, input.userId, input.currency))!;
    }
    const existing = await byKey(tx, input.userId, input.currency, input.idempotencyKey);
    if (existing) return replay(existing, expected);

    const row = await append(tx, input, {
      currency: input.currency,
      entryType: 'grant',
      direction: 'credit',
      creditClass: input.creditClass,
      relatedTransactionId: null,
    });
    return { transaction: view(row), replayed: false };
  });
}

/* ------------------------------------------------------------------ *
 * Reading for support (P2.4)
 * ------------------------------------------------------------------ */

export interface WalletSummary {
  currency: string;
  /** False when the user has no wallet in this currency yet: then everything is zero. */
  exists: boolean;
  /** Spendable Credits. */
  balance: number;
  /** Credits held for actions in flight; not spendable. */
  held: number;
  /** Transactions applied. */
  version: number;
  classes: Record<CreditClass, { spendable: number; held: number }>;
}

const emptyClasses = (): WalletSummary['classes'] =>
  Object.fromEntries(CREDIT_SPEND_ORDER.map((c) => [c, { spendable: 0, held: 0 }])) as WalletSummary['classes'];

/**
 * A user's wallet in every currency there is, READ-ONLY, from one snapshot:
 * the cached balance and held Credits, and the per-class figures derived from
 * the ledger. A currency the user has no wallet in reads as empty.
 */
export async function readWalletSummaries(db: Pick<Db, 'transaction'>, userId: string): Promise<WalletSummary[]> {
  return db.transaction(
    async (tx) => {
      const currencies = await tx.select({ code: walletCurrencies.code }).from(walletCurrencies).orderBy(asc(walletCurrencies.code));
      const rows = await tx
        .select({ currency: wallets.currency, balance: wallets.balance, held: wallets.held, version: wallets.version })
        .from(wallets)
        .where(eq(wallets.userId, userId));
      const summaries: WalletSummary[] = [];
      for (const { code } of currencies) {
        const row = rows.find((r) => r.currency === code);
        summaries.push(
          row
            ? { currency: code, exists: true, balance: row.balance, held: row.held, version: row.version, classes: await deriveClassBalances(tx, userId, code) }
            : { currency: code, exists: false, balance: 0, held: 0, version: 0, classes: emptyClasses() },
        );
      }
      return summaries;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Whether a wallet currency with this code exists. */
export async function isWalletCurrency(db: Pick<Db, 'select'>, code: string): Promise<boolean> {
  const [row] = await db.select({ code: walletCurrencies.code }).from(walletCurrencies).where(eq(walletCurrencies.code, code));
  return Boolean(row);
}

export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 200;

export interface WalletHistoryPage {
  /** Newest first. */
  transactions: WalletTransactionView[];
  /** Pass as `before` for the next, older page; null at the start of the history. */
  nextBefore: number | null;
}

/** A wallet's transactions, newest first, a page at a time by sequence. READ-ONLY. */
export async function readWalletHistory(
  db: Pick<Db, 'select'>,
  userId: string,
  currency: string,
  page: { before?: number | null; limit?: number } = {},
): Promise<WalletHistoryPage> {
  const size = Math.min(Math.max(Math.trunc(page.limit ?? HISTORY_PAGE_DEFAULT), 1), HISTORY_PAGE_MAX);
  const t = walletTransactions;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.userId, userId), eq(t.currency, currency), page.before != null ? lt(t.sequence, page.before) : undefined))
    .orderBy(desc(t.sequence))
    .limit(size + 1);
  const shown = rows.slice(0, size);
  return {
    transactions: shown.map(view),
    nextBefore: rows.length > size ? shown.at(-1)!.sequence : null,
  };
}
