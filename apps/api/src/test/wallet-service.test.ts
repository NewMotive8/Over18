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
    expect(CREDIT_SPEND_ORDER).toEqual(['included', 'earned', 'purchased']);
    const u = await user();
    await wallet(u);
    await fund(u, 5, 'purchased');
    await fund(u, 5, 'earned');
    await fund(u, 5, 'included');
    expect((await hold(u, 4)).transaction.creditClass).toBe('included');
    // 1 included Credit is left: not enough for 3, so earned covers it whole.
    expect((await hold(u, 3)).transaction.creditClass).toBe('earned');
    expect((await hold(u, 5)).transaction.creditClass).toBe('purchased');
    expect((await hold(u, 1)).transaction.creditClass).toBe('included');
    await expectReconciled(u);
  });

  it('refuses a hold no single class covers rather than misattribute it -- the documented limitation', async () => {
    const u = await user();
    await wallet(u);
    await fund(u, 3, 'included');
    await fund(u, 3, 'earned');
    await expect(hold(u, 5)).rejects.toMatchObject(refusal('credit_class_split_required'));
    await expect(hold(u, 7)).rejects.toMatchObject(refusal('insufficient_credits'));
    expect(await walletOf(u)).toEqual({ balance: 6, held: 0, version: 2 });
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
      expect(replayed).toEqual({ transaction: original.transaction, replayed: true });
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
    expect(await hold(u, 10, { idempotencyKey: 'all-of-it' })).toEqual({ transaction: original.transaction, replayed: true });
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

describe('only two modules move Credits: admin support (P2.4) and the paid-action framework (P7.1)', () => {
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
  it('the callers of a wallet operation are those two, and each uses only its own operations', () => {
    const OPERATIONS = /\b(holdCredits|captureHold|releaseHold|refundTransaction|reverseTransaction|adjustWallet)\b/;
    const callers = application().filter((rel) => OPERATIONS.test(readFileSync(join(src, rel), 'utf8')));
    expect(callers.sort()).toEqual(['services/admin-wallet-service.ts', 'services/paid-action-service.ts']);
    const uses = (rel: string) => [...new Set(readFileSync(join(src, rel), 'utf8').match(new RegExp(OPERATIONS.source, 'g')))].sort();
    expect(uses('services/admin-wallet-service.ts')).toEqual(['adjustWallet']);
    expect(uses('services/paid-action-service.ts')).toEqual(['captureHold', 'holdCredits', 'refundTransaction', 'releaseHold']);
  });

  it('every other importer only reads: the customer commercial state (P3.1), the admin wallet route and the admin users read model (P2.5.1)', () => {
    const importers = application().filter((rel) => /wallet-service/.test(readFileSync(join(src, rel), 'utf8')));
    expect(importers.sort()).toEqual([
      'routes/admin-wallets.ts',
      'services/admin-user-service.ts',
      'services/admin-wallet-service.ts',
      'services/customer-economy.ts',
      'services/paid-action-service.ts',
    ]);
    expect(importsFrom('services/customer-economy.ts', /\.\/wallet-service\.js/)).toEqual(['CREDITS_CURRENCY', 'readCommercialWallet']);
    expect(importsFrom('routes/admin-wallets.ts', /\.\.\/services\/wallet-service\.js/)).toEqual(['WalletError']);
    expect(importsFrom('services/admin-user-service.ts', /\.\/wallet-service\.js/)).toEqual(['readWalletSummaries']);
  });
});
