import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ADJUSTMENT_CREDIT_CLASS,
  ADJUSTMENT_DAILY_CAPS,
  adjustWallet,
  holdCredits,
  readAdjustmentAllowance,
  readCommercialWallet,
  readWalletHistory,
  readWalletSummaries,
  type AdjustInput,
} from '../services/wallet-service.js';
import { reconcileWallet } from '../services/wallet-reconciliation.js';
import { createTestContext, destroyTestContext, migrateTestDb, truncateAll, type TestContext } from './helpers.js';

/**
 * PRD v1.2 P2.4 -- an operator's support adjustment, as a wallet operation.
 *
 * The rules (decided 2026-09-19): a Credit lands in `earned` and opens a wallet
 * if there is none; a Debit follows the spend order, refuses to split across
 * classes and refuses a user with no wallet; per operator, per currency, per
 * UTC day an operator may Credit 500 and Debit 1,000, and an adjustment that
 * would pass its cap is refused whole. Funding and history fixtures are raw
 * P2.1 rows; every other amount is the rule being tested.
 */

let on: TestContext;
const OTHER = 'test_p24_currency';

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
  await q('INSERT INTO wallet_currencies (code) VALUES ($1) ON CONFLICT DO NOTHING', [OTHER]);
});
afterAll(async () => {
  await truncateAll(on);
  await q('DELETE FROM wallet_currencies WHERE code = $1', [OTHER]);
  await destroyTestContext(on);
});
beforeEach(async () => truncateAll(on));
afterEach(async () => {
  const enabled = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'wallet%' AND tgenabled = 'O'");
  expect(enabled.rows[0]!.n).toBe(4);
});

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  on.pool.query<T & import('pg').QueryResultRow>(text, params);

async function user(withWallet = true): Promise<string> {
  const email = `${randomUUID()}@test.local`;
  const id = (await q<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'not-a-hash') RETURNING id", [email])).rows[0]!.id;
  if (withWallet) await q("INSERT INTO wallets (user_id, currency) VALUES ($1, 'credits')", [id]);
  return id;
}

