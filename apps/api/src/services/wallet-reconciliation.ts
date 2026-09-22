import { and, asc, eq, gt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { wallets, walletTransactions, type WalletTransactionRow } from '../db/schema.js';

/**
 * WALLET REBUILD AND RECONCILIATION (P2.3, PRD §19.2 "auditable,
 * reconcilable").
 *
 * READ-ONLY. This module never writes: it has no insert, update or delete,
 * takes no lock, and cannot repair anything -- a balance is never written
 * directly, for anyone, ever (§30.1). It answers two questions:
 *
 *   rebuildWallet    What does the LEDGER say this wallet holds? Every
 *                    transaction is replayed in sequence order with the
 *                    effect migration 0034 gives it. The cached wallet row is
 *                    never read, so a wrong cache cannot hide itself.
 *   reconcileWallet  Does the cached wallet agree with that, and is the
 *                    ledger internally sound? Every discrepancy is listed,
 *                    in a fixed order, with what was expected and what is
 *                    there.
 *
 * With migration 0034's triggers in place none of these discrepancies can
 * arise. Reconciliation exists for when they have been bypassed -- a manual
 * SQL session, a disabled trigger, a bad restore -- and to prove, routinely,
 * that they have not been.
 *
 * ONE SNAPSHOT PER WALLET. Each wallet is read in a REPEATABLE READ, READ ONLY
 * transaction, so its row and its ledger come from one instant: a write
 * committed mid-check can never show up as a false discrepancy, and the check
 * never blocks a writer. Safe to run repeatedly, at any time.
 *
 * DETERMINISTIC. The same database state always gives the same report: no
 * clock, no random order. Wallets are visited by (user, currency); the ledger
 * by sequence.
 */

type Row = Pick<
  WalletTransactionRow,
  'id' | 'sequence' | 'entryType' | 'direction' | 'amount' | 'creditClass' | 'balanceAfter' | 'heldAfter' | 'relatedTransactionId'
>;
type CreditClass = WalletTransactionRow['creditClass'];
type Reader = Pick<Db, 'transaction'>;

const CLASSES: readonly CreditClass[] = ['included', 'earned', 'purchased'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the ledger says a wallet holds. */
export interface WalletRebuild {
  userId: string;
  currency: string;
  /** Spendable Credits. */
  balance: number;
  /** Credits held for actions in flight; not spendable. */
  held: number;
  /** Transactions applied: what the wallet's `version` must be. */
  version: number;
  /** Spendable and held Credits per class. */
  classes: Record<CreditClass, { spendable: number; held: number }>;
}

export type WalletDiscrepancy =
  /** The cached wallet disagrees with its ledger. */
  | { kind: 'balance_mismatch'; expected: number; actual: number }
  | { kind: 'held_mismatch'; expected: number; actual: number }
  | { kind: 'version_mismatch'; expected: number; actual: number }
  /** Transactions exist but the wallet row does not. */
  | { kind: 'wallet_missing' }
  /** The sequence skips: a transaction is missing between these two. */
  | { kind: 'sequence_gap'; after: number; next: number }
  /** A transaction's stamped result does not follow from the one before it and its own amount. */
  | { kind: 'stamped_balance_mismatch'; sequence: number; transactionId: string; expected: number; actual: number }
  | { kind: 'stamped_held_mismatch'; sequence: number; transactionId: string; expected: number; actual: number }
  /** A Credit class went below zero -- the first transaction at which it did. */
  | { kind: 'class_below_zero'; creditClass: CreditClass; sequence: number; transactionId: string; spendable: number; held: number }
  /** A hold settled, or a transaction refunded or reversed, for more than its amount. */
  | { kind: 'over_settled'; transactionId: string; amount: number; settled: number };

export interface WalletReconciliation {
  userId: string;
  currency: string;
  status: 'clean' | 'discrepant';
  expected: WalletRebuild;
  /** The cached wallet row, or null when there is none. */
  actual: { balance: number; held: number; version: number } | null;
  discrepancies: WalletDiscrepancy[];
}

/** A transaction's effect on spendable and held Credits, exactly as migration 0034 applies it. */
function effect(row: Row): { spendable: number; held: number } {
  switch (row.entryType) {
    case 'hold':
      return { spendable: -row.amount, held: row.amount };
    case 'capture':
      return { spendable: 0, held: -row.amount };
    case 'release':
      return { spendable: row.amount, held: -row.amount };
    default:
      return { spendable: row.direction === 'credit' ? row.amount : -row.amount, held: 0 };
  }
}

async function ledgerOf(tx: Parameters<Parameters<Reader['transaction']>[0]>[0], userId: string, currency: string): Promise<Row[]> {
  const t = walletTransactions;
  return tx
    .select({
      id: t.id,
      sequence: t.sequence,
      entryType: t.entryType,
      direction: t.direction,
      amount: t.amount,
      creditClass: t.creditClass,
      balanceAfter: t.balanceAfter,
      heldAfter: t.heldAfter,
      relatedTransactionId: t.relatedTransactionId,
    })
    .from(t)
    .where(and(eq(t.userId, userId), eq(t.currency, currency)))
    .orderBy(asc(t.sequence));
}

/**
 * Replays a ledger, checking it as it goes. Returns the rebuilt state and the
 * ledger's own discrepancies (gaps, broken stamps, a class below zero,
 * over-settlement), in sequence order.
 */
function replay(userId: string, currency: string, ledger: Row[]): { rebuild: WalletRebuild; discrepancies: WalletDiscrepancy[] } {
  const discrepancies: WalletDiscrepancy[] = [];
  const classes = Object.fromEntries(CLASSES.map((c) => [c, { spendable: 0, held: 0 }])) as WalletRebuild['classes'];
  const belowZero = new Set<CreditClass>();
  const settled = new Map<string, number>();
  let balance = 0;
  let held = 0;
  let previous: Row | null = null;

  for (const row of ledger) {
    const expectedSequence = (previous?.sequence ?? 0) + 1;
    if (row.sequence !== expectedSequence) discrepancies.push({ kind: 'sequence_gap', after: previous?.sequence ?? 0, next: row.sequence });

    const change = effect(row);
    balance += change.spendable;
    held += change.held;

    // Each stamp must follow from the previous STAMP and this row's own effect, so
    // one altered row is reported once, not as every row after it.
    const stampedBalance = (previous?.balanceAfter ?? 0) + change.spendable;
    const stampedHeld = (previous?.heldAfter ?? 0) + change.held;
    if (row.balanceAfter !== stampedBalance) {
      discrepancies.push({ kind: 'stamped_balance_mismatch', sequence: row.sequence, transactionId: row.id, expected: stampedBalance, actual: row.balanceAfter });
    }
    if (row.heldAfter !== stampedHeld) {
      discrepancies.push({ kind: 'stamped_held_mismatch', sequence: row.sequence, transactionId: row.id, expected: stampedHeld, actual: row.heldAfter });
    }

    const cls = (classes[row.creditClass] ??= { spendable: 0, held: 0 });
    cls.spendable += change.spendable;
    cls.held += change.held;
    if ((cls.spendable < 0 || cls.held < 0) && !belowZero.has(row.creditClass)) {
      belowZero.add(row.creditClass);
      discrepancies.push({ kind: 'class_below_zero', creditClass: row.creditClass, sequence: row.sequence, transactionId: row.id, spendable: cls.spendable, held: cls.held });
    }

    if (row.relatedTransactionId) settled.set(row.relatedTransactionId, (settled.get(row.relatedTransactionId) ?? 0) + row.amount);
    previous = row;
  }

  // Settlements (of a hold) and compensations (of anything else) never exceed what they name.
  for (const row of ledger) {
    const total = settled.get(row.id) ?? 0;
    if (total > row.amount) discrepancies.push({ kind: 'over_settled', transactionId: row.id, amount: row.amount, settled: total });
  }

  return { rebuild: { userId, currency, balance, held, version: ledger.length, classes }, discrepancies };
}

const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/**
 * What the ledger says a wallet holds, from the ledger alone -- the cached
 * wallet row is not read. A wallet with no transactions holds nothing.
 */
export async function rebuildWallet(db: Reader, userId: string, currency: string): Promise<WalletRebuild> {
  return db.transaction(async (tx) => replay(userId, currency, await ledgerOf(tx, userId, currency)).rebuild, SNAPSHOT);
}

/** Checks one wallet: its cached row against its rebuilt ledger, and the ledger itself. */
export async function reconcileWallet(db: Reader, userId: string, currency: string): Promise<WalletReconciliation> {
  return db.transaction(async (tx) => {
    const [cached] = await tx
      .select({ balance: wallets.balance, held: wallets.held, version: wallets.version })
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)));
    const { rebuild, discrepancies: ledgerDiscrepancies } = replay(userId, currency, await ledgerOf(tx, userId, currency));

    const discrepancies: WalletDiscrepancy[] = [];
    if (!cached) {
      if (rebuild.version > 0) discrepancies.push({ kind: 'wallet_missing' });
    } else {
      if (cached.balance !== rebuild.balance) discrepancies.push({ kind: 'balance_mismatch', expected: rebuild.balance, actual: cached.balance });
      if (cached.held !== rebuild.held) discrepancies.push({ kind: 'held_mismatch', expected: rebuild.held, actual: cached.held });
      if (cached.version !== rebuild.version) discrepancies.push({ kind: 'version_mismatch', expected: rebuild.version, actual: cached.version });
    }
    discrepancies.push(...ledgerDiscrepancies);

    return {
      userId,
      currency,
      status: discrepancies.length === 0 ? 'clean' : 'discrepant',
      expected: rebuild,
      actual: cached ?? null,
      discrepancies,
    };
  }, SNAPSHOT);
}

