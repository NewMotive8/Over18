import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import {
  ADMIN_ROLE_PERMISSIONS,
  ADMIN_ROLES,
  type AdminAccountStatusChangeResult,
  type AdminUserDetail,
  type AdminUserList,
} from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashToken } from '../services/auth-service.js';
import { readCustomerCommercialState } from '../services/customer-economy.js';
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
 * PRD v1.2 P2.5.2 -- account status: POST /admin/users/:userId/status, its
 * audit record, and what a suspension does to sign-in and sessions.
 *
 * `dark` is the production default (economy off, permission enforcement off);
 * `live` has the economy on (only to give a customer a wallet through P2.4);
 * `enforced` has permission enforcement on and the economy still off. Every
 * plan, price and Credit figure is test data.
 */

let dark: TestContext;
let live: TestContext;
let enforced: TestContext;
let seq = 0;
const PASSWORD = 'status-pass-1';
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

async function app(over: Partial<typeof testEnv>): Promise<TestContext> {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  return { app: await buildApp({ ...testEnv, ...over }, db), db, pool };
}

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  live = await app({ commerce: { ...testEnv.commerce, enabled: true } });
  enforced = await app({ admin: { ...testEnv.admin, permissionsEnforced: true } });
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

const cookiesOf = (res: { cookies: Array<{ name: string; value: string }> }): Cookies => {
  const cookie = extractSessionCookie(res)!;
  return { [cookie.name]: cookie.value };
};

