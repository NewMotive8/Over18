import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  captureHold,
  holdCredits,
  refundTransaction,
  releaseHold,
  reverseTransaction,
  type WalletOperationResult,
} from '../services/wallet-service.js';
import { reconcileWallet } from '../services/wallet-reconciliation.js';
import { createTestContext, destroyTestContext, migrateTestDb, truncateAll, type TestContext } from './helpers.js';

/**
 * PRD v1.2 P2.3 -- THE IDEMPOTENCY BOUNDARY, proven the same way for every
 * wallet operation: one key, one operation, one ledger transaction, one
 * financial effect -- whether the key is replayed, raced, reused for something
 * else, or first refused. Every amount is an arbitrary test figure.
 */

let on: TestContext;
beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => truncateAll(on));

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  on.pool.query<T & import('pg').QueryResultRow>(text, params);

async function user(): Promise<string> {
  const email = `${randomUUID()}@test.local`;
  const id = (await q<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'not-a-hash') RETURNING id", [email])).rows[0]!.id;
  await q("INSERT INTO wallets (user_id, currency) VALUES ($1, 'credits')", [id]);
  return id;
}

/** Raw P2.1 rows: granting and charging are not wallet-service operations. */
async function raw(userId: string, entryType: 'grant' | 'paid_action', amount: number): Promise<string> {
  const direction = entryType === 'grant' ? 'credit' : 'debit';
  return (
    await q<{ id: string }>(
      `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
       VALUES ($1, 'credits', $2, $3, $4, 'purchased', $5) RETURNING id`,
      [userId, entryType, direction, amount, `fixture:${randomUUID()}`],
    )
  ).rows[0]!.id;
}

async function walletOf(userId: string) {
  return (await q<{ balance: number; held: number; version: number }>("SELECT balance, held, version FROM wallets WHERE user_id = $1 AND currency = 'credits'", [userId]))
    .rows[0]!;
}

async function rowsWithKey(userId: string, key: string): Promise<number> {
  return (await q<{ n: number }>("SELECT count(*)::int AS n FROM wallet_transactions WHERE user_id = $1 AND idempotency_key = $2", [userId, key])).rows[0]!.n;
}

type Run = (key: string, amount?: number) => Promise<WalletOperationResult>;

/**
 * Each operation, set up so that small amounts succeed and 1000 is refused.
 * A funded wallet of 100; a hold of 50 to settle; a paid action of 50 to refund;
 * a grant of 100 to reverse.
 */
const OPERATIONS: Array<{ name: string; prepare: (userId: string) => Promise<Run> }> = [
  {
    name: 'hold',
    prepare: async (u) => {
      await raw(u, 'grant', 100);
      return (key, amount = 3) => holdCredits(on.db, { userId: u, currency: 'credits', amount, idempotencyKey: key });
    },
  },
  {
    name: 'capture',
    prepare: async (u) => {
      await raw(u, 'grant', 100);
      const hold = (await holdCredits(on.db, { userId: u, currency: 'credits', amount: 50, idempotencyKey: 'setup' })).transaction.id;
      return (key, amount = 3) => captureHold(on.db, { userId: u, holdTransactionId: hold, amount, idempotencyKey: key });
    },
  },
  {
    name: 'release',
    prepare: async (u) => {
      await raw(u, 'grant', 100);
      const hold = (await holdCredits(on.db, { userId: u, currency: 'credits', amount: 50, idempotencyKey: 'setup' })).transaction.id;
      return (key, amount = 3) => releaseHold(on.db, { userId: u, holdTransactionId: hold, amount, idempotencyKey: key });
    },
  },
  {
    name: 'refund',
    prepare: async (u) => {
      await raw(u, 'grant', 100);
      const paid = await raw(u, 'paid_action', 50);
      return (key, amount = 3) => refundTransaction(on.db, { userId: u, transactionId: paid, amount, idempotencyKey: key });
    },
  },
  {
    name: 'reversal',
    prepare: async (u) => {
      const granted = await raw(u, 'grant', 100);
      return (key, amount = 3) => reverseTransaction(on.db, { userId: u, transactionId: granted, amount, idempotencyKey: key });
    },
  },
];