export interface ReconcileWalletsOptions {
  /** Only wallets of this currency. */
  currency?: string;
  /** Resume after this wallet: the `next` of a previous page. */
  after?: { userId: string; currency: string } | null;
  /** Wallets per page. */
  limit?: number;
}

export interface WalletsReconciliation {
  checked: number;
  clean: number;
  /** Only the wallets that disagree, in (user, currency) order. */
  discrepant: WalletReconciliation[];
  /** Pass as `after` to continue; null when every wallet has been checked. */
  next: { userId: string; currency: string } | null;
}

export const RECONCILE_PAGE_DEFAULT = 100;
export const RECONCILE_PAGE_MAX = 1000;

/**
 * Checks wallets page by page, in (user, currency) order, each against its own
 * ledger in its own snapshot. For operations and support: run it as often as
 * wanted; it reports and never changes anything.
 */
export async function reconcileWallets(db: Pick<Db, 'select' | 'transaction'>, options: ReconcileWalletsOptions = {}): Promise<WalletsReconciliation> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? RECONCILE_PAGE_DEFAULT), 1), RECONCILE_PAGE_MAX);
  const after = options.after ?? null;
  if (after && !UUID.test(after.userId)) throw new Error('reconcileWallets: `after.userId` must be a user id.');

  const page = await db
    .select({ userId: wallets.userId, currency: wallets.currency })
    .from(wallets)
    .where(
      and(
        options.currency ? eq(wallets.currency, options.currency) : undefined,
        after ? or(gt(wallets.userId, after.userId), and(eq(wallets.userId, after.userId), gt(wallets.currency, after.currency))) : undefined,
      ),
    )
    .orderBy(asc(wallets.userId), asc(wallets.currency))
    .limit(limit + 1);

  const visit = page.slice(0, limit);
  const discrepant: WalletReconciliation[] = [];
  for (const w of visit) {
    const result = await reconcileWallet(db, w.userId, w.currency);
    if (result.status === 'discrepant') discrepant.push(result);
  }
  const last = visit.at(-1);
  return {
    checked: visit.length,
    clean: visit.length - discrepant.length,
    discrepant,
    next: page.length > limit && last ? { userId: last.userId, currency: last.currency } : null,
  };
}
