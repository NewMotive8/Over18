import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDIT_SPEND_ORDER,
  WalletError,
  captureHold,
  holdCredits,
  readCommercialWallet,
  refundTransaction,
  releaseHold,
  reverseTransaction,
  type CreditClass,
  type WalletErrorCode,
  type WalletOperationResult,
} from '../services/wallet-service.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * PRD v1.2 P2.2 -- the wallet service: hold, capture, release, refund and
 * reversal, on the P2.1 ledger.
 *
 * Wallets are funded with raw P2.1 grant rows, and paid actions are raw P2.1
 * debits: granting and charging are not P2.2 operations. Every amount is an
 * arbitrary test figure, not an economy value.
 */

let on: TestContext;

/** A TEST-ONLY second currency, proving idempotency keys are per wallet. Removed afterwards. */
const OTHER = 'test_p22_currency';

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  on.pool.query<T & import('pg').QueryResultRow>(text, params);

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

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

async function user(): Promise<string> {
  const email = `${randomUUID()}@test.local`;
  return (await q<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'not-a-hash') RETURNING id", [email])).rows[0]!.id;
}

async function wallet(userId: string, currency = 'credits'): Promise<void> {
  await q('INSERT INTO wallets (user_id, currency) VALUES ($1, $2)', [userId, currency]);
}

/** A raw P2.1 ledger row -- a fixture for what later phases will write. */
async function raw(userId: string, entryType: string, direction: string, amount: number, creditClass: CreditClass, currency = 'credits'): Promise<string> {
  return (
    await q<{ id: string }>(
      `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, currency, entryType, direction, amount, creditClass, `fixture:${randomUUID()}`],
    )
  ).rows[0]!.id;
}

/** Funds a wallet with a grant of one class. */
const fund = (userId: string, amount: number, creditClass: CreditClass = 'purchased', currency = 'credits') =>
  raw(userId, 'grant', 'credit', amount, creditClass, currency);
/** A paid action charged outright -- something to refund. */
const charged = (userId: string, amount: number, creditClass: CreditClass = 'purchased') =>
  raw(userId, 'paid_action', 'debit', amount, creditClass);

async function walletOf(userId: string, currency = 'credits') {
  return (
    await q<{ balance: number; held: number; version: number }>(
      'SELECT balance, held, version FROM wallets WHERE user_id = $1 AND currency = $2',
      [userId, currency],
    )
  ).rows[0]!;
}

async function ledgerSize(): Promise<number> {
  return (await q<{ n: number }>('SELECT count(*)::int AS n FROM wallet_transactions')).rows[0]!.n;
}

const hold = (userId: string, amount: number, over: Partial<Parameters<typeof holdCredits>[1]> = {}) =>
  holdCredits(on.db, { userId, currency: 'credits', amount, idempotencyKey: randomUUID(), ...over });
const capture = (userId: string, holdTransactionId: string, amount: number, over: Partial<Parameters<typeof captureHold>[1]> = {}) =>
  captureHold(on.db, { userId, holdTransactionId, amount, idempotencyKey: randomUUID(), ...over });
const release = (userId: string, holdTransactionId: string, amount: number, over: Partial<Parameters<typeof releaseHold>[1]> = {}) =>
  releaseHold(on.db, { userId, holdTransactionId, amount, idempotencyKey: randomUUID(), ...over });
const refund = (userId: string, transactionId: string, amount: number, over: Partial<Parameters<typeof refundTransaction>[1]> = {}) =>
  refundTransaction(on.db, { userId, transactionId, amount, idempotencyKey: randomUUID(), ...over });
const reverse = (userId: string, transactionId: string, amount: number, over: Partial<Parameters<typeof reverseTransaction>[1]> = {}) =>
  reverseTransaction(on.db, { userId, transactionId, amount, idempotencyKey: randomUUID(), ...over });

const refusal = (code: WalletErrorCode) => ({ name: 'WalletError', code });

/**
 * Every invariant a wallet must hold: a gapless sequence, a cache equal to its
 * latest transaction, every stamped balance equal to a replay of the ledger,
 * no class ever negative, and no hold or transaction settled or compensated
 * beyond its amount.
 */
async function expectReconciled(userId: string, currency = 'credits') {
  const ledger = (
    await q<{ sequence: number; balance_after: number; held_after: number; entry_type: string; direction: string; amount: number; credit_class: string }>(
      `SELECT sequence, balance_after, held_after, entry_type, direction, amount, credit_class
         FROM wallet_transactions WHERE user_id = $1 AND currency = $2 ORDER BY sequence`,
      [userId, currency],
    )
  ).rows;
  expect(ledger.map((r) => r.sequence)).toEqual(ledger.map((_, i) => i + 1));
  const last = ledger.at(-1);
  expect(await walletOf(userId, currency)).toEqual({ balance: last?.balance_after ?? 0, held: last?.held_after ?? 0, version: ledger.length });

  let balance = 0;
  let held = 0;
  const perClass: Record<string, { spendable: number; held: number }> = {};
  for (const r of ledger) {
    const spendable = r.entry_type === 'capture' ? 0 : r.direction === 'credit' ? r.amount : -r.amount;
    const reserved = r.entry_type === 'hold' ? r.amount : r.entry_type === 'capture' || r.entry_type === 'release' ? -r.amount : 0;
    balance += spendable;
    held += reserved;
    const c = (perClass[r.credit_class] ??= { spendable: 0, held: 0 });
    c.spendable += spendable;
    c.held += reserved;
    expect([balance, held], `after #${r.sequence}`).toEqual([r.balance_after, r.held_after]);
    for (const [cls, b] of Object.entries(perClass)) {
      expect(b.spendable >= 0 && b.held >= 0, `${cls} after #${r.sequence}`).toBe(true);
    }
  }
  const overdrawn = await q(
    `SELECT o.id FROM wallet_transactions o JOIN wallet_transactions s ON s.related_transaction_id = o.id
      WHERE o.user_id = $1 AND o.currency = $2 GROUP BY o.id, o.amount HAVING sum(s.amount) > o.amount`,
    [userId, currency],
  );
  expect(overdrawn.rowCount).toBe(0);
}

/* ------------------------------------------------------------------ *
 * Hold
 * ------------------------------------------------------------------ */

describe('hold', () => {
  it('moves spendable Credits to held, as one hold transaction', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10, 'included');
    const { transaction, replayed } = await hold(u, 6, { source: { type: 'generation_job', id: 'job-1' }, reason: 'Image in flight' });
    expect(replayed).toBe(false);
    expect(transaction).toMatchObject({
      entryType: 'hold',
      direction: 'debit',
      amount: 6,
      creditClass: 'included',
      balanceAfter: 4,
      heldAfter: 6,
      sequence: 2,
      relatedTransactionId: null,
      source: { type: 'generation_job', id: 'job-1' },
      reason: 'Image in flight',
    });
    expect(await walletOf(u)).toEqual({ balance: 4, held: 6, version: 2 });
    await expectReconciled(u);
  });

  it('requires enough SPENDABLE Credits -- held Credits cannot be spent again', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10);
    await hold(u, 8);
    await expect(hold(u, 5)).rejects.toMatchObject(refusal('insufficient_credits'));
    await expect(hold(u, 3)).rejects.toMatchObject(refusal('insufficient_credits'));
    expect((await hold(u, 2)).transaction.balanceAfter).toBe(0);
    expect(await walletOf(u)).toEqual({ balance: 0, held: 10, version: 3 });
  });

  it('needs a wallet in that currency', async () => {
    const u = await user();
    await expect(hold(u, 1)).rejects.toMatchObject(refusal('wallet_not_found'));
    await wallet(u);
    await fund(u, 5);
    await expect(hold(u, 1, { currency: OTHER })).rejects.toMatchObject(refusal('wallet_not_found'));
  });

  it('takes the first class, in spend order, whose spendable Credits cover it', async () => {
    expect(CREDIT_SPEND_ORDER).toEqual(['bonus', 'included', 'earned', 'purchased']);
    const u = await user();
    await wallet(u);
    await fund(u, 5, 'purchased');
    await fund(u, 5, 'earned');
    await fund(u, 5, 'included');
    await fund(u, 2, 'bonus');
    // Promotional Credits go first, while they cover the spend.
    expect((await hold(u, 2)).transaction.creditClass).toBe('bonus');
    expect((await hold(u, 4)).transaction.creditClass).toBe('included');
    // 1 included Credit is left: it is used, and earned covers the rest.
    expect((await hold(u, 3)).entries.map((e) => [e.creditClass, e.amount])).toEqual([['included', 1], ['earned', 2]]);
    expect((await hold(u, 5)).entries.map((e) => [e.creditClass, e.amount])).toEqual([['earned', 3], ['purchased', 2]]);
    expect((await hold(u, 1)).entries.map((e) => [e.creditClass, e.amount])).toEqual([['purchased', 1]]);
    await expectReconciled(u);
  });

  it('takes a hold no single class covers from several, rather than refusing it', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 3, 'included');
    await fund(u, 3, 'earned');
    expect((await hold(u, 5)).entries.map((e) => [e.creditClass, e.amount])).toEqual([
      ['included', 3],
      ['earned', 2],
    ]);
    await expect(hold(u, 2)).rejects.toMatchObject(refusal('insufficient_credits'));
    expect(await walletOf(u)).toEqual({ balance: 1, held: 5, version: 4 });
  });
});

