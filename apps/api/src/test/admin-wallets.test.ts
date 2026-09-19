import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AdminUserWallets, AdminWalletAdjustmentResult, AdminWalletHistory, CustomerCommercialState } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { reconcileWallet } from '../services/wallet-reconciliation.js';
import {
  TEST_DATABASE_URL,
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * PRD v1.2 P2.4 -- the admin wallet support API.
 *
 * Three apps over one database: `dark` is the production default (economy
 * off, permission enforcement off); `live` has the economy on; `enforced` has
 * the economy on AND permission enforcement on. Every amount is test data.
 */

let dark: TestContext;
let live: TestContext;
let enforced: TestContext;
let seq = 0;

async function app(over: Partial<typeof testEnv>): Promise<TestContext> {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  return { app: await buildApp({ ...testEnv, ...over }, db), db, pool };
}

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  live = await app({ commerce: { ...testEnv.commerce, enabled: true } });
  enforced = await app({ commerce: { ...testEnv.commerce, enabled: true }, admin: { ...testEnv.admin, permissionsEnforced: true } });
});
afterAll(async () => {
  for (const ctx of [dark, live, enforced]) await destroyTestContext(ctx);
});
beforeEach(async () => truncateAll(dark));

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  dark.pool.query<T & import('pg').QueryResultRow>(text, params);

type Cookies = Record<string, string>;
interface Account {
  id: string;
  email: string;
  cookies: Cookies;
}

