import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { AdminUserDetail, AdminWalletAdjustmentResult } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
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
 * PRD v1.2 P2.5.3 -- wallet Credit / Debit inside Admin -> Users. There is ONE
 * adjustment: P2.4's endpoint and wallet service, which the User Detail now uses
 * too. What P2.5.3 adds to it, and proves here:
 *   D1  never an operator's own wallet -- refused centrally, for every entry point;
 *   D2  staff wallets may be adjusted, by another operator;
 *   D3  suspended customers may be adjusted, and stay suspended;
 *   and the User Detail shows an adjustment's balances and audit record at once.
 *
 * `dark` is the production default (economy off, enforcement off); `live` has
 * the economy on; `enforced` has the economy on and permission enforcement on.
 * Every amount is test data.
 */

let dark: TestContext;
let live: TestContext;
let enforced: TestContext;
let seq = 0;
const PASSWORD = 'wallet-pass-1';

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

interface Account {
  id: string;
  email: string;
  cookies: Record<string, string>;
}

/** A registered account (so it has a session); staff when `roles` is given. */
async function account(roles?: string[]): Promise<Account> {
  const email = `p253-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const [row] = await dark.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (roles) {
    await dark.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
    for (const role of roles) await q('INSERT INTO admin_role_grants (user_id, role) VALUES ($1, $2)', [row!.id, role]);
  }
  const cookie = extractSessionCookie(res)!;
  return { id: row!.id, email, cookies: { [cookie.name]: cookie.value } };
}

const ADJUST = (userId: string, currency = 'credits') => `/admin/users/${userId}/wallets/${currency}/adjustments`;
const adjustment = (over: Record<string, unknown> = {}) => ({
  direction: 'credit',
  amount: 40,
  reason: 'Goodwill for a failed image',
  idempotencyKey: randomUUID(),
  ...over,
});
const post = (ctx: TestContext, userId: string, who: Account, payload: unknown) =>
  ctx.app.inject({ method: 'POST', url: ADJUST(userId), cookies: who.cookies, payload: payload as object });
const adjusted = async (ctx: TestContext, userId: string, who: Account, payload: unknown) => {
  const res = await post(ctx, userId, who, payload);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminWalletAdjustmentResult;
};
const detail = async (ctx: TestContext, who: Account, userId: string) => {
  const res = await ctx.app.inject({ method: 'GET', url: `/admin/users/${userId}`, cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminUserDetail;
};

const ledgerCount = async () => (await q<{ n: number }>("SELECT count(*)::int AS n FROM wallet_transactions WHERE entry_type = 'admin_adjustment'")).rows[0]!.n;
const walletCount = async (userId: string) => (await q<{ n: number }>('SELECT count(*)::int AS n FROM wallets WHERE user_id = $1', [userId])).rows[0]!.n;
const adjustmentAudits = async () =>
  (await q<{ action: string; actor_user_id: string; object_id: string }>("SELECT action, actor_user_id, object_id FROM audit_log WHERE action LIKE 'wallet.adjust.%' ORDER BY id")).rows;

/* ------------------------------------------------------------------ *
 * D1 -- never one's own wallet
 * ------------------------------------------------------------------ */

describe("D1: an operator's own wallet", () => {
  it('is refused (409 own_wallet), Credit and Debit, with enforcement off -- nothing written, nothing audited', async () => {
    const staff = await account([]);
    for (const direction of ['credit', 'debit']) {
      const res = await post(live, staff.id, staff, adjustment({ direction }));
      expect(res.statusCode, direction).toBe(409);
      expect(res.json()).toMatchObject({ error: 'own_wallet', message: expect.stringMatching(/own wallet/) });
    }
    // The same person, spelled in upper case in the path.
    const upper = await post(live, staff.id.toUpperCase(), staff, adjustment());
    expect(upper.statusCode).toBe(409);
    expect(upper.json()).toMatchObject({ error: 'own_wallet' });
    expect(await walletCount(staff.id)).toBe(0);
    expect(await ledgerCount()).toBe(0);
    expect(await adjustmentAudits()).toEqual([]);
  });

  it('is refused with enforcement on, for every role that may adjust', async () => {
    for (const role of ['support', 'administrator']) {
      const operator = await account([role]);
      const res = await post(enforced, operator.id, operator, adjustment());
      expect(res.statusCode, role).toBe(409);
      expect(res.json()).toMatchObject({ error: 'own_wallet' });
    }
    expect(await ledgerCount()).toBe(0);
    expect(await adjustmentAudits()).toEqual([]);
  });

  it('uses none of the operator\'s daily allowance', async () => {
    const support = await account(['support']);
    expect((await post(enforced, support.id, support, adjustment({ amount: 40 }))).statusCode).toBe(409);
    const view = await enforced.app.inject({ method: 'GET', url: `/admin/users/${support.id}/wallets`, cookies: support.cookies });
    expect(view.json().allowances[0].credit).toMatchObject({ used: 0 });
  });

  it('while the economy is off, the switch still answers first -- 503, as for every adjustment', async () => {
    const staff = await account([]);
    const res = await post(dark, staff.id, staff, adjustment());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'economy_unavailable' });
  });
});

/* ------------------------------------------------------------------ *
 * D2 -- staff wallets; D3 -- suspended customers
 * ------------------------------------------------------------------ */

describe('D2: a staff wallet', () => {
  it('may be adjusted by another operator, and is audited like any other', async () => {
    const support = await account(['support']);
    const administrator = await account(['administrator']);
    const result = await adjusted(enforced, administrator.id, support, adjustment({ amount: 25 }));
    expect(result).toMatchObject({ replayed: false, transaction: { direction: 'credit', amount: 25, actorUserId: support.id } });
    expect(await adjustmentAudits()).toEqual([{ action: 'wallet.adjust.credit', actor_user_id: support.id, object_id: `${administrator.id}:credits` }]);
  });
});

describe('D3: a suspended customer', () => {
  it('may be credited and debited; the account stays suspended and its ended sessions stay ended', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    const suspended = await dark.app.inject({
      method: 'POST',
      url: `/admin/users/${customer.id}/status`,
      cookies: admin.cookies,
      payload: { status: 'suspended', expectedStatus: 'active', reason: 'Chargeback fraud' },
    });
    expect(suspended.statusCode, suspended.body).toBe(200);

    await adjusted(live, customer.id, admin, adjustment({ amount: 40 }));
    const debit = await adjusted(live, customer.id, admin, adjustment({ direction: 'debit', amount: 15, reason: 'Clawback' }));
    expect(debit.wallet).toMatchObject({ balance: 25 });

    expect((await q<{ status: string }>('SELECT status FROM users WHERE id = $1', [customer.id])).rows[0]!.status).toBe('suspended');
    expect((await dark.app.inject({ method: 'GET', url: '/api/auth/me', cookies: customer.cookies })).statusCode).toBe(401);
    expect((await adjustmentAudits()).map((a) => a.action)).toEqual(['wallet.adjust.credit', 'wallet.adjust.debit']);
  });
});

/* ------------------------------------------------------------------ *
 * The User Detail
 * ------------------------------------------------------------------ */

describe('the User Detail after an adjustment', () => {
  it('shows the new balance and the audited adjustment at once -- operator, reason and ledger transaction', async () => {
    const customer = await account();
    const support = await account([]);
    const before = await detail(live, support, customer.id);
    expect(before.wallets[0]).toMatchObject({ currency: 'credits', exists: false, spendable: 0 });

    const credit = await adjusted(live, customer.id, support, adjustment({ amount: 40, reason: 'Goodwill', reference: 'T-1' }));
    const afterCredit = await detail(live, support, customer.id);
    expect(afterCredit.wallets[0]).toMatchObject({ exists: true, earned: 40, spendable: 40, held: 0, transactions: 1 });

    const debit = await adjusted(live, customer.id, support, adjustment({ direction: 'debit', amount: 15, reason: 'Duplicate grant' }));
    const afterDebit = await detail(live, support, customer.id);
    expect(afterDebit.wallets[0]).toMatchObject({ earned: 25, spendable: 25, transactions: 2 });
    // Exactly the wallet the adjustment returned.
    expect(afterDebit.wallets[0]!.spendable).toBe(debit.wallet.balance);

    expect(afterDebit.audit.available).toBe(true);
    const entries = afterDebit.audit.available ? afterDebit.audit.entries.filter((e) => e.action.startsWith('wallet.adjust.')) : [];
    expect(entries.map((e) => [e.action, e.actorUserId, e.actorEmail, e.reason, e.metadata.transactionId]).sort()).toEqual(
      [
        ['wallet.adjust.credit', support.id, support.email, 'Goodwill', credit.transaction.id],
        ['wallet.adjust.debit', support.id, support.email, 'Duplicate grant', debit.transaction.id],
      ].sort(),
    );
  });
});

/* ------------------------------------------------------------------ *
 * One implementation
 * ------------------------------------------------------------------ */

describe('one adjustment implementation', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
      return name.endsWith('.ts') ? [path] : [];
    });
  const users_ = (pattern: RegExp) =>
    sourceFiles(src)
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(src, path).split(sep).join('/'))
      .sort();

  it('P2.5.3 adds no second write path: the P2.4 route is the only caller of the admin adjustment', () => {
    expect(users_(/\badjustUserWallet\b/)).toEqual(['routes/admin-wallets.ts', 'services/admin-wallet-service.ts']);
    expect(users_(/\badjustWallet\(/)).toEqual(['services/admin-wallet-service.ts', 'services/wallet-service.ts']);
    expect(users_(/\/adjustments'/)).toEqual(['routes/admin-wallets.ts']);
  });
});
