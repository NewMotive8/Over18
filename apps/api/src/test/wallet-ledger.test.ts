import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * PRD v1.2 P2.1 -- the wallet and the append-only ledger, as a DATA MODEL.
 *
 * Tests the database, not a service: nothing moves Credits yet (P2.2). It goes
 * through raw SQL on purpose, because what is under test is that the TABLES
 * refuse an invalid wallet or ledger whoever writes it -- a later service must
 * not be the only thing between a bug and a user's balance. Every amount here
 * is an arbitrary test figure, not an economy value.
 */

let on: TestContext;

/** A second, TEST-ONLY currency, proving wallets are per currency. Removed afterwards. */
const OTHER = 'test_second_currency';

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

interface Transaction {
  id: string;
  sequence: number;
  balance_after: number;
  held_after: number;
  created_at: Date;
  actor_user_id: string | null;
  reason: string | null;
}

interface Tx {
  type: string;
  direction: string;
  amount: number;
  class?: string;
  key?: string;
  related?: string | null;
  currency?: string;
  actor?: string | null;
  reason?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
}

async function user(): Promise<string> {
  const email = `${randomUUID()}@test.local`;
  return (await q<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'not-a-hash') RETURNING id", [email]))
    .rows[0]!.id;
}

async function wallet(userId: string, currency = 'credits'): Promise<string> {
  return (await q<{ id: string }>('INSERT INTO wallets (user_id, currency) VALUES ($1, $2) RETURNING id', [userId, currency]))
    .rows[0]!.id;
}

async function walletOf(userId: string, currency = 'credits') {
  return (
    await q<{ balance: number; held: number; version: number }>(
      'SELECT balance, held, version FROM wallets WHERE user_id = $1 AND currency = $2',
      [userId, currency],
    )
  ).rows[0]!;
}