/** A registered account (so it has a session); staff when `roles` is given. */
async function account(roles?: string[]): Promise<Account> {
  const email = `status-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const [row] = await dark.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (roles) {
    await dark.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
    for (const role of roles) await q('INSERT INTO admin_role_grants (user_id, role) VALUES ($1, $2)', [row!.id, role]);
  }
  return { id: row!.id, email, cookies: cookiesOf(res) };
}

const SUSPEND = { status: 'suspended', expectedStatus: 'active', reason: 'Chargeback fraud' } as const;
const REACTIVATE = { status: 'active', expectedStatus: 'suspended', reason: 'Resolved with the customer' } as const;

const change = (ctx: TestContext, who: Account | null, userId: string, payload: unknown) =>
  ctx.app.inject({ method: 'POST', url: `/admin/users/${userId}/status`, ...(who ? { cookies: who.cookies } : {}), payload: payload as object });

const changed = async (ctx: TestContext, who: Account, userId: string, payload: unknown) => {
  const res = await change(ctx, who, userId, payload);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminAccountStatusChangeResult;
};

const detail = async (ctx: TestContext, who: Account, userId: string) => {
  const res = await ctx.app.inject({ method: 'GET', url: `/admin/users/${userId}`, cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminUserDetail;
};

const list = async (who: Account, query: string) => {
  const res = await dark.app.inject({ method: 'GET', url: `/admin/users${query}`, cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminUserList;
};

const statusOf = async (id: string) => (await q<{ status: string }>('SELECT status FROM users WHERE id = $1', [id])).rows[0]?.status;

interface AuditRow {
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
}
const statusAudits = async () =>
  (
    await q<AuditRow>(
      `SELECT actor_user_id, actor_email, action, object_type, object_id, before, after, reason, request_id, metadata
         FROM audit_log WHERE object_type = 'account_status' ORDER BY id`,
    )
  ).rows;
const auditCount = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM audit_log')).rows[0]!.n;

const me = (who: { cookies: Cookies }) => dark.app.inject({ method: 'GET', url: '/api/auth/me', cookies: who.cookies });
const login = (email: string, password = PASSWORD) => dark.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
const sessionCount = async (userId: string) => (await q<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [userId])).rows[0]!.n;

/* ------------------------------------------------------------------ *
 * Who may
 * ------------------------------------------------------------------ */

describe('who may change an account status', () => {
  it('refuses an anonymous caller (401) and a customer (403), and records nothing', async () => {
    const target = await account();
    const customer = await account();
    expect((await change(dark, null, target.id, SUSPEND)).statusCode).toBe(401);
    expect((await change(dark, customer, target.id, SUSPEND)).statusCode).toBe(403);
    expect(await statusOf(target.id)).toBe('active');
    expect(await auditCount()).toBe(0);
  });

  it('with enforcement on: only the administrator role holds users.status.manage', async () => {
    expect(ADMIN_ROLES.filter((role) => ADMIN_ROLE_PERMISSIONS[role].includes('users.status.manage'))).toEqual(['administrator']);
    const target = await account();
    for (const role of ADMIN_ROLES.filter((r) => r !== 'administrator')) {
      const staff = await account([role]);
      const res = await change(enforced, staff, target.id, SUSPEND);
      expect(res.statusCode, role).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden', permission: 'users.status.manage' });
    }
    expect((await change(enforced, await account([]), target.id, SUSPEND)).statusCode).toBe(403);
    expect(await statusOf(target.id)).toBe('active');
    expect(await auditCount()).toBe(0);

    const administrator = await account(['administrator']);
    expect((await changed(enforced, administrator, target.id, SUSPEND)).status).toBe('suspended');
  });

  it('with enforcement off -- the production default -- any staff member may, as on every admin route', async () => {
    const target = await account();
    const staff = await account([]);
    expect((await changed(dark, staff, target.id, SUSPEND)).status).toBe('suspended');
  });

  it('the detail tells each operator whether they may, by the same rules the change enforces', async () => {
    const customer = await account();
    const support = await account(['support']);
    const administrator = await account(['administrator']);
    const otherStaff = await account(['analyst']);
    expect((await detail(enforced, support, customer.id)).account).toMatchObject({
      status: 'active',
      statusChange: { allowed: false, reason: 'permission_required' },
    });
    expect((await detail(enforced, administrator, customer.id)).account.statusChange).toEqual({ allowed: true });
    expect((await detail(enforced, administrator, otherStaff.id)).account.statusChange).toEqual({ allowed: false, reason: 'staff_account' });
    expect((await detail(enforced, administrator, administrator.id)).account.statusChange).toEqual({ allowed: false, reason: 'own_account' });
  });
});

/* ------------------------------------------------------------------ *
 * The change
 * ------------------------------------------------------------------ */

describe('suspending and reactivating a customer', () => {
  it('suspends: persisted, shown in the list and the detail, and audited once with actor, before, after and reason', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    const before = (await q<{ updated_at: string }>('SELECT updated_at::text FROM users WHERE id = $1', [customer.id])).rows[0]!.updated_at;

    const result = await changed(dark, admin, customer.id, { ...SUSPEND, reason: '  Chargeback fraud  ' });
    expect(result).toEqual({
      userId: customer.id,
      previousStatus: 'active',
      status: 'suspended',
      changedAt: expect.stringMatching(ISO_US),
      revokedSessions: 1,
    });

    // Persisted, and the account's updatedAt is the change's time.
    expect(await statusOf(customer.id)).toBe('suspended');
    const after = (await q<{ updated_at: string }>('SELECT updated_at::text FROM users WHERE id = $1', [customer.id])).rows[0]!.updated_at;
    expect(after).not.toBe(before);
    const view = await detail(dark, admin, customer.id);
    expect(view.account.status).toBe('suspended');
    expect(view.account.updatedAt).toBe(result.changedAt);

    // The list shows it, and filters on it.
    expect((await list(admin, '?status=suspended')).users.map((u) => u.id)).toEqual([customer.id]);
    expect((await list(admin, '?status=active')).users.map((u) => u.id)).toEqual([admin.id]);
    expect((await list(admin, '')).users.find((u) => u.id === customer.id)?.status).toBe('suspended');

    const audits = await statusAudits();
    expect(audits).toEqual([
      {
        actor_user_id: admin.id,
        actor_email: admin.email,
        action: 'account.status.suspend',
        object_type: 'account_status',
        object_id: customer.id,
        before: { status: 'active' },
        after: { status: 'suspended' },
        reason: 'Chargeback fraud',
        request_id: expect.any(String),
        metadata: { source: 'admin', revokedSessions: 1 },
      },
    ]);
    expect(await auditCount()).toBe(1);
    // ... and the user's detail lists it among the audit entries about them.
    expect(view.audit.available && view.audit.entries.map((e) => e.action)).toEqual(['account.status.suspend']);
  });

  it('reactivates: persisted, with its own audit record; the trail replays to the stored status', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    await changed(dark, admin, customer.id, SUSPEND);
    const result = await changed(dark, admin, customer.id, REACTIVATE);
    expect(result).toMatchObject({ previousStatus: 'suspended', status: 'active', revokedSessions: 0 });
    expect(await statusOf(customer.id)).toBe('active');
    const audits = await statusAudits();
    expect(audits.map((a) => [a.action, a.before, a.after, a.reason, a.metadata])).toEqual([
      ['account.status.suspend', { status: 'active' }, { status: 'suspended' }, 'Chargeback fraud', { source: 'admin', revokedSessions: 1 }],
      ['account.status.reactivate', { status: 'suspended' }, { status: 'active' }, 'Resolved with the customer', { source: 'admin', revokedSessions: 0 }],
    ]);
    expect(new Set(audits.map((a) => a.request_id)).size).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

describe('a refused change changes nothing and records nothing', () => {
  it('refuses a malformed request (400)', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    const bodies: unknown[] = [
      {},
      [SUSPEND],
      { ...SUSPEND, status: 'closed' },
      { ...SUSPEND, status: 'deleted' },
      { status: 'suspended', reason: 'x' },
      { ...SUSPEND, expectedStatus: 'suspended' },
      { status: 'suspended', expectedStatus: 'active' },
      { ...SUSPEND, reason: '   ' },
      { ...SUSPEND, reason: 7 },
      { ...SUSPEND, reason: 'x'.repeat(501) },
      { ...SUSPEND, role: 'admin' },
    ];
    for (const body of bodies) {
      const res = await change(dark, admin, customer.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    }
    expect((await change(dark, admin, 'not-a-user-id', SUSPEND)).statusCode).toBe(400);
    expect(await statusOf(customer.id)).toBe('active');
    expect(await auditCount()).toBe(0);
    expect((await me(customer)).statusCode).toBe(200);
  });

  it('refuses an unknown user (404)', async () => {
    const admin = await account(['administrator']);
    const res = await change(dark, admin, randomUUID(), SUSPEND);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'user_not_found' });
    expect(await auditCount()).toBe(0);
  });

  it("refuses a staff account and the operator's own account (409)", async () => {
    const admin = await account(['administrator']);
    const otherAdmin = await account(['administrator']);
    const support = await account(['support']);
    for (const target of [otherAdmin, support]) {
      const res = await change(dark, admin, target.id, SUSPEND);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'staff_account' });
    }
    const own = await change(dark, admin, admin.id, SUSPEND);
    expect(own.statusCode).toBe(409);
    expect(own.json()).toMatchObject({ error: 'own_account' });
    for (const who of [admin, otherAdmin, support]) {
      expect(await statusOf(who.id)).toBe('active');
      expect((await me(who)).statusCode).toBe(200);
    }
    expect(await auditCount()).toBe(0);
  });

  it('refuses a change from a status the account is no longer in (409 status_conflict, with the current status)', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    const wrong = await change(dark, admin, customer.id, REACTIVATE);
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ error: 'status_conflict', currentStatus: 'active' });

    await changed(dark, admin, customer.id, SUSPEND);
    // A second operator, looking at the account as it was: refused, not re-applied.
    const stale = await change(dark, await account(['administrator']), customer.id, SUSPEND);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'status_conflict', currentStatus: 'suspended' });
    expect(await statusOf(customer.id)).toBe('suspended');
    expect(await statusAudits()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

describe('concurrent changes', () => {
  it('the same change at once from several operators: exactly one applies, with one audit record', async () => {
    const customer = await account();
    const operators = [await account(['administrator']), await account(['administrator']), await account(['administrator'])];
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => change(dark, operators[i % 3]!, customer.id, SUSPEND)));
    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409]);
    for (const r of responses.filter((x) => x.statusCode === 409)) expect(r.json()).toMatchObject({ error: 'status_conflict', currentStatus: 'suspended' });
    expect(await statusOf(customer.id)).toBe('suspended');
    const audits = await statusAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ source: 'admin', revokedSessions: 1 });
  });

  it('opposite changes at once serialise: one audit record per applied change, and the trail replays to the stored status', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => change(dark, admin, customer.id, i % 2 === 0 ? SUSPEND : REACTIVATE)));
    const applied = responses.filter((r) => r.statusCode === 200).length;
    expect(applied).toBeGreaterThanOrEqual(1);
    expect(responses.every((r) => r.statusCode === 200 || r.statusCode === 409)).toBe(true);
    const audits = await statusAudits();
    expect(audits).toHaveLength(applied);
    let status = 'active';
    for (const a of audits) {
      expect(a.before).toEqual({ status });
      status = (a.after as { status: string }).status;
    }
    expect(await statusOf(customer.id)).toBe(status);
  });
});

/* ------------------------------------------------------------------ *
 * Sign-in and sessions
 * ------------------------------------------------------------------ */

describe('what a suspension does to sign-in and sessions', () => {
  it('ends every session at once and refuses sign-in -- telling only someone with the right password why', async () => {
    const customer = await account();
    const second = { cookies: cookiesOf(await login(customer.email)) };
    const admin = await account(['administrator']);
    expect((await me(customer)).statusCode).toBe(200);
    expect((await me(second)).statusCode).toBe(200);

    expect((await changed(dark, admin, customer.id, SUSPEND)).revokedSessions).toBe(2);
    for (const session of [customer, second]) {
      expect((await me(session)).statusCode).toBe(401);
      expect((await dark.app.inject({ method: 'GET', url: '/api/me/commercial-state', cookies: session.cookies })).statusCode).toBe(401);
    }

    const refused = await login(customer.email);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'account_suspended', message: expect.stringMatching(/suspended/) });
    expect(extractSessionCookie(refused)).toBeUndefined();
    // Without the password, a suspended account looks like any failed sign-in.
    const wrong = await login(customer.email, 'not-the-password');
    const unknown = await login('nobody-here@example.com');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());

    // The sessions were ended, not erased: the sign-in history is kept.
    expect(await sessionCount(customer.id)).toBe(2);
    const view = await detail(dark, admin, customer.id);
    expect(view.activity.activeSessions).toBe(0);
    expect(view.activity.lastSignInAt).not.toBeNull();
    // The operator's own session is untouched.
    expect((await me(admin)).statusCode).toBe(200);
  });

  it('a session created as the suspension commits does not work either', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    await changed(dark, admin, customer.id, SUSPEND);
    const token = randomUUID();
    await q(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [customer.id, hashToken(token)]);
    expect((await me({ cookies: { over18_session: token } })).statusCode).toBe(401);
  });

  it('reactivation needs a fresh sign-in: sessions ended by the suspension stay ended', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    await changed(dark, admin, customer.id, SUSPEND);
    await changed(dark, admin, customer.id, REACTIVATE);
    expect((await me(customer)).statusCode).toBe(401);
    const fresh = await login(customer.email);
    expect(fresh.statusCode).toBe(200);
    const session = { cookies: cookiesOf(fresh) };
    expect((await me(session)).json()).toMatchObject({ id: customer.id, email: customer.email, role: 'user' });
  });

  it("an API server whose clock runs behind the database's cannot revive an ended session", async () => {
    // Sessions are ended at the DATABASE's "now". Judged by the server's own
    // clock, a server running behind would still see them as live -- and an
    // immediate reactivation would bring them back. Found by a stress run
    // (the database here runs ~1 ms ahead of Node); exaggerated to 10 minutes.
    const customer = await account();
    const admin = await account(['administrator']);
    await changed(dark, admin, customer.id, SUSPEND);
    await changed(dark, admin, customer.id, REACTIVATE);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() - 10 * 60 * 1000);
      expect((await me(customer)).statusCode).toBe(401);
      // A session that really is live is still judged live.
      expect((await me(admin)).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Atomicity
 * ------------------------------------------------------------------ */

describe('a change and its audit record commit together', () => {
  it('if the audit record cannot be written, nothing changes: not the status, not the sessions', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    await q(
      `CREATE TRIGGER test_refuse_audit_insert BEFORE INSERT ON audit_log
         FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation()`,
    );
    try {
      expect((await change(dark, admin, customer.id, SUSPEND)).statusCode).toBe(500);
    } finally {
      await q('DROP TRIGGER test_refuse_audit_insert ON audit_log');
    }
    expect(await statusOf(customer.id)).toBe('active');
    expect((await me(customer)).statusCode).toBe(200);
    expect(await auditCount()).toBe(0);

    // Nothing was half-done: the same change now applies, once, with its record.
    expect((await changed(dark, admin, customer.id, SUSPEND)).revokedSessions).toBe(1);
    expect(await statusAudits()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Nothing commercial
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

describe('the account status is not commercial', () => {
  it('suspending and reactivating change no wallet, ledger, subscription, entitlement or any other table -- only the account row, its sessions and the audit log', async () => {
    const customer = await account();
    const admin = await account(['administrator']);
    await q("INSERT INTO subscriptions (user_id, plan_version_id, status, current_period_end) VALUES ($1, $2, 'active', now() + interval '30 days')", [
      customer.id,
      await publishedPlan('premium_monthly'),
    ]);
    const credit = await live.app.inject({
      method: 'POST',
      url: `/admin/users/${customer.id}/wallets/credits/adjustments`,
      cookies: admin.cookies,
      payload: { direction: 'credit', amount: 40, reason: 'Goodwill', idempotencyKey: randomUUID() },
    });
    expect(credit.statusCode, credit.body).toBe(200);

    const OWN = new Set(['users', 'sessions', 'audit_log']);
    const snapshot = async () => {
      const tables = (
        await q<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)
      ).rows.map((r) => r.t);
      const out: Record<string, string> = {};
      for (const t of tables.filter((name) => !OWN.has(name))) {
        out[t] = (await q<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0]!.h;
      }
      // The account row: everything but its status and updatedAt.
      out.users = JSON.stringify((await q('SELECT id, email, password_hash, role, created_at FROM users ORDER BY id')).rows);
      return out;
    };
    const safeUser = { id: customer.id, email: customer.email, role: 'user' as const };
    const commercial = await readCustomerCommercialState(dark.db, safeUser);
    expect(commercial.tier).toEqual({ available: true, value: 'premium' });
    const before = await snapshot();

    await changed(dark, admin, customer.id, SUSPEND);
    expect(await snapshot()).toEqual(before);
    expect(await readCustomerCommercialState(dark.db, safeUser)).toEqual(commercial);
    // Support can still see the wallet of a suspended customer.
    const wallets = await dark.app.inject({ method: 'GET', url: `/admin/users/${customer.id}/wallets`, cookies: admin.cookies });
    expect(wallets.statusCode).toBe(200);

    await changed(dark, admin, customer.id, REACTIVATE);
    expect(await snapshot()).toEqual(before);
    expect(await readCustomerCommercialState(dark.db, safeUser)).toEqual(commercial);
  });
});

/* ------------------------------------------------------------------ *
 * Source guards
 * ------------------------------------------------------------------ */

describe('one writer', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
      return name.endsWith('.ts') ? [path] : [];
    });

  it('only services/account-status-service.ts writes the users table in application code', () => {
    const writers = sourceFiles(src)
      .filter((path) => /\.update\(\s*users\s*\)|\bupdate\s+"?users"?\s+set\b/i.test(readFileSync(path, 'utf8')))
      .map((path) => relative(src, path).split(sep).join('/'));
    expect(writers).toEqual(['services/account-status-service.ts']);
  });

  it('the status service reaches only the users, sessions and audit log -- nothing commercial', () => {
    const source = readFileSync(join(src, 'services/account-status-service.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../db/client.js', '../db/schema.js', './audit-service.js', '@over18/shared', 'drizzle-orm']);
    expect(source).toMatch(/import \{ sessions, users \} from '\.\.\/db\/schema\.js'/);
  });
});
