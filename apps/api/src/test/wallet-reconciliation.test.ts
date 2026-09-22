import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captureHold, holdCredits, refundTransaction, releaseHold, reverseTransaction } from '../services/wallet-service.js';
import { rebuildWallet, reconcileWallet, reconcileWallets } from '../services/wallet-reconciliation.js';
import { createTestContext, destroyTestContext, migrateTestDb, truncateAll, type TestContext } from './helpers.js';

/**
 * PRD v1.2 P2.3 -- rebuilding a wallet from its ledger, and reconciling the
 * cached wallet against it.
 *
 * Migration 0034 makes every discrepancy below impossible through normal
 * access. To prove reconciliation would catch one anyway, the tests BYPASS the
 * guards the way a manual SQL session or a bad restore could: a trigger is
 * disabled inside one transaction, one row is altered, and the trigger is
 * re-enabled before commit. `afterEach` proves every guard is back on. Every
 * amount is an arbitrary test figure.
 */

let on: TestContext;
beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => truncateAll(on));

const GUARDS = ['wallet_transactions_append_only', 'wallet_transactions_apply', 'wallet_transactions_stamp', 'wallets_guard'];
afterEach(async () => {
  const enabled = await q<{ tgname: string; tgenabled: string }>(
    'SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = ANY($1) ORDER BY tgname',
    [GUARDS],
  );
  expect(enabled.rows).toEqual(GUARDS.map((tgname) => ({ tgname, tgenabled: 'O' })));
});

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  on.pool.query<T & import('pg').QueryResultRow>(text, params);

async function user(): Promise<string> {
  const email = `${randomUUID()}@test.local`;
  const id = (await q<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'not-a-hash') RETURNING id", [email])).rows[0]!.id;
  await q("INSERT INTO wallets (user_id, currency) VALUES ($1, 'credits')", [id]);
  return id;
}

async function raw(userId: string, entryType: 'grant' | 'paid_action', amount: number, creditClass: 'included' | 'earned' | 'purchased'): Promise<string> {
  const direction = entryType === 'grant' ? 'credit' : 'debit';
  return (
    await q<{ id: string }>(
      `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
       VALUES ($1, 'credits', $2, $3, $4, $5, $6) RETURNING id`,
      [userId, entryType, direction, amount, creditClass, `fixture:${randomUUID()}`],
    )
  ).rows[0]!.id;
}

const key = () => randomUUID();

/** A history using every operation. Ends at spendable 50, held 0, version 9 (worked out below). */
async function fullHistory(u: string) {
  const grants = {
    included: await raw(u, 'grant', 30, 'included'),
    earned: await raw(u, 'grant', 20, 'earned'),
    purchased: await raw(u, 'grant', 10, 'purchased'),
  };
  const hold = (await holdCredits(on.db, { userId: u, currency: 'credits', amount: 5, idempotencyKey: key() })).transaction; // included 25 / held 5
  await captureHold(on.db, { userId: u, holdTransactionId: hold.id, amount: 3, idempotencyKey: key() }); //          held 2
  await releaseHold(on.db, { userId: u, holdTransactionId: hold.id, amount: 2, idempotencyKey: key() }); //          included 27 / held 0
  const paid = await raw(u, 'paid_action', 4, 'earned'); //                                                            earned 16
  await refundTransaction(on.db, { userId: u, transactionId: paid, amount: 2, idempotencyKey: key() }); //           earned 18
  await reverseTransaction(on.db, { userId: u, transactionId: grants.purchased, amount: 5, idempotencyKey: key() }); // purchased 5
  return { grants, hold, paid };
}