/* ------------------------------------------------------------------ *
 * Spending across Credit classes -- one balance to the customer
 * ------------------------------------------------------------------ */

describe('spending across classes', () => {
  /** Spendable Credits by class, as the customer's state reports them. */
  const classesOf = async (userId: string) => {
    const w = (await readCommercialWallet(on.db, userId, 'credits'))!;
    return { bonus: w.bonus, included: w.included, earned: w.earned, purchased: w.purchased, held: w.held, spendable: w.spendable };
  };
  const shares = (result: WalletOperationResult) => result.entries.map((e) => [e.creditClass, e.amount]);

  async function funded(classes: Partial<Record<CreditClass, number>>): Promise<string> {
    const u = await user();
    await wallet(u);
    for (const [creditClass, amount] of Object.entries(classes)) if (amount) await fund(u, amount, creditClass as CreditClass);
    return u;
  }

  it('one class covering the cost: one row, as before', async () => {
    const u = await funded({ bonus: 20, purchased: 6 });
    const held = await hold(u, 10);
    expect(shares(held)).toEqual([['bonus', 10]]);
    expect(held).toMatchObject({ amount: 10, transaction: { amount: 10 } });
    expect(await classesOf(u)).toEqual({ bonus: 10, included: 0, earned: 0, purchased: 6, held: 10, spendable: 16 });
  });

  it('two classes: 6 bonus + 6 purchased pay for 10 with 6 bonus and 4 purchased', async () => {
    const u = await funded({ bonus: 6, purchased: 6 });
    const held = await hold(u, 10);
    expect(shares(held)).toEqual([
      ['bonus', 6],
      ['purchased', 4],
    ]);
    expect(held.amount).toBe(10);
    expect(await classesOf(u)).toEqual({ bonus: 0, included: 0, earned: 0, purchased: 2, held: 10, spendable: 2 });

    // Consumed: the customer has exactly what was left, in the class it was left in.
    await capture(u, held.transaction.id, 10);
    expect(await classesOf(u)).toEqual({ bonus: 0, included: 0, earned: 0, purchased: 2, held: 0, spendable: 2 });
    await expectReconciled(u);
  });

  it('three classes, in spend order: bonus, then included, then earned, then purchased', async () => {
    const u = await funded({ purchased: 3, earned: 3, included: 3, bonus: 3 });
    const held = await hold(u, 10);
    expect(shares(held)).toEqual([
      ['bonus', 3],
      ['included', 3],
      ['earned', 3],
      ['purchased', 1],
    ]);
    await capture(u, held.transaction.id, 10);
    expect(await classesOf(u)).toEqual({ bonus: 0, included: 0, earned: 0, purchased: 2, held: 0, spendable: 2 });
    await expectReconciled(u);
  });

  it('the exact balance across classes leaves every class at zero', async () => {
    const u = await funded({ bonus: 4, included: 5, purchased: 3 });
    const held = await hold(u, 12);
    expect(held.amount).toBe(12);
    await capture(u, held.transaction.id, 12);
    expect(await classesOf(u)).toEqual({ bonus: 0, included: 0, earned: 0, purchased: 0, held: 0, spendable: 0 });
    await expectReconciled(u);
  });

  it('a total short of the cost is refused, and nothing is written', async () => {
    const u = await funded({ bonus: 6, purchased: 3 });
    const before = await ledgerSize();
    await expect(hold(u, 10)).rejects.toMatchObject(refusal('insufficient_credits'));
    expect(await ledgerSize()).toBe(before);
    expect(await classesOf(u)).toEqual({ bonus: 6, included: 0, earned: 0, purchased: 3, held: 0, spendable: 9 });
  });

  it('held Credits are never counted: a second spend sees only what is left', async () => {
    const u = await funded({ bonus: 6, purchased: 6 });
    await hold(u, 10);
    await expect(hold(u, 3)).rejects.toMatchObject(refusal('insufficient_credits'));
    expect(shares(await hold(u, 2))).toEqual([['purchased', 2]]);
  });

  it('a released split hold returns every Credit to the class it came from', async () => {
    const u = await funded({ bonus: 6, included: 2, purchased: 6 });
    const held = await hold(u, 12);
    const released = await release(u, held.transaction.id, 12);
    expect(shares(released)).toEqual([
      ['bonus', 6],
      ['included', 2],
      ['purchased', 4],
    ]);
    expect(await classesOf(u)).toEqual({ bonus: 6, included: 2, earned: 0, purchased: 6, held: 0, spendable: 14 });
    await expectReconciled(u);
  });

  it('a refunded split capture returns every Credit to its class; a partial refund returns paid Credits first', async () => {
    const u = await funded({ bonus: 6, purchased: 6 });
    const held = await hold(u, 10);
    const captured = await capture(u, held.transaction.id, 10);
    expect(shares(captured)).toEqual([
      ['bonus', 6],
      ['purchased', 4],
    ]);

    expect(shares(await refund(u, captured.transaction.id, 5))).toEqual([
      ['purchased', 4],
      ['bonus', 1],
    ]);
    expect(await classesOf(u)).toEqual({ bonus: 1, included: 0, earned: 0, purchased: 6, held: 0, spendable: 7 });
    await refund(u, captured.transaction.id, 5);
    expect(await classesOf(u)).toEqual({ bonus: 6, included: 0, earned: 0, purchased: 6, held: 0, spendable: 12 });
    await expect(refund(u, captured.transaction.id, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
    await expectReconciled(u);
  });

  it('a split operation is idempotent as a whole: a retry returns every row and writes none', async () => {
    const u = await funded({ bonus: 6, purchased: 6 });
    const key = randomUUID();
    const first = await hold(u, 10, { idempotencyKey: key });
    const size = await ledgerSize();
    const again = await hold(u, 10, { idempotencyKey: key });
    expect(again).toMatchObject({ replayed: true, amount: 10, transaction: { id: first.transaction.id } });
    expect(again.entries.map((e) => e.id)).toEqual(first.entries.map((e) => e.id));
    expect(await ledgerSize()).toBe(size);
    // The same key for a different amount is a different operation.
    await expect(hold(u, 6, { idempotencyKey: key })).rejects.toMatchObject(refusal('idempotency_conflict'));

    const settleKey = randomUUID();
    const captured = await capture(u, first.transaction.id, 10, { idempotencyKey: settleKey });
    expect(await capture(u, first.transaction.id, 10, { idempotencyKey: settleKey })).toMatchObject({
      replayed: true,
      amount: 10,
      transaction: { id: captured.transaction.id },
    });
  });

  it('a part is reached through its lead, never settled on its own', async () => {
    const u = await funded({ bonus: 6, purchased: 6 });
    const held = await hold(u, 10);
    const part = held.entries[1]!;
    await expect(capture(u, part.id, 4)).rejects.toMatchObject(refusal('invalid_reference'));
    await expect(release(u, part.id, 4)).rejects.toMatchObject(refusal('invalid_reference'));
  });

  it('is atomic: a split whose later row fails writes nothing at all', async () => {
    const u = await funded({ bonus: 6, purchased: 6 });
    const before = await ledgerSize();
    // Make the database refuse the PURCHASED part of a hold -- after the bonus lead was written.
    await q(`CREATE FUNCTION test_refuse_purchased_hold() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.entry_type = 'hold' AND NEW.credit_class = 'purchased' THEN
                 RAISE EXCEPTION 'refused for the test' USING ERRCODE = 'check_violation';
               END IF;
               RETURN NEW;
             END $$`);
    await q('CREATE TRIGGER test_refuse_purchased_hold BEFORE INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION test_refuse_purchased_hold()');
    try {
      await expect(hold(u, 10)).rejects.toMatchObject(refusal('ledger_refused'));
    } finally {
      await q('DROP TRIGGER test_refuse_purchased_hold ON wallet_transactions');
      await q('DROP FUNCTION test_refuse_purchased_hold()');
    }
    expect(await ledgerSize()).toBe(before);
    expect(await classesOf(u)).toEqual({ bonus: 6, included: 0, earned: 0, purchased: 6, held: 0, spendable: 12 });
    await expectReconciled(u);
  });

  it('is atomic inside a caller\'s transaction too: if the caller fails afterwards, the split is undone', async () => {
    const u = await funded({ bonus: 6, purchased: 6 });
    const before = await ledgerSize();
    await expect(
      on.db.transaction(async (tx) => {
        await holdCredits(tx, { userId: u, currency: 'credits', amount: 10, idempotencyKey: randomUUID() });
        throw new Error('the work after the hold failed');
      }),
    ).rejects.toThrow('the work after the hold failed');
    expect(await ledgerSize()).toBe(before);
    expect(await classesOf(u)).toEqual({ bonus: 6, included: 0, earned: 0, purchased: 6, held: 0, spendable: 12 });
  });

  it('concurrent spends cannot overspend: 12 Credits across two classes cover two holds of 5, never three', async () => {
    const u = await funded({ bonus: 6, purchased: 6 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => hold(u, 5)));
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(2);
    expect(lost.every((r) => (r.reason as WalletError).code === 'insufficient_credits')).toBe(true);
    expect(await classesOf(u)).toEqual({ bonus: 0, included: 0, earned: 0, purchased: 2, held: 10, spendable: 2 });
    await expectReconciled(u);
  });
});

/* ------------------------------------------------------------------ *
 * A split hold through its whole lifecycle -- one logical operation
 * ------------------------------------------------------------------ */

describe('a split hold through hold, capture, release and refund', () => {
  const classesOf = async (userId: string) => {
    const w = (await readCommercialWallet(on.db, userId, 'credits'))!;
    return { bonus: w.bonus, included: w.included, earned: w.earned, purchased: w.purchased, held: w.held, spendable: w.spendable };
  };
  /** The ledger rows of one entry type that settle or compensate the given rows. */
  const settling = async (ids: string[], entryType: string) =>
    (
      await q<{ related_transaction_id: string; credit_class: string; amount: number }>(
        'SELECT related_transaction_id, credit_class, amount FROM wallet_transactions WHERE entry_type = $1 AND related_transaction_id = ANY($2::uuid[]) ORDER BY sequence',
        [entryType, ids],
      )
    ).rows;

  async function splitHold() {
    const u = await user();
    await wallet(u);
    await fund(u, 4, 'bonus');
    await fund(u, 3, 'included');
    await fund(u, 10, 'purchased');
    const held = await hold(u, 12);
    return { u, held, ids: held.entries.map((e) => e.id) };
  }

  it('the hold records the whole amount on its lead and each source as a part of it', async () => {
    const { u, held } = await splitHold();
    expect(held.amount).toBe(12);
    expect(held.entries.map((e) => [e.entryType, e.creditClass, e.amount])).toEqual([
      ['hold', 'bonus', 4],
      ['hold', 'included', 3],
      ['hold', 'purchased', 5],
    ]);
    const rows = (
      await q<{ id: string; metadata: Record<string, unknown> }>('SELECT id, metadata FROM wallet_transactions WHERE id = ANY($1::uuid[]) ORDER BY sequence', [
        held.entries.map((e) => e.id),
      ])
    ).rows;
    expect(rows[0]!.metadata).toMatchObject({ splitTotal: 12 });
    expect(rows.slice(1).every((r) => r.metadata.splitOf === held.transaction.id)).toBe(true);
    expect(await classesOf(u)).toEqual({ bonus: 0, included: 0, earned: 0, purchased: 5, held: 12, spendable: 5 });
  });

  it('capture settles every part exactly once, and a replay settles nothing more', async () => {
    const { u, held, ids } = await splitHold();
    const key = randomUUID();
    const captured = await capture(u, held.transaction.id, 12, { idempotencyKey: key });
    expect(captured.amount).toBe(12);
    const again = await capture(u, held.transaction.id, 12, { idempotencyKey: key });
    expect(again).toMatchObject({ replayed: true, amount: 12 });
    expect(again.entries.map((e) => e.id)).toEqual(captured.entries.map((e) => e.id));

    // One capture per part, each of the whole part, in its own class.
    expect(await settling(ids, 'capture')).toEqual([
      { related_transaction_id: ids[0], credit_class: 'bonus', amount: 4 },
      { related_transaction_id: ids[1], credit_class: 'included', amount: 3 },
      { related_transaction_id: ids[2], credit_class: 'purchased', amount: 5 },
    ]);
    // A second capture under ANOTHER key finds nothing left to settle.
    await expect(capture(u, held.transaction.id, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
    await expect(release(u, held.transaction.id, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
    expect(await classesOf(u)).toEqual({ bonus: 0, included: 0, earned: 0, purchased: 5, held: 0, spendable: 5 });
    await expectReconciled(u);
  });

  it('release restores every part exactly once, to its own source, and a replay restores nothing more', async () => {
    const { u, held, ids } = await splitHold();
    const key = randomUUID();
    await release(u, held.transaction.id, 12, { idempotencyKey: key });
    expect(await release(u, held.transaction.id, 12, { idempotencyKey: key })).toMatchObject({ replayed: true, amount: 12 });

    expect((await settling(ids, 'release')).map((r) => [r.credit_class, r.amount])).toEqual([
      ['bonus', 4],
      ['included', 3],
      ['purchased', 5],
    ]);
    await expect(release(u, held.transaction.id, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
    await expect(capture(u, held.transaction.id, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
    expect(await classesOf(u)).toEqual({ bonus: 4, included: 3, earned: 0, purchased: 10, held: 0, spendable: 17 });
    await expectReconciled(u);
  });

  it('refund restores the right amount to each source exactly once, and a replay restores nothing more', async () => {
    const { u, held } = await splitHold();
    const captured = await capture(u, held.transaction.id, 12);
    const captureIds = captured.entries.map((e) => e.id);
    const key = randomUUID();
    const refunded = await refund(u, captured.transaction.id, 12, { idempotencyKey: key });
    expect(refunded.amount).toBe(12);
    expect(await refund(u, captured.transaction.id, 12, { idempotencyKey: key })).toMatchObject({ replayed: true, amount: 12 });

    expect((await settling(captureIds, 'refund')).map((r) => [r.credit_class, r.amount]).sort()).toEqual([
      ['bonus', 4],
      ['included', 3],
      ['purchased', 5],
    ]);
    await expect(refund(u, captured.transaction.id, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
    // A part of the capture cannot be refunded on its own, around the lead.
    await expect(refund(u, captureIds[1]!, 1)).rejects.toMatchObject(refusal('invalid_reference'));
    expect(await classesOf(u)).toEqual({ bonus: 4, included: 3, earned: 0, purchased: 10, held: 0, spendable: 17 });
    await expectReconciled(u);
  });

  /** Makes the database refuse one class's row of one entry type, for the duration of `run`. */
  async function refusing(entryType: string, creditClass: string, run: () => Promise<void>) {
    await q(`CREATE FUNCTION test_refuse_row() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.entry_type = '${entryType}' AND NEW.credit_class = '${creditClass}' THEN
                 RAISE EXCEPTION 'refused for the test' USING ERRCODE = 'check_violation';
               END IF;
               RETURN NEW;
             END $$`);
    await q('CREATE TRIGGER test_refuse_row BEFORE INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION test_refuse_row()');
    try {
      await run();
    } finally {
      await q('DROP TRIGGER test_refuse_row ON wallet_transactions');
      await q('DROP FUNCTION test_refuse_row()');
    }
  }

  it.each([
    ['capture', 'purchased'],
    ['release', 'included'],
  ] as const)('a %s that fails part-way settles no part at all: no source is left settled while another is not', async (step, failing) => {
    const { u, held } = await splitHold();
    const before = await ledgerSize();
    const classes = await classesOf(u);
    await refusing(step, failing, async () => {
      await expect((step === 'capture' ? capture : release)(u, held.transaction.id, 12)).rejects.toMatchObject(refusal('ledger_refused'));
    });
    expect(await ledgerSize()).toBe(before);
    expect(await classesOf(u)).toEqual(classes);
    // And it can still be settled whole afterwards.
    expect((await (step === 'capture' ? capture : release)(u, held.transaction.id, 12)).amount).toBe(12);
    await expectReconciled(u);
  });

  it('a refund that fails part-way restores no source at all', async () => {
    const { u, held } = await splitHold();
    const captured = await capture(u, held.transaction.id, 12);
    const before = await ledgerSize();
    await refusing('refund', 'bonus', async () => {
      await expect(refund(u, captured.transaction.id, 12)).rejects.toMatchObject(refusal('ledger_refused'));
    });
    expect(await ledgerSize()).toBe(before);
    expect(await classesOf(u)).toEqual({ bonus: 0, included: 0, earned: 0, purchased: 5, held: 0, spendable: 5 });
    await expectReconciled(u);
  });

  it('concurrent settlements of one split hold settle it once: one capture or release wins, the rest find nothing left', async () => {
    const { u, held, ids } = await splitHold();
    const attempts = await Promise.allSettled([
      capture(u, held.transaction.id, 12),
      capture(u, held.transaction.id, 12),
      release(u, held.transaction.id, 12),
      release(u, held.transaction.id, 12),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    for (const a of attempts.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
      expect((a.reason as WalletError).code).toBe('exceeds_remaining');
    }
    const settledRows = [...(await settling(ids, 'capture')), ...(await settling(ids, 'release'))];
    expect(settledRows.reduce((sum, r) => sum + r.amount, 0)).toBe(12);
    expect((await classesOf(u)).held).toBe(0);
    await expectReconciled(u);
  });

  it('concurrent refunds of one split capture restore it once', async () => {
    const { u, held } = await splitHold();
    const captured = await capture(u, held.transaction.id, 12);
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => refund(u, captured.transaction.id, 12)));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(await classesOf(u)).toEqual({ bonus: 4, included: 3, earned: 0, purchased: 10, held: 0, spendable: 17 });
    await expectReconciled(u);
  });

  it('a single-source hold behaves exactly as before: one row each, no split metadata', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 20, 'purchased');
    const held = await hold(u, 8);
    const captured = await capture(u, held.transaction.id, 8);
    const refunded = await refund(u, captured.transaction.id, 8);
    for (const result of [held, captured, refunded]) {
      expect(result.entries).toHaveLength(1);
      expect(result.amount).toBe(8);
      expect(result.entries[0]).toEqual(result.transaction);
    }
    expect(captured.transaction.relatedTransactionId).toBe(held.transaction.id);
    expect(refunded.transaction.relatedTransactionId).toBe(captured.transaction.id);
    const metas = (await q<{ metadata: Record<string, unknown> }>('SELECT metadata FROM wallet_transactions WHERE user_id = $1', [u])).rows;
    expect(metas.every((r) => !('splitTotal' in r.metadata) && !('splitOf' in r.metadata) && !('settles' in r.metadata))).toBe(true);
    expect(await walletOf(u)).toMatchObject({ balance: 20, held: 0 });
    await expectReconciled(u);
  });
});

/* ------------------------------------------------------------------ *
 * Capture and release
 * ------------------------------------------------------------------ */

describe('capture and release', () => {
  it('a capture consumes held Credits and a release returns them, in the class they were held from', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10, 'earned');
    const held = (await hold(u, 8)).transaction;
    const captured = (await capture(u, held.id, 5)).transaction;
    expect(captured).toMatchObject({ entryType: 'capture', direction: 'debit', creditClass: 'earned', relatedTransactionId: held.id, balanceAfter: 2, heldAfter: 3 });
    const released = (await release(u, held.id, 3)).transaction;
    expect(released).toMatchObject({ entryType: 'release', direction: 'credit', creditClass: 'earned', relatedTransactionId: held.id, balanceAfter: 5, heldAfter: 0 });
    expect(await walletOf(u)).toEqual({ balance: 5, held: 0, version: 4 });
    await expectReconciled(u);
  });

  it('can never exceed what remains of the hold, captures and releases together', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 20);
    const held = (await hold(u, 5)).transaction;
    await expect(capture(u, held.id, 6)).rejects.toMatchObject(refusal('exceeds_remaining'));
    await capture(u, held.id, 3);
    await expect(release(u, held.id, 3)).rejects.toMatchObject(refusal('exceeds_remaining'));
    await release(u, held.id, 2);
    await expect(capture(u, held.id, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
    await expect(release(u, held.id, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
    expect(await walletOf(u)).toEqual({ balance: 17, held: 0, version: 4 });
  });

  it("requires a valid hold of the user's own", async () => {
    const u = await user();
    const other = await user();
    await wallet(u);
    await wallet(other);
    const granted = await fund(u, 10);
    await fund(other, 10);
    const theirs = (await hold(other, 4)).transaction;

    await expect(capture(u, granted, 1)).rejects.toMatchObject(refusal('invalid_reference'));
    await expect(release(u, granted, 1)).rejects.toMatchObject(refusal('invalid_reference'));
    await expect(capture(u, randomUUID(), 1)).rejects.toMatchObject(refusal('transaction_not_found'));
    await expect(capture(u, theirs.id, 1)).rejects.toMatchObject(refusal('transaction_not_found'));
    await expect(release(u, theirs.id, 1)).rejects.toMatchObject(refusal('transaction_not_found'));
    await expect(capture(u, 'not-an-id', 1)).rejects.toMatchObject(refusal('invalid_request'));
    expect(await walletOf(other)).toEqual({ balance: 6, held: 4, version: 2 });
  });
});

/* ------------------------------------------------------------------ *
 * Refund and reversal
 * ------------------------------------------------------------------ */

describe('refund', () => {
  it('returns Credits charged by a paid action or a capture, to the class they came from', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10, 'earned');
    const paid = await charged(u, 6, 'earned');
    const first = (await refund(u, paid, 4)).transaction;
    expect(first).toMatchObject({ entryType: 'refund', direction: 'credit', creditClass: 'earned', relatedTransactionId: paid, balanceAfter: 8 });
    expect((await refund(u, paid, 2)).transaction.balanceAfter).toBe(10);

    const held = (await hold(u, 5)).transaction;
    const captured = (await capture(u, held.id, 5)).transaction;
    expect((await refund(u, captured.id, 5)).transaction).toMatchObject({ creditClass: 'earned', balanceAfter: 10, heldAfter: 0 });
    await expectReconciled(u);
  });

  it('refuses more than the refundable amount, and anything that was not a charge', async () => {
    const u = await user();
    await wallet(u);
    const granted = await fund(u, 10);
    const paid = await charged(u, 6);
    await refund(u, paid, 4);
    await expect(refund(u, paid, 3)).rejects.toMatchObject(refusal('exceeds_remaining'));
    const held = (await hold(u, 2)).transaction;
    const released = (await release(u, held.id, 2)).transaction;
    for (const id of [granted, held.id, released.id]) {
      await expect(refund(u, id, 1)).rejects.toMatchObject(refusal('invalid_reference'));
    }
    expect(await walletOf(u)).toEqual({ balance: 8, held: 0, version: 5 });
  });
});

describe('reversal', () => {
  it('runs opposite to the original, in its class, and never beyond it', async () => {
    const u = await user();
    await wallet(u);
    const granted = await fund(u, 10, 'included');
    const takenBack = (await reverse(u, granted, 4)).transaction;
    expect(takenBack).toMatchObject({ entryType: 'reversal', direction: 'debit', creditClass: 'included', relatedTransactionId: granted, balanceAfter: 6 });
    const paid = await charged(u, 3, 'included');
    expect((await reverse(u, paid, 3)).transaction).toMatchObject({ direction: 'credit', creditClass: 'included', balanceAfter: 6 });
    await expect(reverse(u, paid, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
    await expect(reverse(u, granted, 7)).rejects.toMatchObject(refusal('exceeds_remaining'));
    await expectReconciled(u);
  });

  it('shares its limit with refunds of the same transaction', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10);
    const paid = await charged(u, 6);
    await refund(u, paid, 4);
    await expect(reverse(u, paid, 3)).rejects.toMatchObject(refusal('exceeds_remaining'));
    await reverse(u, paid, 2);
    await expect(refund(u, paid, 1)).rejects.toMatchObject(refusal('exceeds_remaining'));
  });

  it('cannot create a negative balance, and never takes held Credits', async () => {
    const u = await user();
    await wallet(u);
    const granted = await fund(u, 10);
    await hold(u, 8);
    await expect(reverse(u, granted, 5)).rejects.toMatchObject(refusal('insufficient_credits'));
    expect((await reverse(u, granted, 2)).transaction).toMatchObject({ balanceAfter: 0, heldAfter: 8 });
    await expect(reverse(u, granted, 1)).rejects.toMatchObject(refusal('insufficient_credits'));
    expect(await walletOf(u)).toEqual({ balance: 0, held: 8, version: 3 });
  });

  it('takes Credits back only from the class they were given in', async () => {
    const u = await user();
    await wallet(u);
    const included = await fund(u, 5, 'included');
    await fund(u, 5, 'earned');
    await hold(u, 5); // spend order: all 5 included Credits are now held
    await expect(reverse(u, included, 1)).rejects.toMatchObject(refusal('insufficient_credits'));
    expect(await walletOf(u)).toEqual({ balance: 5, held: 5, version: 3 });
  });

  it('a hold or a release is settled, never reversed', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10);
    const held = (await hold(u, 4)).transaction;
    const released = (await release(u, held.id, 4)).transaction;
    await expect(reverse(u, held.id, 1)).rejects.toMatchObject(refusal('invalid_reference'));
    await expect(reverse(u, released.id, 1)).rejects.toMatchObject(refusal('invalid_reference'));
  });
});

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

describe('idempotency', () => {
  it('a replay of any operation returns the original result and writes nothing', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 20);
    const paid = await charged(u, 5);
    const granted = await fund(u, 5);

    const h = await hold(u, 6, { idempotencyKey: 'hold-1' });
    const c = await capture(u, h.transaction.id, 4, { idempotencyKey: 'capture-1' });
    const r = await release(u, h.transaction.id, 2, { idempotencyKey: 'release-1' });
    const f = await refund(u, paid, 5, { idempotencyKey: 'refund-1' });
    const v = await reverse(u, granted, 5, { idempotencyKey: 'reversal-1' });
    const size = await ledgerSize();
    const before = await walletOf(u);

    const replays: Array<[WalletOperationResult, () => Promise<WalletOperationResult>]> = [
      [h, () => hold(u, 6, { idempotencyKey: 'hold-1' })],
      [c, () => capture(u, h.transaction.id, 4, { idempotencyKey: 'capture-1' })],
      [r, () => release(u, h.transaction.id, 2, { idempotencyKey: 'release-1' })],
      [f, () => refund(u, paid, 5, { idempotencyKey: 'refund-1' })],
      [v, () => reverse(u, granted, 5, { idempotencyKey: 'reversal-1' })],
    ];
    for (const [original, again] of replays) {
      const replayed = await again();
      expect(replayed).toEqual({ ...original, replayed: true });
    }
    expect(await ledgerSize()).toBe(size);
    expect(await walletOf(u)).toEqual(before);
  });

  it('a replay returns the original even when it could not happen now', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10);
    const original = await hold(u, 10, { idempotencyKey: 'all-of-it' });
    await capture(u, original.transaction.id, 10);
    // Nothing is spendable or held any more; the retry still gets its answer.
    expect(await hold(u, 10, { idempotencyKey: 'all-of-it' })).toEqual({ ...original, replayed: true });
  });

  it('refuses a key reused for a materially different operation, and writes nothing', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 20);
    const first = await charged(u, 3);
    const second = await charged(u, 3);
    const h = await hold(u, 5, { idempotencyKey: 'k' });
    await refund(u, first, 1, { idempotencyKey: 'r' });
    const size = await ledgerSize();

    const conflicts: Array<[string, () => Promise<unknown>]> = [
      ['another amount', () => hold(u, 6, { idempotencyKey: 'k' })],
      ['another source', () => hold(u, 5, { idempotencyKey: 'k', source: { type: 'generation_job', id: 'job-2' } })],
      ['another operation', () => capture(u, h.transaction.id, 5, { idempotencyKey: 'k' })],
      ['another original', () => refund(u, second, 1, { idempotencyKey: 'r' })],
      ['refund vs reversal', () => reverse(u, first, 1, { idempotencyKey: 'r' })],
    ];
    for (const [label, attempt] of conflicts) {
      await expect(attempt(), label).rejects.toMatchObject(refusal('idempotency_conflict'));
    }
    expect(await ledgerSize()).toBe(size);

    // A different reason or request id on a retry is not a different operation.
    expect((await hold(u, 5, { idempotencyKey: 'k', reason: 'Retried', requestId: 'req-2' })).replayed).toBe(true);
  });

  it('a key is per wallet: the same key in another currency is another operation', async () => {
    const u = await user();
    await wallet(u);
    await wallet(u, OTHER);
    await fund(u, 5);
    await fund(u, 5, 'purchased', OTHER);
    const credits = await hold(u, 2, { idempotencyKey: 'shared' });
    const other = await hold(u, 2, { idempotencyKey: 'shared', currency: OTHER });
    expect(other.replayed).toBe(false);
    expect(other.transaction.id).not.toBe(credits.transaction.id);
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

describe('concurrency', () => {
  const outcomes = (settled: PromiseSettledResult<unknown>[]) => ({
    succeeded: settled.filter((s) => s.status === 'fulfilled').length,
    refusals: settled.flatMap((s) => (s.status === 'rejected' ? [(s.reason as WalletError).code] : [])),
  });

  it('concurrent holds never overspend: exactly as many succeed as the balance covers', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10);
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => hold(u, 4)));
    expect(outcomes(settled)).toEqual({ succeeded: 2, refusals: Array(4).fill('insufficient_credits') });
    expect(await walletOf(u)).toEqual({ balance: 2, held: 8, version: 3 });
    await expectReconciled(u);
  });

  it('concurrent retries of one key write once and all get the same result', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10);
    const results = await Promise.all(Array.from({ length: 5 }, () => hold(u, 3, { idempotencyKey: 'double-tap' })));
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await walletOf(u)).toEqual({ balance: 7, held: 3, version: 2 });
  });

  it('concurrent captures and refunds never exceed what they settle or compensate', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 20);
    const held = (await hold(u, 10)).transaction;
    const captures = await Promise.allSettled(Array.from({ length: 4 }, () => capture(u, held.id, 3)));
    expect(outcomes(captures)).toEqual({ succeeded: 3, refusals: ['exceeds_remaining'] });

    const paid = await charged(u, 5);
    const refunds = await Promise.allSettled(Array.from({ length: 3 }, () => refund(u, paid, 2)));
    expect(outcomes(refunds)).toEqual({ succeeded: 2, refusals: ['exceeds_remaining'] });
    await expectReconciled(u);
  });
});