async function fund(userId: string, amount: number, creditClass: 'included' | 'earned' | 'purchased', currency = 'credits') {
  await q('INSERT INTO wallets (user_id, currency) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, currency]);
  await q(
    `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
     VALUES ($1, $2, 'grant', 'credit', $3, $4, $5)`,
    [userId, currency, amount, creditClass, `fixture:${randomUUID()}`],
  );
}

async function walletOf(userId: string, currency = 'credits') {
  return (await q<{ balance: number; held: number; version: number }>('SELECT balance, held, version FROM wallets WHERE user_id = $1 AND currency = $2', [userId, currency]))
    .rows[0];
}

const operator = randomUUID();
const adjust = (over: Partial<AdjustInput> & Pick<AdjustInput, 'userId' | 'direction' | 'amount'>) =>
  adjustWallet(on.db, { currency: 'credits', idempotencyKey: randomUUID(), actorUserId: operator, reason: 'Support goodwill', ...over });
const refusal = (code: string) => ({ name: 'WalletError', code });

/* ------------------------------------------------------------------ *
 * Credit
 * ------------------------------------------------------------------ */

describe('an operator Credit', () => {
  it('adds Credits in the earned class, recording the operator and the reason', async () => {
    const u = await user();
    const { transaction, replayed } = await adjust({ userId: u, direction: 'credit', amount: 40, reason: 'Failed generation goodwill', source: { type: 'support_reference', id: 'T-1' } });
    expect(ADJUSTMENT_CREDIT_CLASS).toBe('earned');
    expect(replayed).toBe(false);
    expect(transaction).toMatchObject({
      entryType: 'admin_adjustment',
      direction: 'credit',
      amount: 40,
      creditClass: 'earned',
      balanceAfter: 40,
      actorUserId: operator,
      reason: 'Failed generation goodwill',
      source: { type: 'support_reference', id: 'T-1' },
    });
    expect(await readCommercialWallet(on.db, u, 'credits')).toEqual({ included: 0, earned: 40, purchased: 0, held: 0, spendable: 40 });
  });

  it('opens a wallet for a user who has none, in the same transaction', async () => {
    const u = await user(false);
    expect(await walletOf(u)).toBeUndefined();
    expect((await adjust({ userId: u, direction: 'credit', amount: 25 })).transaction).toMatchObject({ sequence: 1, balanceAfter: 25 });
    expect(await walletOf(u)).toEqual({ balance: 25, held: 0, version: 1 });
  });

  it('leaves no wallet behind when a Credit to a user without one is refused', async () => {
    const u = await user(false);
    await expect(adjust({ userId: u, direction: 'credit', amount: ADJUSTMENT_DAILY_CAPS.credit + 1 })).rejects.toMatchObject(refusal('adjustment_cap_exceeded'));
    expect(await walletOf(u)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Debit
 * ------------------------------------------------------------------ */

describe('an operator Debit', () => {
  it('takes spendable Credits by the spend order, included first', async () => {
    const u = await user();
    await fund(u, 30, 'purchased');
    await fund(u, 30, 'earned');
    await fund(u, 30, 'included');
    expect((await adjust({ userId: u, direction: 'debit', amount: 20 })).transaction).toMatchObject({ direction: 'debit', creditClass: 'included', balanceAfter: 70 });
    // 10 included left: not enough for 15, so earned covers it whole.
    expect((await adjust({ userId: u, direction: 'debit', amount: 15 })).transaction.creditClass).toBe('earned');
    expect((await adjust({ userId: u, direction: 'debit', amount: 30 })).transaction.creditClass).toBe('purchased');
  });

  it('is refused when it would have to split across classes, and when the balance does not cover it', async () => {
    const u = await user();
    await fund(u, 10, 'included');
    await fund(u, 10, 'earned');
    await expect(adjust({ userId: u, direction: 'debit', amount: 15 })).rejects.toMatchObject(refusal('credit_class_split_required'));
    await expect(adjust({ userId: u, direction: 'debit', amount: 21 })).rejects.toMatchObject(refusal('insufficient_credits'));
    expect(await walletOf(u)).toEqual({ balance: 20, held: 0, version: 2 });
  });

  it('never takes held Credits', async () => {
    const u = await user();
    await fund(u, 50, 'purchased');
    await holdCredits(on.db, { userId: u, currency: 'credits', amount: 40, idempotencyKey: 'in-flight' });
    await expect(adjust({ userId: u, direction: 'debit', amount: 11 })).rejects.toMatchObject(refusal('insufficient_credits'));
    expect((await adjust({ userId: u, direction: 'debit', amount: 10 })).transaction).toMatchObject({ balanceAfter: 0, heldAfter: 40 });
  });

  it('is refused for a user with no wallet, and opens none', async () => {
    const u = await user(false);
    await expect(adjust({ userId: u, direction: 'debit', amount: 1 })).rejects.toMatchObject(refusal('wallet_not_found'));
    expect(await walletOf(u)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The daily caps
 * ------------------------------------------------------------------ */

describe('the daily caps: per operator, per currency, per UTC day', () => {
  it('are 500 to Credit and 1,000 to Debit', () => {
    expect(ADJUSTMENT_DAILY_CAPS).toEqual({ credit: 500, debit: 1000 });
  });

  it('a Credit exactly reaching 500 succeeds; one Credit over it is refused whole', async () => {
    const a = await user();
    const b = await user();
    await adjust({ userId: a, direction: 'credit', amount: 300 });
    await adjust({ userId: b, direction: 'credit', amount: 200 });
    await expect(adjust({ userId: a, direction: 'credit', amount: 1 })).rejects.toMatchObject(refusal('adjustment_cap_exceeded'));
    expect(await walletOf(a)).toEqual({ balance: 300, held: 0, version: 1 });
    expect(await readAdjustmentAllowance(on.db, operator, 'credits')).toEqual({
      currency: 'credits',
      credit: { cap: 500, used: 500, remaining: 0 },
      debit: { cap: 1000, used: 0, remaining: 1000 },
    });
  });

  it('a Credit that would pass the cap is refused whole, not trimmed to fit', async () => {
    const u = await user();
    await adjust({ userId: u, direction: 'credit', amount: 450 });
    await expect(adjust({ userId: u, direction: 'credit', amount: 51 })).rejects.toMatchObject(refusal('adjustment_cap_exceeded'));
    expect((await adjust({ userId: u, direction: 'credit', amount: 50 })).transaction.balanceAfter).toBe(500);
  });

  it('a Debit exactly reaching 1,000 succeeds; one over it is refused whole', async () => {
    const u = await user();
    await fund(u, 5000, 'purchased');
    await adjust({ userId: u, direction: 'debit', amount: 600 });
    await expect(adjust({ userId: u, direction: 'debit', amount: 401 })).rejects.toMatchObject(refusal('adjustment_cap_exceeded'));
    await adjust({ userId: u, direction: 'debit', amount: 400 });
    await expect(adjust({ userId: u, direction: 'debit', amount: 1 })).rejects.toMatchObject(refusal('adjustment_cap_exceeded'));
    expect(await walletOf(u)).toMatchObject({ balance: 4000 });
  });

  it('Credit and Debit caps are separate', async () => {
    const u = await user();
    await adjust({ userId: u, direction: 'credit', amount: 500 });
    expect((await adjust({ userId: u, direction: 'debit', amount: 500 })).transaction.balanceAfter).toBe(0);
  });

  it('each currency has its own caps', async () => {
    const u = await user();
    await adjust({ userId: u, direction: 'credit', amount: 500 });
    await expect(adjust({ userId: u, direction: 'credit', amount: 1 })).rejects.toMatchObject(refusal('adjustment_cap_exceeded'));
    expect((await adjust({ userId: u, direction: 'credit', amount: 500, currency: OTHER })).transaction).toMatchObject({ currency: OTHER, balanceAfter: 500 });
    expect((await readAdjustmentAllowance(on.db, operator, OTHER)).credit).toEqual({ cap: 500, used: 500, remaining: 0 });
  });

  it('each operator has their own caps', async () => {
    const u = await user();
    await adjust({ userId: u, direction: 'credit', amount: 500 });
    const colleague = randomUUID();
    expect((await adjust({ userId: u, direction: 'credit', amount: 500, actorUserId: colleague })).transaction.balanceAfter).toBe(1000);
  });

  it("counts only today's adjustments (UTC)", async () => {
    const u = await user();
    const early = await adjust({ userId: u, direction: 'credit', amount: 500 });
    // Move it into yesterday, bypassing the append-only guard for this fixture only.
    const client = await on.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE wallet_transactions DISABLE TRIGGER wallet_transactions_append_only');
      await client.query("UPDATE wallet_transactions SET created_at = date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '1 second' WHERE id = $1", [early.transaction.id]);
      await client.query('ALTER TABLE wallet_transactions ENABLE TRIGGER wallet_transactions_append_only');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect((await readAdjustmentAllowance(on.db, operator, 'credits')).credit.used).toBe(0);
    expect((await adjust({ userId: u, direction: 'credit', amount: 500 })).transaction.balanceAfter).toBe(1000);
  });

  it('a refused adjustment uses none of the allowance', async () => {
    const u = await user();
    await fund(u, 10, 'purchased');
    await expect(adjust({ userId: u, direction: 'debit', amount: 11 })).rejects.toMatchObject(refusal('insufficient_credits'));
    expect((await readAdjustmentAllowance(on.db, operator, 'credits')).debit.used).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Idempotency and concurrency
 * ------------------------------------------------------------------ */

describe('idempotency and concurrency', () => {
  it('a replay returns the recorded adjustment, writes nothing, and counts nothing against the cap', async () => {
    const u = await user();
    const first = await adjust({ userId: u, direction: 'credit', amount: 300, idempotencyKey: 'ticket-9' });
    const again = await adjust({ userId: u, direction: 'credit', amount: 300, idempotencyKey: 'ticket-9', reason: 'Retried' });
    expect(again).toEqual({ transaction: first.transaction, replayed: true });
    expect(await walletOf(u)).toEqual({ balance: 300, held: 0, version: 1 });
    expect((await readAdjustmentAllowance(on.db, operator, 'credits')).credit.used).toBe(300);
  });

  it('a key reused for a different amount or the other direction is refused', async () => {
    const u = await user();
    await fund(u, 100, 'purchased');
    await adjust({ userId: u, direction: 'credit', amount: 5, idempotencyKey: 'k' });
    await expect(adjust({ userId: u, direction: 'credit', amount: 6, idempotencyKey: 'k' })).rejects.toMatchObject(refusal('idempotency_conflict'));
    await expect(adjust({ userId: u, direction: 'debit', amount: 5, idempotencyKey: 'k' })).rejects.toMatchObject(refusal('idempotency_conflict'));
    expect(await walletOf(u)).toEqual({ balance: 105, held: 0, version: 2 });
  });

  it('needs a reason and the operator', async () => {
    const u = await user();
    await expect(adjust({ userId: u, direction: 'credit', amount: 1, reason: '   ' })).rejects.toMatchObject(refusal('invalid_request'));
    await expect(adjust({ userId: u, direction: 'credit', amount: 1, actorUserId: '' })).rejects.toMatchObject(refusal('invalid_request'));
    await expect(adjust({ userId: u, direction: 'sideways' as 'credit', amount: 1 })).rejects.toMatchObject(refusal('invalid_request'));
    expect(await walletOf(u)).toEqual({ balance: 0, held: 0, version: 0 });
  });

  it('concurrent Credits by one operator to different users never pass the cap together', async () => {
    const users = await Promise.all(Array.from({ length: 8 }, () => user()));
    const settled = await Promise.allSettled(users.map((u) => adjust({ userId: u, direction: 'credit', amount: 100 })));
    const succeeded = settled.filter((s) => s.status === 'fulfilled').length;
    const refused = settled.flatMap((s) => (s.status === 'rejected' ? [(s.reason as { code: string }).code] : []));
    expect(succeeded).toBe(5);
    expect(refused).toEqual(Array(3).fill('adjustment_cap_exceeded'));
    expect((await readAdjustmentAllowance(on.db, operator, 'credits')).credit).toEqual({ cap: 500, used: 500, remaining: 0 });
  });

  it('concurrent Debits never overdraw, and concurrent duplicates apply once', async () => {
    const u = await user();
    await fund(u, 100, 'purchased');
    const debits = await Promise.allSettled(Array.from({ length: 4 }, () => adjust({ userId: u, direction: 'debit', amount: 30 })));
    expect(debits.filter((s) => s.status === 'fulfilled')).toHaveLength(3);
    const dupes = await Promise.all(Array.from({ length: 5 }, () => adjust({ userId: u, direction: 'credit', amount: 7, idempotencyKey: 'double-click' })));
    expect(new Set(dupes.map((r) => r.transaction.id)).size).toBe(1);
    expect(await walletOf(u)).toMatchObject({ balance: 17 });
  });
});

/* ------------------------------------------------------------------ *
 * Reading, reconciliation, and the customer's view
 * ------------------------------------------------------------------ */

describe("never the operator's own wallet (P2.5.3)", () => {
  it('refuses a Credit and a Debit to their own wallet -- opening none, writing nothing, using no allowance', async () => {
    const self = await user(false);
    const own = { userId: self, actorUserId: self } as const;
    await expect(adjust({ ...own, direction: 'credit', amount: 5 })).rejects.toMatchObject(refusal('own_wallet'));
    await expect(adjust({ ...own, direction: 'debit', amount: 5 })).rejects.toMatchObject(refusal('own_wallet'));
    expect(await walletOf(self)).toBeUndefined();

    await fund(self, 50, 'earned');
    await expect(adjust({ ...own, direction: 'debit', amount: 5 })).rejects.toMatchObject(refusal('own_wallet'));
    await expect(adjust({ ...own, direction: 'credit', amount: 5 })).rejects.toMatchObject(refusal('own_wallet'));
    // User IDs are compared as ids: an upper-case spelling is the same user.
    await expect(adjust({ userId: self.toUpperCase(), actorUserId: self, direction: 'credit', amount: 5 })).rejects.toMatchObject(refusal('own_wallet'));
    await expect(adjust({ userId: self, actorUserId: self.toUpperCase(), direction: 'credit', amount: 5 })).rejects.toMatchObject(refusal('own_wallet'));

    expect(await walletOf(self)).toMatchObject({ balance: 50, version: 1 });
    expect((await q("SELECT 1 FROM wallet_transactions WHERE entry_type = 'admin_adjustment'")).rowCount).toBe(0);
    const allowance = await readAdjustmentAllowance(on.db, self, 'credits');
    expect([allowance.credit.used, allowance.debit.used]).toEqual([0, 0]);
  });

  it("another operator may adjust that same person's wallet", async () => {
    const self = await user(false);
    const result = await adjustWallet(on.db, { userId: self, actorUserId: operator, currency: 'credits', direction: 'credit', amount: 5, idempotencyKey: randomUUID(), reason: 'Goodwill' });
    expect(result.transaction).toMatchObject({ direction: 'credit', amount: 5, actorUserId: operator });
  });
});

describe('after adjustments', () => {
  it('the wallet reconciles with its ledger, and the customer commercial state (P3.1) shows the result', async () => {
    const u = await user();
    await fund(u, 60, 'included'); //                                   included 60
    await adjust({ userId: u, direction: 'credit', amount: 45 }); //  earned 45
    await adjust({ userId: u, direction: 'debit', amount: 20 }); //   included 40
    await adjust({ userId: u, direction: 'debit', amount: 45 }); //   included cannot cover 45; earned can: earned 0
    expect((await reconcileWallet(on.db, u, 'credits')).status).toBe('clean');
    expect(await readCommercialWallet(on.db, u, 'credits')).toEqual({ included: 40, earned: 0, purchased: 0, held: 0, spendable: 40 });
  });

  it('support reads every currency -- an empty one included -- and the history newest first', async () => {
    const u = await user();
    await adjust({ userId: u, direction: 'credit', amount: 12 });
    await adjust({ userId: u, direction: 'debit', amount: 2 });
    const summaries = await readWalletSummaries(on.db, u);
    expect(summaries.find((s) => s.currency === 'credits')).toEqual({
      currency: 'credits',
      exists: true,
      balance: 10,
      held: 0,
      version: 2,
      classes: { included: { spendable: 0, held: 0 }, earned: { spendable: 10, held: 0 }, purchased: { spendable: 0, held: 0 } },
    });
    expect(summaries.find((s) => s.currency === OTHER)).toMatchObject({ exists: false, balance: 0, held: 0, version: 0 });
    const history = await readWalletHistory(on.db, u, 'credits');
    expect(history.transactions.map((t) => [t.sequence, t.direction, t.amount])).toEqual([
      [2, 'debit', 2],
      [1, 'credit', 12],
    ]);
    expect(history.nextBefore).toBeNull();
  });
});