/** Alters one row with its guard switched off for this transaction only -- a simulated bypass. */
async function bypass(table: 'wallets' | 'wallet_transactions', trigger: string, statement: string, params: unknown[]) {
  const client = await on.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await client.query(statement, params);
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const tamperWallet = (userId: string, set: string) =>
  bypass('wallets', 'wallets_guard', `UPDATE wallets SET ${set} WHERE user_id = $1 AND currency = 'credits'`, [userId]);
const tamperLedger = (statement: string, params: unknown[]) => bypass('wallet_transactions', 'wallet_transactions_append_only', statement, params);

/* ------------------------------------------------------------------ *
 * Clean wallets
 * ------------------------------------------------------------------ */

describe('a clean wallet', () => {
  it('with no transactions: clean, and holds nothing', async () => {
    const u = await user();
    expect(await reconcileWallet(on.db, u, 'credits')).toEqual({
      userId: u,
      currency: 'credits',
      status: 'clean',
      expected: {
        userId: u,
        currency: 'credits',
        balance: 0,
        held: 0,
        version: 0,
        classes: { included: { spendable: 0, held: 0 }, earned: { spendable: 0, held: 0 }, purchased: { spendable: 0, held: 0 } },
      },
      actual: { balance: 0, held: 0, version: 0 },
      discrepancies: [],
    });
  });

  it('with no wallet and no transactions: clean, and nothing to compare', async () => {
    const email = `${randomUUID()}@test.local`;
    const id = (await q<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email])).rows[0]!.id;
    const result = await reconcileWallet(on.db, id, 'credits');
    expect(result).toMatchObject({ status: 'clean', actual: null, discrepancies: [] });
  });

  it('after grants, a hold, a capture, a release, a charge, a refund and a reversal: rebuilt exactly, and clean', async () => {
    const u = await user();
    await fullHistory(u);
    const expected = {
      userId: u,
      currency: 'credits',
      balance: 50,
      held: 0,
      version: 9,
      classes: { included: { spendable: 27, held: 0 }, earned: { spendable: 18, held: 0 }, purchased: { spendable: 5, held: 0 } },
    };
    expect(await rebuildWallet(on.db, u, 'credits')).toEqual(expected);
    expect(await reconcileWallet(on.db, u, 'credits')).toEqual({
      userId: u,
      currency: 'credits',
      status: 'clean',
      expected,
      actual: { balance: 50, held: 0, version: 9 },
      discrepancies: [],
    });
  });

  it('with Credits held for an action in flight: held and spendable reconcile apart', async () => {
    const u = await user();
    await raw(u, 'grant', 20, 'earned');
    await holdCredits(on.db, { userId: u, currency: 'credits', amount: 8, idempotencyKey: key() });
    const result = await reconcileWallet(on.db, u, 'credits');
    expect(result.status).toBe('clean');
    expect(result.expected).toMatchObject({ balance: 12, held: 8, classes: { earned: { spendable: 12, held: 8 } } });
  });
});

/* ------------------------------------------------------------------ *
 * Introduced mismatches
 * ------------------------------------------------------------------ */

describe('an introduced mismatch is detected and reported exactly', () => {
  it('a cached balance, held amount or version edited behind the ledger', async () => {
    const u = await user();
    await fullHistory(u);
    await tamperWallet(u, 'balance = balance + 7, held = held + 1, version = version + 2');

    // The rebuild does not trust the cache: it still says what the ledger says.
    expect(await rebuildWallet(on.db, u, 'credits')).toMatchObject({ balance: 50, held: 0, version: 9 });
    const result = await reconcileWallet(on.db, u, 'credits');
    expect(result.status).toBe('discrepant');
    expect(result.actual).toEqual({ balance: 57, held: 1, version: 11 });
    expect(result.discrepancies).toEqual([
      { kind: 'balance_mismatch', expected: 50, actual: 57 },
      { kind: 'held_mismatch', expected: 0, actual: 1 },
      { kind: 'version_mismatch', expected: 9, actual: 11 },
    ]);
  });

  it('a transaction amount altered in the ledger: that row, and the balance it no longer supports', async () => {
    const u = await user();
    const { grants } = await fullHistory(u);
    await tamperLedger('UPDATE wallet_transactions SET amount = 31 WHERE id = $1', [grants.included]);
    const result = await reconcileWallet(on.db, u, 'credits');
    expect(result.discrepancies).toEqual([
      { kind: 'balance_mismatch', expected: 51, actual: 50 },
      { kind: 'stamped_balance_mismatch', sequence: 1, transactionId: grants.included, expected: 31, actual: 30 },
    ]);
  });

  it('a transaction deleted from the ledger: the gap, the version and the balance', async () => {
    const u = await user();
    const { paid } = await fullHistory(u);
    // The refund names the charge, so delete one nothing names: the earned grant (sequence 2).
    const earned = (await q<{ id: string }>("SELECT id FROM wallet_transactions WHERE user_id = $1 AND sequence = 2", [u])).rows[0]!.id;
    await tamperLedger('DELETE FROM wallet_transactions WHERE id = $1', [earned]);
    const result = await reconcileWallet(on.db, u, 'credits');
    const third = (await q<{ id: string }>("SELECT id FROM wallet_transactions WHERE user_id = $1 AND sequence = 3", [u])).rows[0]!.id;
    expect(result.discrepancies).toEqual([
      { kind: 'balance_mismatch', expected: 30, actual: 50 },
      { kind: 'version_mismatch', expected: 8, actual: 9 },
      { kind: 'sequence_gap', after: 1, next: 3 },
      { kind: 'stamped_balance_mismatch', sequence: 3, transactionId: third, expected: 40, actual: 60 },
      { kind: 'class_below_zero', creditClass: 'earned', sequence: 7, transactionId: paid, spendable: -4, held: 0 },
    ]);
  });

  it('a hold shrunk after it was captured: the over-settlement is named', async () => {
    const u = await user();
    await raw(u, 'grant', 20, 'purchased');
    const hold = (await holdCredits(on.db, { userId: u, currency: 'credits', amount: 5, idempotencyKey: key() })).transaction;
    await captureHold(on.db, { userId: u, holdTransactionId: hold.id, amount: 5, idempotencyKey: key() });
    await tamperLedger('UPDATE wallet_transactions SET amount = 3 WHERE id = $1', [hold.id]);
    const result = await reconcileWallet(on.db, u, 'credits');
    expect(result.discrepancies).toContainEqual({ kind: 'over_settled', transactionId: hold.id, amount: 3, settled: 5 });
  });

  it('a Credit class driven below zero -- which P2.1 alone does not prevent -- is named at the first transaction that did it', async () => {
    const u = await user();
    await raw(u, 'grant', 10, 'purchased');
    const debit = await raw(u, 'paid_action', 4, 'included');
    const result = await reconcileWallet(on.db, u, 'credits');
    expect(result.discrepancies).toEqual([
      { kind: 'class_below_zero', creditClass: 'included', sequence: 2, transactionId: debit, spendable: -4, held: 0 },
    ]);
    // Totals still agree: only the class accounting is wrong.
    expect(result.expected).toMatchObject({ balance: 6, held: 0 });
  });

  it('reports the same discrepancies every time it is run', async () => {
    const u = await user();
    await fullHistory(u);
    await tamperWallet(u, 'balance = balance + 1');
    const first = await reconcileWallet(on.db, u, 'credits');
    expect(await reconcileWallet(on.db, u, 'credits')).toEqual(first);
  });
});