/* ------------------------------------------------------------------ *
 * Failure, immutability and consistency
 * ------------------------------------------------------------------ */

describe('failure leaves nothing behind', () => {
  it('an operation inside a larger unit of work rolls back with it', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10);
    await expect(
      on.db.transaction(async (tx) => {
        const held = await holdCredits(tx, { userId: u, currency: 'credits', amount: 4, idempotencyKey: 'in-flight' });
        expect(held.transaction.balanceAfter).toBe(6);
        throw new Error('the paid action failed');
      }),
    ).rejects.toThrow('the paid action failed');
    expect(await walletOf(u)).toEqual({ balance: 10, held: 0, version: 1 });
    expect(await ledgerSize()).toBe(1);
    // The key was never recorded, so the operation can be tried again.
    expect((await hold(u, 4, { idempotencyKey: 'in-flight' })).replayed).toBe(false);
  });

  it('a refused operation writes nothing', async () => {
    const u = await user();
    await wallet(u);
    const granted = await fund(u, 5);
    const size = await ledgerSize();
    const attempts: Array<() => Promise<unknown>> = [
      () => hold(u, 6),
      () => hold(u, 0),
      () => hold(u, 1.5),
      () => hold(u, 1, { idempotencyKey: '  ' }),
      () => hold(u, 1, { idempotencyKey: 'x'.repeat(201) }),
      () => hold(u, 1, { currency: 'USD' }),
      () => capture(u, granted, 1),
      () => refund(u, granted, 1),
      () => reverse(u, granted, 6),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(WalletError);
    expect(await ledgerSize()).toBe(size);
    expect(await walletOf(u)).toEqual({ balance: 5, held: 0, version: 1 });
  });

  it('refuses to build on class accounting that does not reconcile', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 10, 'purchased');
    // P2.1 checks totals only; a raw debit of a class the wallet does not hold
    // leaves "included" negative. The service will not build on that.
    await charged(u, 4, 'included');
    await expect(hold(u, 1)).rejects.toMatchObject(refusal('ledger_inconsistent'));
    expect(await walletOf(u)).toEqual({ balance: 6, held: 0, version: 2 });
  });
});