async function append(userId: string, tx: Tx): Promise<Transaction> {
  const result = await q<Transaction>(
    `INSERT INTO wallet_transactions
       (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key,
        related_transaction_id, actor_user_id, reason, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      userId,
      tx.currency ?? 'credits',
      tx.type,
      tx.direction,
      tx.amount,
      tx.class ?? 'purchased',
      tx.key ?? randomUUID(),
      tx.related ?? null,
      tx.actor ?? null,
      tx.reason ?? null,
      tx.sourceType ?? null,
      tx.sourceId ?? null,
    ],
  );
  return result.rows[0]!;
}

const grant = (userId: string, amount: number, over: Partial<Tx> = {}) =>
  append(userId, { type: 'grant', direction: 'credit', amount, ...over });
const spend = (userId: string, amount: number, over: Partial<Tx> = {}) =>
  append(userId, { type: 'paid_action', direction: 'debit', amount, ...over });
const hold = (userId: string, amount: number, over: Partial<Tx> = {}) =>
  append(userId, { type: 'hold', direction: 'debit', amount, ...over });

/* ------------------------------------------------------------------ *
 * Currencies
 * ------------------------------------------------------------------ */

describe('wallet currencies', () => {
  it('Credits exists, and is the only currency the migrations introduce', async () => {
    const codes = (await q<{ code: string }>('SELECT code FROM wallet_currencies ORDER BY code')).rows.map((r) => r.code);
    expect(codes.filter((code) => code !== OTHER)).toEqual(['credits']);
  });

  it('a currency code is a stable lower-case code -- never an ISO money code', async () => {
    await expect(q("INSERT INTO wallet_currencies (code) VALUES ('USD')")).rejects.toThrow(/wallet_currencies_code_format/);
    await expect(q("INSERT INTO wallet_currencies (code) VALUES ('')")).rejects.toThrow(/wallet_currencies_code_format/);
  });
});

/* ------------------------------------------------------------------ *
 * Wallets
 * ------------------------------------------------------------------ */

describe('wallets', () => {
  it('one wallet per user and currency; a user may hold one in each currency', async () => {
    const u = await user();
    await wallet(u);
    await expect(wallet(u)).rejects.toThrow(/wallets_user_currency_unique/);
    await expect(wallet(u, OTHER)).resolves.toBeDefined();
    await expect(wallet(u, 'hearts')).rejects.toThrow(/wallets_currency_wallet_currencies_code_fk/);
    await expect(wallet(randomUUID())).rejects.toThrow(/wallets_user_id_users_id_fk/);
  });

  it('balances and amounts are integers', async () => {
    const columns = (
      await q<{ table_name: string; column_name: string; data_type: string }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE (table_name = 'wallets' AND column_name IN ('balance', 'held', 'version'))
             OR (table_name = 'wallet_transactions' AND column_name IN ('amount', 'balance_after', 'held_after', 'sequence'))`,
      )
    ).rows;
    expect(columns).toHaveLength(7);
    for (const c of columns) expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('integer');

    const u = await user();
    await wallet(u);
    await expect(grant(u, 1.5)).rejects.toThrow(/invalid input syntax for type integer/);
  });

  it('a wallet is created empty: Credits only ever arrive through the ledger', async () => {
    const u = await user();
    for (const column of ['balance', 'held', 'version']) {
      await expect(q(`INSERT INTO wallets (user_id, currency, ${column}) VALUES ($1, 'credits', 5)`, [u]), column).rejects.toThrow(
        /created empty/,
      );
    }
    await wallet(u);
    expect(await walletOf(u)).toEqual({ balance: 0, held: 0, version: 0 });
  });

  it('a balance is never written directly -- not to any value, and not the owner or currency', async () => {
    const u = await user();
    await wallet(u);
    await wallet(u, OTHER);
    await grant(u, 10);
    for (const set of [
      'balance = 1000000',
      'balance = 10',
      'held = 0',
      'version = 0',
      `user_id = '${randomUUID()}'`,
      `currency = '${OTHER}'`,
      'updated_at = now()',
    ]) {
      await expect(q(`UPDATE wallets SET ${set} WHERE user_id = $1 AND currency = 'credits'`, [u]), set).rejects.toThrow(
        /never written directly/,
      );
    }
    expect(await walletOf(u)).toEqual({ balance: 10, held: 0, version: 1 });
  });

  it('Credits cannot become negative -- by a spend, a hold or an operator', async () => {
    const u = await user();
    await wallet(u);
    await grant(u, 5);
    await expect(spend(u, 6)).rejects.toThrow(/below zero/);
    await expect(hold(u, 6)).rejects.toThrow(/below zero/);
    await expect(
      append(u, { type: 'admin_adjustment', direction: 'debit', amount: 6, actor: randomUUID(), reason: 'Test correction' }),
    ).rejects.toThrow(/below zero/);
    expect(await walletOf(u)).toEqual({ balance: 5, held: 0, version: 1 });

    expect((await spend(u, 5)).balance_after).toBe(0);
    const checks = await q("SELECT conname FROM pg_constraint WHERE conname IN ('wallets_balance_non_negative', 'wallets_held_non_negative')");
    expect(checks.rowCount).toBe(2);
  });

  it('two concurrent spends against a balance that covers one: exactly one succeeds', async () => {
    const u = await user();
    await wallet(u);
    await grant(u, 10);
    const insert = `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
                    VALUES ($1, 'credits', 'paid_action', 'debit', 10, 'purchased', $2)`;
    const first = await on.pool.connect();
    const second = await on.pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query(insert, [u, 'first']);
      // Waits on the wallet lock the first spend holds, then sees what it left.
      const racing = second.query(insert, [u, 'second']).then(
        () => 'succeeded',
        (error: Error) => error.message,
      );
      await first.query('COMMIT');
      expect(await racing).toMatch(/below zero/);
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    expect(await walletOf(u)).toEqual({ balance: 0, held: 0, version: 2 });
  });
});

/* ------------------------------------------------------------------ *
 * The ledger
 * ------------------------------------------------------------------ */