/* ------------------------------------------------------------------ *
 * Operations use: many wallets, repeatedly, safely
 * ------------------------------------------------------------------ */

describe('reconciling every wallet', () => {
  it('pages through wallets in order and returns only the discrepant ones', async () => {
    const users = [await user(), await user(), await user(), await user(), await user()];
    for (const u of users) await raw(u, 'grant', 10, 'purchased');
    const sorted = [...users].sort();
    const broken = sorted[3]!;
    await tamperWallet(broken, 'balance = 99');

    const first = await reconcileWallets(on.db, { limit: 2 });
    expect(first).toMatchObject({ checked: 2, clean: 2, discrepant: [], next: { userId: sorted[1], currency: 'credits' } });
    const second = await reconcileWallets(on.db, { limit: 2, after: first.next });
    expect(second.checked).toBe(2);
    expect(second.discrepant.map((r) => [r.userId, r.discrepancies])).toEqual([
      [broken, [{ kind: 'balance_mismatch', expected: 10, actual: 99 }]],
    ]);
    const third = await reconcileWallets(on.db, { limit: 2, after: second.next });
    expect(third).toMatchObject({ checked: 1, clean: 1, discrepant: [], next: null });

    expect(await reconcileWallets(on.db)).toMatchObject({ checked: 5, clean: 4, next: null });
    expect(await reconcileWallets(on.db, { currency: 'hearts' })).toEqual({ checked: 0, clean: 0, discrepant: [], next: null });
  });

  it('writes nothing, however often it runs', async () => {
    const u = await user();
    await fullHistory(u);
    const snapshot = async () =>
      (
        await q<{ h: string }>(
          `SELECT md5(coalesce((SELECT string_agg(t::text, '|' ORDER BY user_id, currency) FROM wallets t), '') ||
                      coalesce((SELECT string_agg(t::text, '|' ORDER BY id) FROM wallet_transactions t), '') ||
                      coalesce((SELECT count(*)::text FROM audit_log), '')) AS h`,
        )
      ).rows[0]!.h;
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      await rebuildWallet(on.db, u, 'credits');
      await reconcileWallet(on.db, u, 'credits');
      await reconcileWallets(on.db);
    }
    expect(await snapshot()).toBe(before);
    const source = readFileSync(fileURLToPath(new URL('../services/wallet-reconciliation.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\bINSERT\s+INTO|\bUPDATE\s+"?wallet|\bDELETE\s+FROM|for\('update'\)/);
  });

  it('never reports a false discrepancy while the wallet is being written to', async () => {
    const u = await user();
    await raw(u, 'grant', 1000, 'purchased');
    const writes = Array.from({ length: 20 }, async (_, i) => {
      const held = await holdCredits(on.db, { userId: u, currency: 'credits', amount: 5, idempotencyKey: `w-${i}` });
      await releaseHold(on.db, { userId: u, holdTransactionId: held.transaction.id, amount: 5, idempotencyKey: `r-${i}` });
    });
    const checks = Array.from({ length: 20 }, () => reconcileWallet(on.db, u, 'credits'));
    const [results] = await Promise.all([Promise.all(checks), Promise.all(writes)]);
    expect(results.filter((r) => r.status !== 'clean')).toEqual([]);
    expect(await reconcileWallet(on.db, u, 'credits')).toMatchObject({ status: 'clean', expected: { balance: 1000, held: 0, version: 41 } });
  });
});