describe.each(OPERATIONS)('the idempotency boundary: $name', ({ prepare }) => {
  it('a replay returns the recorded transaction exactly, with one financial effect', async () => {
    const u = await user();
    const run = await prepare(u);
    const first = await run('op-1');
    const after = await walletOf(u);
    const again = await run('op-1');
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ transaction: first.transaction, replayed: true });
    expect(await rowsWithKey(u, 'op-1')).toBe(1);
    expect(await walletOf(u)).toEqual(after);
  });

  it('the result stays the one recorded, whatever the wallet has done since', async () => {
    const u = await user();
    const run = await prepare(u);
    const first = await run('op-1');
    await run('op-2');
    await run('op-3');
    const later = await run('op-1');
    expect(later.transaction.balanceAfter).toBe(first.transaction.balanceAfter);
    expect(later.transaction.heldAfter).toBe(first.transaction.heldAfter);
    expect(later.transaction.sequence).toBe(first.transaction.sequence);
  });

  it('concurrent duplicates write one transaction, and every caller gets it', async () => {
    const u = await user();
    const run = await prepare(u);
    const before = await walletOf(u);
    const results = await Promise.all(Array.from({ length: 6 }, () => run('double-tap')));
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await rowsWithKey(u, 'double-tap')).toBe(1);
    expect((await walletOf(u)).version).toBe(before.version + 1);
    expect((await reconcileWallet(on.db, u, 'credits')).status).toBe('clean');
  });

  it('a key reused for a different amount is refused, and writes nothing', async () => {
    const u = await user();
    const run = await prepare(u);
    await run('op-1', 3);
    const before = await walletOf(u);
    await expect(run('op-1', 4)).rejects.toMatchObject({ name: 'WalletError', code: 'idempotency_conflict' });
    expect(await walletOf(u)).toEqual(before);
    expect(await rowsWithKey(u, 'op-1')).toBe(1);
  });

  it('a refused operation records nothing and does not use up its key: a retry is evaluated afresh', async () => {
    const u = await user();
    const run = await prepare(u);
    const before = await walletOf(u);
    await expect(run('retry-me', 1000)).rejects.toMatchObject({ name: 'WalletError' });
    expect(await rowsWithKey(u, 'retry-me')).toBe(0);
    expect(await walletOf(u)).toEqual(before);
    const retried = await run('retry-me', 3);
    expect(retried.replayed).toBe(false);
    expect(await rowsWithKey(u, 'retry-me')).toBe(1);
  });
});

describe('the boundary across operations and wallets', () => {
  it('one key names one operation in a wallet: a different operation under it is refused', async () => {
    const u = await user();
    await raw(u, 'grant', 100);
    const hold = (await holdCredits(on.db, { userId: u, currency: 'credits', amount: 10, idempotencyKey: 'shared' })).transaction;
    for (const attempt of [
      () => captureHold(on.db, { userId: u, holdTransactionId: hold.id, amount: 10, idempotencyKey: 'shared' }),
      () => releaseHold(on.db, { userId: u, holdTransactionId: hold.id, amount: 10, idempotencyKey: 'shared' }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'idempotency_conflict' });
    }
    expect(await rowsWithKey(u, 'shared')).toBe(1);
  });

  it("one user's key never touches another user's wallet", async () => {
    const alice = await user();
    const bob = await user();
    await raw(alice, 'grant', 100);
    await raw(bob, 'grant', 100);
    const a = await holdCredits(on.db, { userId: alice, currency: 'credits', amount: 5, idempotencyKey: 'same-key' });
    const b = await holdCredits(on.db, { userId: bob, currency: 'credits', amount: 5, idempotencyKey: 'same-key' });
    expect(b.replayed).toBe(false);
    expect(b.transaction.id).not.toBe(a.transaction.id);
    expect(await walletOf(alice)).toMatchObject({ balance: 95, held: 5 });
    expect(await walletOf(bob)).toMatchObject({ balance: 95, held: 5 });
  });
});
