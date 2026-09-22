import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { AdminUserDetail, AdminUserList } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { seedCharacters } from '../db/seed.js';
import { readCustomerCommercialState } from '../services/customer-economy.js';
import { readWalletSummaries } from '../services/wallet-service.js';
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
 * PRD v1.2 P2.5.1 -- the admin users read model: GET /admin/users and
 * GET /admin/users/:userId.
 *
 * `dark` is the production default (economy off, permission enforcement off);
 * `live` has the economy on; `enforced` has the economy on and permission
 * enforcement on. Every plan, price and Credit figure is test data.
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

/** A registered account (so it has a session); staff when `roles` is given. */
async function account(roles?: string[], email = `user-${process.pid}-${++seq}@example.com`): Promise<Account> {
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'users-pass-1' } });
  expect(res.statusCode).toBe(201);
  const cookie = extractSessionCookie(res)!;
  const [row] = await dark.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (roles) {
    await dark.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
    for (const role of roles) await q('INSERT INTO admin_role_grants (user_id, role) VALUES ($1, $2)', [row!.id, role]);
  }
  return { id: row!.id, email, cookies: { [cookie.name]: cookie.value } };
}

/** A user inserted directly: no session, and a chosen creation time. */
async function bareUser(email: string, createdAt?: string): Promise<string> {
  return (
    await q<{ id: string }>(
      `INSERT INTO users (email, password_hash, created_at) VALUES ($1, 'not-a-hash', coalesce($2::timestamptz, now())) RETURNING id`,
      [email, createdAt ?? null],
    )
  ).rows[0]!.id;
}

const get = (ctx: TestContext, url: string, who?: Account) => ctx.app.inject({ method: 'GET', url, ...(who ? { cookies: who.cookies } : {}) });
const list = async (ctx: TestContext, who: Account, query = '') => {
  const res = await get(ctx, `/admin/users${query}`, who);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminUserList;
};
const detail = async (ctx: TestContext, who: Account, userId: string) => {
  const res = await get(ctx, `/admin/users/${userId}`, who);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminUserDetail;
};

/* ------------------------------------------------------------------ *
 * Access
 * ------------------------------------------------------------------ */

describe('access', () => {
  it('refuses an anonymous caller (401) and an ordinary user (403)', async () => {
    const customer = await account();
    for (const url of ['/admin/users', `/admin/users/${customer.id}`]) {
      expect((await get(dark, url)).statusCode, url).toBe(401);
      expect((await get(dark, url, customer)).statusCode, url).toBe(403);
    }
  });

  it('with enforcement on: needs users.commercial.read; the audit panel also needs audit.read', async () => {
    const customer = await account();
    const economyEditor = await account(['economy_editor']);
    for (const url of ['/admin/users', `/admin/users/${customer.id}`]) {
      const res = await get(enforced, url, economyEditor);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden', permission: 'users.commercial.read' });
    }
    const support = await account(['support']);
    expect((await list(enforced, support)).users.length).toBeGreaterThan(0);
    expect((await detail(enforced, support, customer.id)).audit).toEqual({ available: false, reason: 'audit_read_required' });
    const administrator = await account(['administrator']);
    expect((await detail(enforced, administrator, customer.id)).audit).toMatchObject({ available: true });
  });

  it('with enforcement off -- the production default -- any staff member may read, audit included', async () => {
    const customer = await account();
    const staff = await account([]);
    expect((await detail(dark, staff, customer.id)).audit).toMatchObject({ available: true });
  });
});

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