describe('immutability', () => {
  it('operations only append: earlier transactions never change, and the ledger still refuses edits', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 20);
    const held = (await hold(u, 8)).transaction;
    const snapshot = (await q('SELECT * FROM wallet_transactions ORDER BY sequence')).rows;
    await capture(u, held.id, 5);
    await release(u, held.id, 3);
    const paid = await charged(u, 2);
    await refund(u, paid, 2);
    const after = (await q('SELECT * FROM wallet_transactions ORDER BY sequence')).rows;
    expect(after.slice(0, snapshot.length)).toEqual(snapshot);

    await expect(q('UPDATE wallet_transactions SET amount = 1 WHERE id = $1', [held.id])).rejects.toThrow(/append-only/);
    await expect(q('DELETE FROM wallet_transactions WHERE id = $1', [held.id])).rejects.toThrow(/append-only/);
    await expect(q('UPDATE wallets SET balance = 0 WHERE user_id = $1', [u])).rejects.toThrow(/never written directly/);
  });

  it('the service has no way to edit a transaction or write a balance', () => {
    const source = readFileSync(fileURLToPath(new URL('../services/wallet-service.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\.update\(|\.delete\(|\bupdate\s+"?wallet|\bdelete\s+from/i);
  });
});

describe('consistency', () => {
  /** Deterministic pseudo-random numbers, so a failure is reproducible. */
  function prng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('a randomised run of operations, refusals and replays leaves every wallet reconciled with its ledger', async () => {
    const random = prng(20260919);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
    const users = [await user(), await user()];
    const classes: CreditClass[] = ['included', 'earned', 'purchased'];
    const known = new Map<string, Array<{ id: string; type: string }>>(users.map((u) => [u, []]));
    for (const u of users) {
      await wallet(u);
      for (const c of classes) known.get(u)!.push({ id: await fund(u, 20, c), type: 'grant' });
    }
    const history: Array<() => Promise<WalletOperationResult>> = [];
    let applied = 0;
    const refused: Record<string, number> = {};

    for (let step = 0; step < 150; step++) {
      const u = pick(users);
      const mine = known.get(u)!;
      const amount = 1 + Math.floor(random() * 8);
      const target = mine.length > 0 ? pick(mine) : null;
      const choice = random();
      let run: () => Promise<WalletOperationResult>;
      if (choice < 0.1 && history.length > 0) run = pick(history);
      else if (choice < 0.35 || !target) run = ((key) => () => hold(u, amount, { idempotencyKey: key }))(randomUUID());
      else if (choice < 0.55) run = ((key, id) => () => capture(u, id, amount, { idempotencyKey: key }))(randomUUID(), target.id);
      else if (choice < 0.75) run = ((key, id) => () => release(u, id, amount, { idempotencyKey: key }))(randomUUID(), target.id);
      else if (choice < 0.9) run = ((key, id) => () => refund(u, id, amount, { idempotencyKey: key }))(randomUUID(), target.id);
      else run = ((key, id) => () => reverse(u, id, amount, { idempotencyKey: key }))(randomUUID(), target.id);
      try {
        const result = await run();
        history.push(run);
        if (!result.replayed) {
          applied++;
          mine.push({ id: result.transaction.id, type: result.transaction.entryType });
        }
      } catch (error) {
        if (!(error instanceof WalletError)) throw error;
        refused[error.code] = (refused[error.code] ?? 0) + 1;
      }
    }

    expect(applied).toBeGreaterThan(30);
    // Refusals are the service's own checks -- never the database disagreeing with it.
    expect(refused.ledger_refused ?? 0).toBe(0);
    expect(refused.ledger_inconsistent ?? 0).toBe(0);
    for (const u of users) await expectReconciled(u);
  });
});

/* ------------------------------------------------------------------ *
 * Who may move Credits at all
 * ------------------------------------------------------------------ */

describe('only three modules move Credits: admin support (P2.4), paid actions (P7.1) and payments (P9.2)', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
    });
  }
  const src = fileURLToPath(new URL('..', import.meta.url));
  const application = () =>
    sourceFiles(src)
      .map((path) => relative(src, path).split('\\').join('/'))
      .filter((rel) => rel !== 'services/wallet-service.ts');
  const importsFrom = (rel: string, module: RegExp) =>
    (readFileSync(join(src, rel), 'utf8').match(new RegExp(String.raw`import \{([^}]*)\} from '${module.source}'`))?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();

  /**
   * P7.1 added the second caller, deliberately. An operator's adjustment and a
   * paid action are the only two reasons Credits may move in this product, and
   * each uses exactly the operations its job needs: support adjusts and nothing
   * else; the framework holds, settles and compensates but never adjusts.
   * Nothing calls the framework itself yet -- paid-action.test.ts holds that line.
   */
  it('the callers of a wallet operation are the reviewed ones, and each uses only its own operations', () => {
    const OPERATIONS = /\b(holdCredits|captureHold|releaseHold|refundTransaction|reverseTransaction|adjustWallet|grantCredits)\b/;
    const callers = application().filter((rel) => OPERATIONS.test(readFileSync(join(src, rel), 'utf8')));
    expect(callers.sort()).toEqual([
      'services/admin-wallet-service.ts',
      'services/paid-action-service.ts',
      'services/payment-service.ts',
    ]);
    const uses = (rel: string) => [...new Set(readFileSync(join(src, rel), 'utf8').match(new RegExp(OPERATIONS.source, 'g')))].sort();
    expect(uses('services/admin-wallet-service.ts')).toEqual(['adjustWallet']);
    expect(uses('services/paid-action-service.ts')).toEqual(['captureHold', 'holdCredits', 'refundTransaction', 'releaseHold']);
    // P9.2 gives Credits a confirmed payment entitles a customer to, and does
    // nothing else to a wallet: it cannot spend, hold, adjust or reverse.
    expect(uses('services/payment-service.ts')).toEqual(['grantCredits']);
  });

  it('every other importer only reads, or reads an error: the customer commercial state (P3.1), the admin wallet route and users read model (P2.5.1), and the P8.2 unlock', () => {
    // A module specifier, not a mention: a doc comment naming the wallet service
    // is not an import. Static, side-effect and dynamic forms all count.
    const IMPORTS_WALLET = /\b(?:from|import)\s*\(?\s*['"](?:\.\.?\/)+(?:services\/)?wallet-service\.js['"]/;
    const importers = application().filter((rel) => IMPORTS_WALLET.test(readFileSync(join(src, rel), 'utf8')));
    expect(importers.sort()).toEqual([
      'routes/admin-wallets.ts',
      'services/admin-user-service.ts',
      'services/admin-wallet-service.ts',
      'services/content-unlock-service.ts',
      'services/customer-economy.ts',
      'services/paid-action-service.ts',
      'services/payment-service.ts',
    ]);
    // P8.2 takes the error type alone, to say "not enough Credits" in its own words.
    expect(importsFrom('services/content-unlock-service.ts', /\.\/wallet-service\.js/)).toEqual(['WalletError']);
    expect(importsFrom('services/customer-economy.ts', /\.\/wallet-service\.js/)).toEqual(['CREDITS_CURRENCY', 'readCommercialWallet']);
    expect(importsFrom('routes/admin-wallets.ts', /\.\.\/services\/wallet-service\.js/)).toEqual(['WalletError']);
    expect(importsFrom('services/admin-user-service.ts', /\.\/wallet-service\.js/)).toEqual(['readWalletSummaries']);
  });
});