describe('the ledger', () => {
  it('a transaction moves its own wallet and records the balance it leaves, in sequence', async () => {
    const u = await user();
    await wallet(u);
    expect(await grant(u, 10)).toMatchObject({ sequence: 1, balance_after: 10, held_after: 0 });
    expect(await spend(u, 4)).toMatchObject({ sequence: 2, balance_after: 6, held_after: 0 });
    expect(await walletOf(u)).toEqual({ balance: 6, held: 0, version: 2 });
  });

  it('stamps the sequence, the resulting balance and the time itself -- a writer cannot supply them', async () => {
    const u = await user();
    await wallet(u);
    const row = (
      await q<Transaction>(
        `INSERT INTO wallet_transactions
           (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key, sequence, balance_after, held_after, created_at)
         VALUES ($1, 'credits', 'grant', 'credit', 10, 'included', 'k', 99, 1000000, 5, '2000-01-01T00:00:00Z') RETURNING *`,
        [u],
      )
    ).rows[0]!;
    expect(row).toMatchObject({ sequence: 1, balance_after: 10, held_after: 0 });
    expect(Date.now() - new Date(row.created_at).getTime()).toBeLessThan(60_000);
    expect(await walletOf(u)).toEqual({ balance: 10, held: 0, version: 1 });
  });

  it('several transactions in one statement chain correctly', async () => {
    const u = await user();
    await wallet(u);
    const rows = (
      await q<Transaction>(
        `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
         VALUES ($1, 'credits', 'grant', 'credit', 10, 'included', 'a'),
                ($1, 'credits', 'paid_action', 'debit', 3, 'included', 'b')
         RETURNING sequence, balance_after`,
        [u],
      )
    ).rows;
    expect(rows).toEqual([
      { sequence: 1, balance_after: 10 },
      { sequence: 2, balance_after: 7 },
    ]);
    expect(await walletOf(u)).toEqual({ balance: 7, held: 0, version: 2 });
  });

  it('refuses invalid transaction data, and moves nothing when it does', async () => {
    const u = await user();
    await wallet(u);
    const granted = await grant(u, 10);
    const invalid: Array<[string, Tx, RegExp]> = [
      ['zero amount', { type: 'grant', direction: 'credit', amount: 0 }, /amount_positive/],
      ['negative amount', { type: 'paid_action', direction: 'debit', amount: -5 }, /amount_positive/],
      ['unknown type', { type: 'gift', direction: 'credit', amount: 1 }, /invalid input value for enum wallet_entry_type/],
      ['unknown direction', { type: 'grant', direction: 'sideways', amount: 1 }, /invalid input value for enum wallet_entry_direction/],
      ['unknown Credit class', { type: 'grant', direction: 'credit', amount: 1, class: 'bonus' }, /invalid input value for enum credit_class/],
      ['a grant that debits', { type: 'grant', direction: 'debit', amount: 1 }, /direction_by_type/],
      ['a purchase that debits', { type: 'purchase', direction: 'debit', amount: 1 }, /direction_by_type/],
      ['a paid action that credits', { type: 'paid_action', direction: 'credit', amount: 1 }, /direction_by_type/],
      ['a hold that credits', { type: 'hold', direction: 'credit', amount: 1 }, /direction_by_type/],
      ['a blank idempotency key', { type: 'grant', direction: 'credit', amount: 1, key: '   ' }, /idempotency_key_format/],
      ['a source type without its id', { type: 'grant', direction: 'credit', amount: 1, sourceType: 'payment_event' }, /source_complete/],
      [
        'a malformed source type',
        { type: 'grant', direction: 'credit', amount: 1, sourceType: 'Payment Event', sourceId: 'evt_1' },
        /source_complete/,
      ],
      [
        'an operator adjustment without its operator',
        { type: 'admin_adjustment', direction: 'credit', amount: 1, reason: 'Goodwill' },
        /admin_attributed/,
      ],
      [
        'an operator adjustment without a reason',
        { type: 'admin_adjustment', direction: 'credit', amount: 1, actor: randomUUID(), reason: '  ' },
        /admin_attributed/,
      ],
      ['a grant that names another transaction', { type: 'grant', direction: 'credit', amount: 1, related: granted.id }, /related_by_type/],
      ['a refund that names nothing', { type: 'refund', direction: 'credit', amount: 1 }, /related_by_type/],
      ['a refund of a transaction that does not exist', { type: 'refund', direction: 'credit', amount: 1, related: randomUUID() }, /does not exist/],
    ];
    for (const [label, tx, error] of invalid) {
      await expect(append(u, tx), label).rejects.toThrow(error);
    }
    expect(await walletOf(u)).toEqual({ balance: 10, held: 0, version: 1 });
    expect((await q('SELECT 1 FROM wallet_transactions')).rowCount).toBe(1);
  });

  it("a transaction needs its owner's wallet in its currency", async () => {
    const u = await user();
    await expect(grant(u, 5)).rejects.toThrow(/has no credits wallet/);
    await wallet(u);
    await expect(grant(u, 5, { currency: OTHER })).rejects.toThrow(/has no test_second_currency wallet/);
    await expect(grant(u, 5, { currency: 'hearts' })).rejects.toThrow(/has no hearts wallet/);
  });

  it('an idempotency key applies once per wallet; a replay moves nothing', async () => {
    const u = await user();
    await wallet(u);
    await wallet(u, OTHER);
    await grant(u, 10, { key: 'purchase-1' });
    await expect(grant(u, 10, { key: 'purchase-1' })).rejects.toThrow(/wallet_transactions_idempotency_idx/);

    const replay = await q(
      `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
       VALUES ($1, 'credits', 'grant', 'credit', 10, 'purchased', 'purchase-1')
       ON CONFLICT (user_id, currency, idempotency_key) DO NOTHING RETURNING id`,
      [u],
    );
    expect(replay.rowCount).toBe(0);
    expect(await walletOf(u)).toEqual({ balance: 10, held: 0, version: 1 });
    // The refused and skipped writes left no gap in the sequence.
    expect((await grant(u, 1)).sequence).toBe(2);
    // The same key in another currency's wallet is another transaction.
    expect(await grant(u, 3, { key: 'purchase-1', currency: OTHER })).toMatchObject({ sequence: 1, balance_after: 3 });
  });

  it('an operator adjustment is a transaction like any other, carrying the operator and the reason', async () => {
    const u = await user();
    await wallet(u);
    const operator = randomUUID();
    const added = await append(u, {
      type: 'admin_adjustment',
      direction: 'credit',
      amount: 5,
      actor: operator,
      reason: 'Goodwill for a failed generation',
      sourceType: 'support_ticket',
      sourceId: 'T-1',
    });
    expect(added).toMatchObject({ actor_user_id: operator, reason: 'Goodwill for a failed generation', balance_after: 5 });
    const removed = await append(u, { type: 'admin_adjustment', direction: 'debit', amount: 2, actor: operator, reason: 'Correction' });
    expect(removed.balance_after).toBe(3);
  });

  it('a transaction can never be updated or deleted -- not even by an upsert', async () => {
    const u = await user();
    await wallet(u);
    const granted = await grant(u, 10, { key: 'k' });
    for (const statement of [
      'UPDATE wallet_transactions SET amount = 1000 WHERE id = $1',
      "UPDATE wallet_transactions SET reason = 'edited' WHERE id = $1",
      'DELETE FROM wallet_transactions WHERE id = $1',
    ]) {
      await expect(q(statement, [granted.id]), statement).rejects.toThrow(/append-only/);
    }
    await expect(
      q(
        `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
         VALUES ($1, 'credits', 'grant', 'credit', 1000, 'purchased', 'k')
         ON CONFLICT (user_id, currency, idempotency_key) DO UPDATE SET amount = 1000`,
        [u],
      ),
    ).rejects.toThrow(/append-only/);
    expect((await q<{ amount: number }>('SELECT amount FROM wallet_transactions WHERE id = $1', [granted.id])).rows[0]!.amount).toBe(10);
    expect(await walletOf(u)).toEqual({ balance: 10, held: 0, version: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * Holds and compensating transactions
 * ------------------------------------------------------------------ */

describe('holds, captures and releases', () => {
  it('a hold moves Credits from spendable to held; a capture consumes them; a release returns them', async () => {
    const u = await user();
    await wallet(u);
    await grant(u, 10, { class: 'included' });
    const held = await hold(u, 6, { class: 'included' });
    expect(held).toMatchObject({ balance_after: 4, held_after: 6 });
    const captured = await append(u, { type: 'capture', direction: 'debit', amount: 4, class: 'included', related: held.id });
    expect(captured).toMatchObject({ balance_after: 4, held_after: 2 });
    const released = await append(u, { type: 'release', direction: 'credit', amount: 2, class: 'included', related: held.id });
    expect(released).toMatchObject({ balance_after: 6, held_after: 0 });
    expect(await walletOf(u)).toEqual({ balance: 6, held: 0, version: 4 });

    // The wallet is exactly what its ledger derives (PRD §19.2).
    const derived = (
      await q<{ balance: number; held: number }>(
        `SELECT coalesce(sum(CASE WHEN entry_type = 'capture' THEN 0 WHEN direction = 'credit' THEN amount ELSE -amount END), 0)::int AS balance,
                coalesce(sum(CASE entry_type WHEN 'hold' THEN amount WHEN 'capture' THEN -amount WHEN 'release' THEN -amount ELSE 0 END), 0)::int AS held
           FROM wallet_transactions WHERE user_id = $1 AND currency = 'credits'`,
        [u],
      )
    ).rows[0]!;
    expect(derived).toEqual({ balance: 6, held: 0 });
  });

  it('a hold is settled only by its own class, never beyond what it reserved, and only a hold is', async () => {
    const u = await user();
    await wallet(u);
    await grant(u, 20, { class: 'included' });
    const held = await hold(u, 5, { class: 'included' });
    const settle = (type: 'capture' | 'release', amount: number, over: Partial<Tx> = {}) =>
      append(u, { type, direction: type === 'capture' ? 'debit' : 'credit', amount, class: 'included', related: held.id, ...over });

    await expect(settle('capture', 6)).rejects.toThrow(/would settle 6 of a hold of 5/);
    await settle('capture', 3);
    await expect(settle('release', 3)).rejects.toThrow(/would settle 6 of a hold of 5/);
    await expect(settle('release', 2, { class: 'earned' })).rejects.toThrow(/settles the included Credits its hold reserved/);
    const spent = await spend(u, 1, { class: 'included' });
    await expect(settle('capture', 1, { related: spent.id })).rejects.toThrow(/settles a hold, not a paid_action/);
    await settle('release', 2);
    await expect(settle('release', 1)).rejects.toThrow(/would settle 6 of a hold of 5/);
    expect(await walletOf(u)).toEqual({ balance: 16, held: 0, version: 5 });
  });
});

describe('compensating transactions', () => {
  it('a refund returns part or all of a paid action or a capture -- never more, and never for a grant', async () => {
    const u = await user();
    await wallet(u);
    const granted = await grant(u, 10);
    const spent = await spend(u, 6);
    const refund = (amount: number, related: string) => append(u, { type: 'refund', direction: 'credit', amount, related });
    expect((await refund(4, spent.id)).balance_after).toBe(8);
    await expect(refund(3, spent.id)).rejects.toThrow(/would compensate 7 of a transaction of 6/);
    expect((await refund(2, spent.id)).balance_after).toBe(10);
    await expect(refund(1, granted.id)).rejects.toThrow(/a refund returns Credits charged by a paid action or a capture, not a grant/);
  });

  it('a reversal runs opposite to what it reverses, never beyond it, and never undoes a hold', async () => {
    const u = await user();
    await wallet(u);
    const granted = await grant(u, 10);
    const reverse = (direction: string, amount: number, related: string) => append(u, { type: 'reversal', direction, amount, related });
    await expect(reverse('credit', 1, granted.id)).rejects.toThrow(/runs opposite/);
    expect((await reverse('debit', 4, granted.id)).balance_after).toBe(6);
    await expect(reverse('debit', 7, granted.id)).rejects.toThrow(/would compensate 11 of a transaction of 10/);
    const held = await hold(u, 1);
    await expect(reverse('credit', 1, held.id)).rejects.toThrow(/settled by a capture or release, not reversed/);
  });
});

/* ------------------------------------------------------------------ *
 * Isolation and referential integrity
 * ------------------------------------------------------------------ */

describe('isolation', () => {
  it("one user's transactions can never move, settle or compensate another user's wallet", async () => {
    const a = await user();
    const b = await user();
    await wallet(a);
    await wallet(b);
    await grant(a, 10);
    const bGrant = await grant(b, 10);
    const bHold = await hold(b, 5);

    await spend(a, 3);
    expect(await walletOf(a)).toEqual({ balance: 7, held: 0, version: 2 });
    expect(await walletOf(b)).toEqual({ balance: 5, held: 5, version: 2 });

    await expect(append(a, { type: 'release', direction: 'credit', amount: 5, related: bHold.id })).rejects.toThrow(/same wallet/);
    await expect(append(a, { type: 'reversal', direction: 'debit', amount: 1, related: bGrant.id })).rejects.toThrow(/same wallet/);
    await expect(q('UPDATE wallets SET balance = 0 WHERE user_id = $1', [b])).rejects.toThrow(/never written directly/);
    expect(await walletOf(b)).toEqual({ balance: 5, held: 5, version: 2 });
  });

  it('each currency is its own wallet and its own history', async () => {
    const u = await user();
    await wallet(u);
    await wallet(u, OTHER);
    await grant(u, 10);
    const other = await grant(u, 3, { currency: OTHER });
    expect(other.sequence).toBe(1);
    await spend(u, 4);
    expect(await walletOf(u)).toEqual({ balance: 6, held: 0, version: 2 });
    expect(await walletOf(u, OTHER)).toEqual({ balance: 3, held: 0, version: 1 });

    await expect(spend(u, 4, { currency: OTHER })).rejects.toThrow(/below zero/);
    await expect(append(u, { type: 'reversal', direction: 'debit', amount: 1, related: other.id })).rejects.toThrow(/same wallet/);
  });

  it('an owner, a wallet with history and a currency in use cannot be deleted', async () => {
    const u = await user();
    await wallet(u);
    await grant(u, 1);
    await expect(q('DELETE FROM users WHERE id = $1', [u])).rejects.toThrow(/wallets_user_id_users_id_fk/);
    await expect(q('DELETE FROM wallets WHERE user_id = $1', [u])).rejects.toThrow(/wallet_transactions_wallet_fk/);
    await expect(q("DELETE FROM wallet_currencies WHERE code = 'credits'")).rejects.toThrow(/wallets_currency_wallet_currencies_code_fk/);
  });
});

/* ------------------------------------------------------------------ *
 * No application path yet
 * ------------------------------------------------------------------ */

/**
 * P2.1 is schema only. No route or service may read or write a wallet yet, so
 * no user can reach one -- their own or anyone else's. P2.2's wallet service is
 * added here deliberately, as a reviewed decision; wallet-service.test.ts
 * checks that nothing in the application calls it yet.
 */
describe('no application path touches a wallet yet', () => {
  // P2.3: the read-only rebuild and reconciliation is the other reviewed reader.
  const ALLOWED = new Set(['db/schema.ts', 'services/wallet-service.ts', 'services/wallet-reconciliation.ts']);
  const WALLET_TABLES = /\b(walletCurrencies|wallets|walletTransactions|wallet_currencies|wallet_transactions)\b/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
    });
  }

  it('only the schema and the wallet service name the wallet tables', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const offenders = sourceFiles(src)
      .map((path) => relative(src, path).split('\\').join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => WALLET_TABLES.test(readFileSync(join(src, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