describe('the user list', () => {
  it('lists users newest first, with exactly the operational fields', async () => {
    const older = await bareUser('older@example.com', '2026-01-01T00:00:00Z');
    const staff = await account(['support', 'analyst']);
    const { users: rows, nextCursor } = await list(dark, staff);
    expect(nextCursor).toBeNull();
    expect(rows.map((u) => u.id)).toEqual([staff.id, older]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['createdAt', 'email', 'id', 'lastSignInAt', 'role', 'staffRoles', 'status']);
    expect(rows[0]).toMatchObject({ email: staff.email, role: 'admin', status: 'active', staffRoles: ['support', 'analyst'] }); // the §34.1 order
    expect(rows[0]!.lastSignInAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(rows[1]).toMatchObject({ email: 'older@example.com', role: 'user', staffRoles: [], lastSignInAt: null, createdAt: '2026-01-01T00:00:00.000000Z' });
  });

  it('searches part of an email, case-insensitively, or exactly one User ID', async () => {
    const staff = await account([]);
    const alice = await bareUser('alice.smith@example.com');
    await bareUser('bob@example.com');
    await bareUser('alice_b@example.com');
    expect((await list(dark, staff, '?search=ALICE.S')).users.map((u) => u.id)).toEqual([alice]);
    expect((await list(dark, staff, `?search=${alice.toUpperCase()}`)).users.map((u) => u.id)).toEqual([alice]);
    // `_` and `%` are literal, not patterns.
    expect((await list(dark, staff, '?search=alice_')).users.map((u) => u.email)).toEqual(['alice_b@example.com']);
    expect((await list(dark, staff, '?search=%25')).users).toEqual([]);
    expect((await list(dark, staff, `?search=${randomUUID()}`)).users).toEqual([]);
  });

  it('filters by account type and by creation date (UTC days, inclusive)', async () => {
    const staff = await account([]);
    const jan = await bareUser('jan@example.com', '2026-01-15T12:00:00Z');
    const feb = await bareUser('feb@example.com', '2026-02-01T00:00:00Z');
    const mar = await bareUser('mar@example.com', '2026-03-31T23:59:59Z');
    expect((await list(dark, staff, '?role=staff')).users.map((u) => u.id)).toEqual([staff.id]);
    expect((await list(dark, staff, '?role=customer')).users.map((u) => u.id)).toEqual([mar, feb, jan]);
    expect((await list(dark, staff, '?createdFrom=2026-02-01&createdTo=2026-03-31')).users.map((u) => u.id)).toEqual([mar, feb]);
    expect((await list(dark, staff, '?createdTo=2026-01-15')).users.map((u) => u.id)).toEqual([jan]);
    expect((await list(dark, staff, '?role=customer&search=feb')).users.map((u) => u.id)).toEqual([feb]);
  });

  it('pages deterministically: every user exactly once, ties broken by id, then no further page', async () => {
    const staff = await account([]);
    const same = '2026-05-05T05:05:05.123456Z';
    for (let i = 0; i < 5; i++) await bareUser(`tie-${i}@example.com`, same);
    for (let i = 0; i < 3; i++) await bareUser(`other-${i}@example.com`, `2026-04-0${i + 1}T00:00:00Z`);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: AdminUserList = await list(dark, staff, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.users.length).toBeLessThanOrEqual(2);
      seen.push(...page.users.map((u) => u.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    const all = (await list(dark, staff, '?limit=100')).users.map((u) => u.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(9);
  });

  it('bounds the page: 25 by default, 100 at most', async () => {
    const staff = await account([]);
    for (let i = 0; i < 30; i++) await bareUser(`bulk-${i}@example.com`);
    const first = await list(dark, staff);
    expect(first.users).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    expect((await get(dark, '/admin/users?limit=101', staff)).statusCode).toBe(400);
  });

  it('costs the same number of database round trips for 2 users as for 20 -- no N+1', async () => {
    const staff = await account([]);
    for (let i = 0; i < 20; i++) await bareUser(`n1-${i}@example.com`);
    const pool = live.pool as unknown as { query: (...args: unknown[]) => unknown };
    const original = pool.query;
    let calls = 0;
    pool.query = (...args: unknown[]) => {
      calls++;
      return original.apply(live.pool, args);
    };
    try {
      calls = 0;
      await list(live, staff, '?limit=2');
      const small = calls;
      calls = 0;
      await list(live, staff, '?limit=20');
      expect(calls).toBe(small);
    } finally {
      pool.query = original;
    }
  });

  it('refuses malformed parameters with 400 invalid_request', async () => {
    const staff = await account([]);
    for (const query of [
      '?role=owner',
      '?status=closed',
      '?limit=0',
      '?limit=abc',
      '?limit=2.5',
      '?createdFrom=2026-13-01',
      '?createdFrom=2026-02-30',
      '?createdFrom=01/02/2026',
      '?createdFrom=2026-03-01&createdTo=2026-02-01',
      '?cursor=not-a-cursor',
      `?cursor=${Buffer.from(JSON.stringify({ c: 'yesterday', i: 'x' })).toString('base64url')}`,
      `?search=${'x'.repeat(255)}`,
    ]) {
      const res = await get(dark, `/admin/users${query}`, staff);
      expect(res.statusCode, query).toBe(400);
      expect(res.json(), query).toMatchObject({ error: 'invalid_request' });
    }
  });
});

/* ------------------------------------------------------------------ *
 * The detail
 * ------------------------------------------------------------------ */

async function publishedPlan(code: string): Promise<string> {
  const planId = (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
  const versionId = (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits)
       VALUES ($1, 1, 'Fixture plan', 1, 1111, 'USD', 11) RETURNING id`,
      [planId],
    )
  ).rows[0]!.id;
  await q(`UPDATE economy_plan_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`, [versionId, randomUUID()]);
  return versionId;
}

describe('the user detail', () => {
  it('consolidates identity, account, activity, commercial state, wallets and audit -- from their owners', async () => {
    const customer = await account();
    const admin = await account([]);
    // Commercial: an active subscription (P3.1).
    await q("INSERT INTO subscriptions (user_id, plan_version_id, status, current_period_end) VALUES ($1, $2, 'active', now() + interval '30 days')", [
      customer.id,
      await publishedPlan('premium_monthly'),
    ]);
    // Wallet: a support Credit through the P2.4 API (audited).
    const credit = await live.app.inject({
      method: 'POST',
      url: `/admin/users/${customer.id}/wallets/credits/adjustments`,
      cookies: admin.cookies,
      payload: { direction: 'credit', amount: 40, reason: 'Goodwill', idempotencyKey: randomUUID() },
    });
    expect(credit.statusCode).toBe(200);
    // Activity: two conversations.
    await seedCharacters(dark.db);
    const characters = (await q<{ id: string }>('SELECT id FROM characters ORDER BY name LIMIT 2')).rows;
    for (const c of characters) await q('INSERT INTO conversations (user_id, character_id) VALUES ($1, $2)', [customer.id, c.id]);

    const view = await detail(live, admin, customer.id);
    expect(view.identity).toEqual({ id: customer.id, email: customer.email });
    expect(view.account).toMatchObject({ role: 'user', staffRoles: [] });
    expect(view.activity).toMatchObject({ activeSessions: 1, conversations: 2 });
    expect(view.activity.lastSignInAt).not.toBeNull();
    expect(view.activity.lastConversationAt).not.toBeNull();
    expect(view.commercial).toMatchObject({
      economyEnabled: true,
      tier: { available: true, value: 'premium' },
      subscription: { available: true, value: { status: 'active', planCode: 'premium_monthly' } },
      age: { available: false, reason: 'age_verification_not_supported' },
    });
    expect(view.wallets).toEqual([
      { currency: 'credits', exists: true, included: 0, earned: 40, purchased: 0, held: 0, spendable: 40, transactions: 1 },
    ]);
    expect(view.audit.available && view.audit.entries.map((e) => e.action)).toEqual(['wallet.adjust.credit']);
  });

  it('is exactly the P3.1 commercial state and the P2.4 wallet read model -- not a second calculation', async () => {
    const customer = await account();
    const admin = await account([]);
    await live.app.inject({
      method: 'POST',
      url: `/admin/users/${customer.id}/wallets/credits/adjustments`,
      cookies: admin.cookies,
      payload: { direction: 'credit', amount: 25, reason: 'Goodwill', idempotencyKey: randomUUID() },
    });
    const view = await detail(live, admin, customer.id);
    const commercial = await readCustomerCommercialState(live.db, { id: customer.id, email: customer.email, role: 'user' });
    expect(view.commercial).toEqual({ economyEnabled: true, tier: commercial.tier, subscription: commercial.subscription, age: commercial.age });
    const [summary] = await readWalletSummaries(live.db, customer.id);
    expect(view.wallets[0]).toEqual({
      currency: summary!.currency,
      exists: summary!.exists,
      included: summary!.classes.included.spendable,
      earned: summary!.classes.earned.spendable,
      purchased: summary!.classes.purchased.spendable,
      held: summary!.held,
      spendable: summary!.balance,
      transactions: summary!.version,
    });
    // And the customer is told the same wallet.
    expect(commercial.wallet).toEqual({ available: true, value: { included: 0, earned: 25, purchased: 0, held: 0, spendable: 25 } });
  });

  it("shows a staff member's grants and the audit entries about and by them", async () => {
    const administrator = await account([]);
    const operator = await account(['analyst']);
    const grant = await dark.app.inject({
      method: 'POST',
      url: `/admin/roles/${operator.id}/support/grant`,
      cookies: administrator.cookies,
      payload: { reason: 'Joins support' },
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const view = await detail(dark, administrator, operator.id);
    expect(view.account.role).toBe('admin');
    expect(view.account.staffRoles.map((g) => g.role)).toEqual(['support', 'analyst']); // the §34.1 order
    expect(view.account.staffRoles.find((g) => g.role === 'support')?.grantedBy).toBe(administrator.id);
    expect(view.audit.available && view.audit.entries.map((e) => [e.action, e.objectId])).toEqual([['admin.roles.grant', operator.id]]);
  });

  it('reads while the economy is switched off, and says so', async () => {
    const customer = await account();
    const view = await detail(dark, await account([]), customer.id);
    expect(view.commercial).toMatchObject({ economyEnabled: false, tier: { available: true, value: 'free' }, subscription: { available: true, value: null } });
    expect(view.wallets[0]).toMatchObject({ currency: 'credits', exists: false, spendable: 0 });
  });

  it('answers 404 for an unknown user and 400 for a malformed User ID', async () => {
    const staff = await account([]);
    const unknown = await get(dark, `/admin/users/${randomUUID()}`, staff);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: 'user_not_found' });
    expect((await get(dark, '/admin/users/not-a-user', staff)).statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ *
 * What never leaves the server
 * ------------------------------------------------------------------ */

describe('minimum data, per user', () => {
  it('never exposes a password hash, a session token or any credential', async () => {
    const customer = await account();
    const staff = await account([]);
    const { password_hash: hash } = (await q<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [customer.id])).rows[0]!;
    const tokens = (await q<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = $1', [customer.id])).rows.map((r) => r.token_hash);
    for (const body of [(await get(dark, '/admin/users', staff)).body, (await get(dark, `/admin/users/${customer.id}`, staff)).body]) {
      expect(body).not.toContain(hash);
      for (const token of tokens) expect(body).not.toContain(token);
      expect(body).not.toContain(Object.values(customer.cookies)[0]!);
      expect(body).not.toMatch(/password|passwordHash|tokenHash|token_hash|refresh|oauth/i);
    }
  });

  it("one user's detail carries nothing of another's", async () => {
    const alice = await account();
    const bob = await account();
    const admin = await account([]);
    await live.app.inject({
      method: 'POST',
      url: `/admin/users/${bob.id}/wallets/credits/adjustments`,
      cookies: admin.cookies,
      payload: { direction: 'credit', amount: 99, reason: 'Goodwill', idempotencyKey: randomUUID() },
    });
    const view = await detail(live, admin, alice.id);
    const body = JSON.stringify(view);
    expect(body).not.toContain(bob.id);
    expect(body).not.toContain(bob.email);
    expect(view.wallets[0]).toMatchObject({ exists: false, spendable: 0 });
    expect(view.audit.available && view.audit.entries).toEqual([]);
    expect(view.activity.activeSessions).toBe(1);
  });

  it('reads only: no table gains, loses or changes a row', async () => {
    const customer = await account();
    const staff = await account([]);
    const snapshot = async () => {
      const tables = (await q<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
      const out: Record<string, string> = {};
      for (const t of tables) out[t] = (await q<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0]!.h;
      return out;
    };
    const before = await snapshot();
    await get(live, '/admin/users?search=example', staff);
    await get(live, `/admin/users/${customer.id}`, staff);
    await get(dark, `/admin/users/${customer.id}`, staff);
    expect(await snapshot()).toEqual(before);
  });

  it('the read model writes nothing and computes no balance or subscription of its own', () => {
    const source = readFileSync(fileURLToPath(new URL('../services/admin-user-service.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\bINSERT\s+INTO|\bDELETE\s+FROM/);
    expect(source).not.toMatch(/wallet_transactions|walletTransactions|subscriptions\b|economy_plan/);
  });
});