/** A registered account; staff when `roles` is given (an admin with those §34.1 grants). */
async function account(roles?: string[]): Promise<Account> {
  const email = `wallet-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'wallet-pass-1' } });
  expect(res.statusCode).toBe(201);
  const cookie = extractSessionCookie(res)!;
  const [row] = await dark.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (roles) {
    await dark.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
    for (const role of roles) await q('INSERT INTO admin_role_grants (user_id, role) VALUES ($1, $2)', [row!.id, role]);
  }
  return { id: row!.id, email, cookies: { [cookie.name]: cookie.value } };
}

const WALLETS = (u: string) => `/admin/users/${u}/wallets`;
const HISTORY = (u: string, currency = 'credits') => `/admin/users/${u}/wallets/${currency}/transactions`;
const ADJUST = (u: string, currency = 'credits') => `/admin/users/${u}/wallets/${currency}/adjustments`;

const get = (ctx: TestContext, url: string, who?: Account) => ctx.app.inject({ method: 'GET', url, ...(who ? { cookies: who.cookies } : {}) });
const post = (ctx: TestContext, url: string, who: Account | undefined, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url, payload, ...(who ? { cookies: who.cookies } : {}) });
const adjustment = (over: Record<string, unknown> = {}) => ({
  direction: 'credit',
  amount: 10,
  reason: 'Goodwill for a failed generation',
  idempotencyKey: randomUUID(),
  ...over,
});

async function fund(userId: string, amount: number, creditClass: 'included' | 'earned' | 'purchased') {
  await q("INSERT INTO wallets (user_id, currency) VALUES ($1, 'credits') ON CONFLICT DO NOTHING", [userId]);
  await q(
    `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
     VALUES ($1, 'credits', 'grant', 'credit', $2, $3, $4)`,
    [userId, amount, creditClass, `fixture:${randomUUID()}`],
  );
}

const ledgerCount = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM wallet_transactions')).rows[0]!.n;
const adjustmentAudits = async () =>
  (await q<Record<string, unknown>>("SELECT * FROM audit_log WHERE action LIKE 'wallet.adjust%' ORDER BY id")).rows;

/* ------------------------------------------------------------------ *
 * Access
 * ------------------------------------------------------------------ */

describe('access', () => {
  it('refuses an anonymous caller (401) and an ordinary user (403) on every route', async () => {
    const customer = await account();
    for (const ctx of [dark, live]) {
      for (const [who, status] of [[undefined, 401], [customer, 403]] as const) {
        expect((await get(ctx, WALLETS(customer.id), who)).statusCode).toBe(status);
        expect((await get(ctx, HISTORY(customer.id), who)).statusCode).toBe(status);
        expect((await post(ctx, ADJUST(customer.id), who, adjustment())).statusCode).toBe(status);
      }
    }
    expect(await ledgerCount()).toBe(0);
  });

  it('with enforcement on: reading needs users.commercial.read and adjusting needs users.credits.adjust', async () => {
    const customer = await account();
    const economyEditor = await account(['economy_editor']);
    const read = await get(enforced, WALLETS(customer.id), economyEditor);
    expect(read.statusCode).toBe(403);
    expect(read.json()).toMatchObject({ error: 'forbidden', permission: 'users.commercial.read' });
    expect((await get(enforced, HISTORY(customer.id), economyEditor)).json()).toMatchObject({ permission: 'users.commercial.read' });
    const write = await post(enforced, ADJUST(customer.id), economyEditor, adjustment());
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: 'forbidden', permission: 'users.credits.adjust' });

    const support = await account(['support']);
    expect((await get(enforced, WALLETS(customer.id), support)).statusCode).toBe(200);
    expect((await post(enforced, ADJUST(customer.id), support, adjustment())).statusCode).toBe(200);
    expect(await ledgerCount()).toBe(1);
  });

  it('with enforcement off -- the production default -- any staff member may read and adjust', async () => {
    const customer = await account();
    const staff = await account([]);
    expect((await get(live, WALLETS(customer.id), staff)).statusCode).toBe(200);
    expect((await post(live, ADJUST(customer.id), staff, adjustment())).statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

describe('reading a wallet', () => {
  it('confirms the account and shows every currency, with the operator\'s limits', async () => {
    const customer = await account();
    const support = await account(['support']);
    const res = await get(live, WALLETS(customer.id), support);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.json() as AdminUserWallets;
    expect(body.user).toMatchObject({ id: customer.id, email: customer.email });
    expect(body.economyEnabled).toBe(true);
    expect(body.wallets.find((w) => w.currency === 'credits')).toEqual({
      currency: 'credits',
      exists: false,
      balance: 0,
      held: 0,
      version: 0,
      classes: { included: { spendable: 0, held: 0 }, earned: { spendable: 0, held: 0 }, purchased: { spendable: 0, held: 0 } },
    });
    expect(body.allowances.find((a) => a.currency === 'credits')).toEqual({
      currency: 'credits',
      credit: { cap: 500, used: 0, remaining: 500 },
      debit: { cap: 1000, used: 0, remaining: 1000 },
    });
  });

  it('stays available while the economy is switched off, and says so', async () => {
    const customer = await account();
    const res = await get(dark, WALLETS(customer.id), await account(['support']));
    expect(res.statusCode).toBe(200);
    expect((res.json() as AdminUserWallets).economyEnabled).toBe(false);
  });

  it('answers 404 for an unknown user and 400 for a malformed User ID', async () => {
    const support = await account(['support']);
    expect((await get(live, WALLETS(randomUUID()), support)).json()).toMatchObject({ error: 'user_not_found' });
    expect((await get(live, WALLETS(randomUUID()), support)).statusCode).toBe(404);
    expect((await get(live, WALLETS('not-a-user'), support)).statusCode).toBe(400);
  });

  it('pages the history newest first, showing only what support needs', async () => {
    const customer = await account();
    const support = await account(['support']);
    for (let amount = 1; amount <= 7; amount++) {
      expect((await post(live, ADJUST(customer.id), support, adjustment({ amount, reference: `T-${amount}` }))).statusCode).toBe(200);
    }
    const page1 = (await get(live, `${HISTORY(customer.id)}?limit=3`, support)).json() as AdminWalletHistory;
    expect(page1.transactions.map((t) => t.sequence)).toEqual([7, 6, 5]);
    expect(page1.nextBefore).toBe(5);
    const page2 = (await get(live, `${HISTORY(customer.id)}?limit=3&before=5`, support)).json() as AdminWalletHistory;
    expect(page2.transactions.map((t) => t.sequence)).toEqual([4, 3, 2]);
    const page3 = (await get(live, `${HISTORY(customer.id)}?limit=3&before=${page2.nextBefore}`, support)).json() as AdminWalletHistory;
    expect(page3).toMatchObject({ nextBefore: null });
    expect(page3.transactions.map((t) => t.sequence)).toEqual([1]);

    expect(Object.keys(page1.transactions[0]!).sort()).toEqual(
      ['actorUserId', 'amount', 'balanceAfter', 'createdAt', 'creditClass', 'direction', 'entryType', 'heldAfter', 'id', 'reason', 'relatedTransactionId', 'sequence', 'source'],
    );
    expect(page1.transactions[0]).toMatchObject({ entryType: 'admin_adjustment', amount: 7, actorUserId: support.id, source: { type: 'support_reference', id: 'T-7' } });
    expect((await get(live, `${HISTORY(customer.id)}?limit=nope`, support)).statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ *
 * Adjusting
 * ------------------------------------------------------------------ */

describe('adjusting a wallet', () => {
  it('is refused while the economy is switched off -- nothing is read or written', async () => {
    const customer = await account();
    const res = await post(dark, ADJUST(customer.id), await account(['support']), adjustment());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'economy_unavailable', reason: 'economy_disabled' });
    expect(await ledgerCount()).toBe(0);
    expect(await adjustmentAudits()).toEqual([]);
    expect((await q('SELECT 1 FROM wallets')).rowCount).toBe(0);
  });

  it('a Credit: one earned transaction, the new balance at once, the remaining allowance, and an audit record', async () => {
    const customer = await account();
    const support = await account(['support']);
    const res = await post(live, ADJUST(customer.id), support, adjustment({ amount: 120, reference: 'T-42' }));
    expect(res.statusCode).toBe(200);
    const body = res.json() as AdminWalletAdjustmentResult;
    expect(body.replayed).toBe(false);
    expect(body.transaction).toMatchObject({ entryType: 'admin_adjustment', direction: 'credit', amount: 120, creditClass: 'earned', balanceAfter: 120, actorUserId: support.id });
    expect(body.wallet).toMatchObject({ currency: 'credits', exists: true, balance: 120, held: 0, classes: { earned: { spendable: 120, held: 0 } } });
    expect(body.allowance.credit).toEqual({ cap: 500, used: 120, remaining: 380 });

    const [audit] = await adjustmentAudits();
    expect(audit).toMatchObject({
      actor_user_id: support.id,
      actor_email: support.email,
      action: 'wallet.adjust.credit',
      object_type: 'wallet',
      object_id: `${customer.id}:credits`,
      before: { balance: 0, held: 0 },
      after: { balance: 120, held: 0 },
      reason: 'Goodwill for a failed generation',
      metadata: expect.objectContaining({ transactionId: body.transaction.id, reference: 'T-42', creditClass: 'earned' }),
    });
  });

  it('a Debit follows the spend order, and refusals come back as 409 with the reason', async () => {
    const customer = await account();
    const support = await account(['support']);
    await fund(customer.id, 30, 'included');
    await fund(customer.id, 30, 'earned');
    const debit = await post(live, ADJUST(customer.id), support, adjustment({ direction: 'debit', amount: 20 }));
    expect((debit.json() as AdminWalletAdjustmentResult).transaction).toMatchObject({ direction: 'debit', creditClass: 'included', balanceAfter: 40 });

    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ direction: 'debit', amount: 35 }, 'credit_class_split_required'],
      [{ direction: 'debit', amount: 41 }, 'insufficient_credits'],
      [{ direction: 'credit', amount: 501 }, 'adjustment_cap_exceeded'],
    ];
    for (const [over, code] of refusals) {
      const res = await post(live, ADJUST(customer.id), support, adjustment(over));
      expect(res.statusCode, code).toBe(409);
      expect(res.json(), code).toMatchObject({ error: code });
    }
    const empty = await account();
    expect((await post(live, ADJUST(empty.id), support, adjustment({ direction: 'debit', amount: 1 }))).json()).toMatchObject({ error: 'wallet_not_found' });
    // Only the one successful Debit was recorded.
    expect(await adjustmentAudits()).toHaveLength(1);
  });

  it('validates the request: a reason, an amount, a direction, a key -- and a known user and currency', async () => {
    const customer = await account();
    const support = await account(['support']);
    const invalid: Array<Record<string, unknown>> = [
      adjustment({ reason: undefined }),
      adjustment({ reason: '   ' }),
      adjustment({ amount: 0 }),
      adjustment({ amount: 1.5 }),
      adjustment({ amount: '5' }),
      adjustment({ direction: 'sideways' }),
      adjustment({ idempotencyKey: undefined }),
      adjustment({ reference: 'x'.repeat(101) }),
    ];
    for (const payload of invalid) {
      const res = await post(live, ADJUST(customer.id), support, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    }
    expect((await post(live, ADJUST(customer.id, 'hearts'), support, adjustment())).statusCode).toBe(400);
    expect((await post(live, ADJUST(randomUUID()), support, adjustment())).statusCode).toBe(404);
    expect(await ledgerCount()).toBe(0);
  });

  it('a retried submission applies once and is audited once; a different adjustment under its key is refused', async () => {
    const customer = await account();
    const support = await account(['support']);
    const payload = adjustment({ amount: 30, idempotencyKey: 'confirm-1' });
    const first = (await post(live, ADJUST(customer.id), support, payload)).json() as AdminWalletAdjustmentResult;
    const again = (await post(live, ADJUST(customer.id), support, payload)).json() as AdminWalletAdjustmentResult;
    expect(again.replayed).toBe(true);
    expect(again.transaction).toEqual(first.transaction);
    expect(again.wallet.balance).toBe(30);
    expect(await adjustmentAudits()).toHaveLength(1);
    const conflict = await post(live, ADJUST(customer.id), support, { ...payload, direction: 'debit' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'idempotency_conflict' });
  });
});

/* ------------------------------------------------------------------ *
 * Atomicity
 * ------------------------------------------------------------------ */

describe('an adjustment and its audit record commit together', () => {
  it('if the audit record cannot be written, the adjustment -- and the wallet it opened -- are rolled back', async () => {
    const customer = await account();
    const support = await account(['support']);
    const payload = adjustment({ amount: 50, idempotencyKey: 'atomic-1' });
    await q(
      `CREATE TRIGGER test_refuse_audit_insert BEFORE INSERT ON audit_log
         FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation()`,
    );
    try {
      const res = await post(live, ADJUST(customer.id), support, payload);
      expect(res.statusCode).toBe(500);
    } finally {
      await q('DROP TRIGGER test_refuse_audit_insert ON audit_log');
    }
    expect(await ledgerCount()).toBe(0);
    expect((await q('SELECT 1 FROM wallets WHERE user_id = $1', [customer.id])).rowCount).toBe(0);
    expect(await adjustmentAudits()).toEqual([]);

    // The key was not used up: the same submission now succeeds, once, with its record.
    const retried = (await post(live, ADJUST(customer.id), support, payload)).json() as AdminWalletAdjustmentResult;
    expect(retried.replayed).toBe(false);
    expect(await ledgerCount()).toBe(1);
    expect(await adjustmentAudits()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * What the customer sees
 * ------------------------------------------------------------------ */

describe('after an adjustment', () => {
  it('the wallet reconciles, and the customer commercial state (P3.1) shows the new balance', async () => {
    const customer = await account();
    const support = await account(['support']);
    await fund(customer.id, 10, 'included');
    await post(live, ADJUST(customer.id), support, adjustment({ amount: 25 }));
    await post(live, ADJUST(customer.id), support, adjustment({ direction: 'debit', amount: 5 }));
    expect((await reconcileWallet(live.db, customer.id, 'credits')).status).toBe('clean');
    const state = (await get(live, '/api/me/commercial-state', customer)).json() as CustomerCommercialState;
    expect(state.wallet).toEqual({ available: true, value: { included: 5, earned: 25, purchased: 0, held: 0, spendable: 30 } });
  });
});
