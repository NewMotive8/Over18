import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  ADMIN_ROLE_PERMISSIONS,
  ADMIN_ROLES,
  type AdminUserDetail,
  type AdminUserSubscription,
  type CustomerCommercialState,
} from '@over18/shared';
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
 * PRD v1.2 P3.5 -- an administrator manages one user's subscription from
 * Admin -> Users: GET / POST /admin/users/:userId/subscription.
 *
 * The change is made by the canonical subscription service in the P3.1
 * states, recorded in the append-only subscription history, and audited; the
 * customer's commercial state is then resolved exactly as before. Plans come
 * from the P1 catalogue.
 *
 * `dark` is the production default (economy off, enforcement off); `live` has
 * the economy on; `enforced` has the economy on and permission enforcement on.
 * Every plan, price and Credit figure is test data.
 */

let dark: TestContext;
let live: TestContext;
let enforced: TestContext;
let seq = 0;
const PASSWORD = 'plans-pass-1';
const ACTOR = '00000000-0000-4000-8000-000000000001';

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
  const email = `p35-${process.pid}-${++seq}@example.com`;
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

/* ---- the P1 catalogue, as fixtures ---- */

async function planVersion(code: string, version: number, over: { months?: number; purchasable?: boolean } = {}): Promise<string> {
  const existing = await q<{ id: string }>('SELECT id FROM economy_plans WHERE code = $1', [code]);
  const planId = existing.rows[0]?.id ?? (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
  return (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions
         (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, is_purchasable)
       VALUES ($1, $2, $3, $4, 1111, 'USD', 11, $5) RETURNING id`,
      [planId, version, `Fixture ${code}`, over.months ?? 1, over.purchasable ?? true],
    )
  ).rows[0]!.id;
}
const publish = (id: string, effectiveFrom: Date | null = null) =>
  q(`UPDATE economy_plan_versions SET status = 'published', effective_from = $2, published_by = $3, publish_reason = 'test' WHERE id = $1`, [id, effectiveFrom, ACTOR]);
async function publishedPlan(code: string, version = 1, over: { months?: number; purchasable?: boolean } = {}): Promise<string> {
  const id = await planVersion(code, version, over);
  await publish(id);
  return id;
}
/** Premium Monthly and Annual, and a retired plan that must never be given out. */
async function catalogue() {
  return {
    monthly: await publishedPlan('premium_monthly', 1, { months: 1 }),
    annual: await publishedPlan('premium_annual', 1, { months: 12 }),
    retired: await publishedPlan('legacy_plan', 1, { purchasable: false }),
  };
}

/* ---- the endpoints ---- */

const URL_OF = (userId: string) => `/admin/users/${userId}/subscription`;
const view = async (ctx: TestContext, who: Account, userId: string) => {
  const res = await ctx.app.inject({ method: 'GET', url: URL_OF(userId), cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminUserSubscription;
};
const post = (ctx: TestContext, who: Account | null, userId: string, payload: unknown) =>
  ctx.app.inject({ method: 'POST', url: URL_OF(userId), ...(who ? { cookies: who.cookies } : {}), payload: payload as object });
const changed = async (ctx: TestContext, who: Account, userId: string, payload: unknown) => {
  const res = await post(ctx, who, userId, payload);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AdminUserSubscription;
};
const assign = (planCode: string, expectedVersion = 0, over: Record<string, unknown> = {}) => ({
  action: 'assign',
  planCode,
  expectedVersion,
  reason: 'Complimentary Premium for a service outage',
  ...over,
});
const commercialOf = async (who: Account) => {
  const res = await live.app.inject({ method: 'GET', url: '/api/me/commercial-state', cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CustomerCommercialState;
};

const subscriptionRow = async (userId: string) =>
  (await q('SELECT plan_version_id, status, current_period_end::text AS end, updated_at::text AS updated FROM subscriptions WHERE user_id = $1', [userId])).rows[0];
const historyCount = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM subscription_history')).rows[0]!.n;
const auditRows = async () =>
  (
    await q<{ actor_user_id: string; actor_email: string; action: string; object_type: string; object_id: string; before: unknown; after: unknown; reason: string; request_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_user_id, actor_email, action, object_type, object_id, before, after, reason, request_id, metadata FROM audit_log WHERE object_type = 'subscription' ORDER BY id`,
    )
  ).rows;
const auditCount = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM audit_log')).rows[0]!.n;

/* ------------------------------------------------------------------ *
 * Access
 * ------------------------------------------------------------------ */

describe('who may see and change a subscription', () => {
  it('refuses an anonymous caller (401) and a customer (403), and records nothing', async () => {
    await catalogue();
    const target = await account();
    const customer = await account();
    expect((await live.app.inject({ method: 'GET', url: URL_OF(target.id) })).statusCode).toBe(401);
    expect((await live.app.inject({ method: 'GET', url: URL_OF(target.id), cookies: customer.cookies })).statusCode).toBe(403);
    expect((await post(live, null, target.id, assign('premium_monthly'))).statusCode).toBe(401);
    expect((await post(live, customer, target.id, assign('premium_monthly'))).statusCode).toBe(403);
    expect(await subscriptionRow(target.id)).toBeUndefined();
    expect(await historyCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('with enforcement on: reading needs users.commercial.read; changing needs users.subscription.manage, held by the administrator alone', async () => {
    expect(ADMIN_ROLES.filter((role) => ADMIN_ROLE_PERMISSIONS[role].includes('users.subscription.manage'))).toEqual(['administrator']);
    await catalogue();
    const target = await account();

    const support = await account(['support']);
    expect((await view(enforced, support, target.id)).change).toEqual({ allowed: false, reason: 'permission_required' });
    const economyEditor = await account(['economy_editor']);
    const refusedRead = await enforced.app.inject({ method: 'GET', url: URL_OF(target.id), cookies: economyEditor.cookies });
    expect(refusedRead.statusCode).toBe(403);
    expect(refusedRead.json()).toMatchObject({ permission: 'users.commercial.read' });

    for (const role of ADMIN_ROLES.filter((r) => r !== 'administrator')) {
      const res = await post(enforced, await account([role]), target.id, assign('premium_monthly'));
      expect(res.statusCode, role).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden', permission: 'users.subscription.manage' });
    }
    expect(await subscriptionRow(target.id)).toBeUndefined();
    expect(await historyCount()).toBe(0);
    expect(await auditCount()).toBe(0);

    const administrator = await account(['administrator']);
    expect((await view(enforced, administrator, target.id)).change).toEqual({ allowed: true });
    expect((await changed(enforced, administrator, target.id, assign('premium_monthly'))).current).toMatchObject({ status: 'active', premium: true });
  });

  it('with enforcement off -- the production default -- any staff member may, as on every admin route', async () => {
    await catalogue();
    const target = await account();
    const staff = await account([]);
    expect((await changed(live, staff, target.id, assign('premium_monthly'))).version).toBe(1);
  });

  it('while the economy is off: reading works and says so; a change is refused (503) before anything is written', async () => {
    await catalogue();
    const target = await account();
    const staff = await account([]);
    const seen = await view(dark, staff, target.id);
    expect(seen).toMatchObject({ economyEnabled: false, current: null, change: { allowed: false, reason: 'economy_disabled' } });
    const res = await post(dark, staff, target.id, assign('premium_monthly'));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'economy_unavailable' });
    expect(await subscriptionRow(target.id)).toBeUndefined();
    expect(await historyCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it("nobody changes their own subscription; another operator may change a staff member's or a suspended customer's", async () => {
    await catalogue();
    const admin = await account(['administrator']);
    expect((await view(live, admin, admin.id)).change).toEqual({ allowed: false, reason: 'own_account' });
    const own = await post(live, admin, admin.id, assign('premium_monthly'));
    expect(own.statusCode).toBe(409);
    expect(own.json()).toMatchObject({ error: 'own_account' });
    const upper = await post(live, admin, admin.id.toUpperCase(), assign('premium_monthly'));
    expect(upper.statusCode).toBe(409);
    expect(await historyCount()).toBe(0);

    const colleague = await account(['support']);
    expect((await changed(live, admin, colleague.id, assign('premium_monthly'))).current).toMatchObject({ premium: true });

    const customer = await account();
    const suspended = await dark.app.inject({
      method: 'POST',
      url: `/admin/users/${customer.id}/status`,
      cookies: admin.cookies,
      payload: { status: 'suspended', expectedStatus: 'active', reason: 'Chargeback fraud' },
    });
    expect(suspended.statusCode).toBe(200);
    expect((await changed(live, admin, customer.id, assign('premium_monthly'))).current).toMatchObject({ premium: true });
    expect((await q<{ status: string }>('SELECT status FROM users WHERE id = $1', [customer.id])).rows[0]!.status).toBe('suspended');
  });
});

/* ------------------------------------------------------------------ *
 * The lifecycle
 * ------------------------------------------------------------------ */

describe('changing a subscription, in the P3.1 states', () => {
  it('assign: active on the plan in effect, for one billing period of that plan from now -- recorded, audited, and resolved as the customer is told', async () => {
    const plans = await catalogue();
    const customer = await account();
    const admin = await account(['administrator']);

    const before = await view(live, admin, customer.id);
    expect(before).toMatchObject({ version: 0, current: null, history: [], actions: ['assign'] });
    expect(before.plans.map((p) => p.code)).toEqual(['premium_annual', 'premium_monthly']); // the retired plan is never offered
    expect(before.plans.find((p) => p.code === 'premium_annual')).toMatchObject({ versionId: plans.annual, billingPeriodMonths: 12 });

    const after = await changed(live, admin, customer.id, assign('premium_monthly', 0, { reason: '  Outage goodwill  ', reference: 'T-100' }));
    expect(after).toMatchObject({
      version: 1,
      actions: ['change_plan', 'cancel', 'end'],
      current: { plan: { code: 'premium_monthly', version: 1, versionId: plans.monthly, live: true }, status: 'active', storedStatus: 'active', premium: true },
    });
    // One billing period of the plan (1 month), from the moment of the change, on the database clock.
    expect((await q<{ exact: boolean }>(`SELECT current_period_end = created_at + interval '1 month' AS exact FROM subscriptions WHERE user_id = $1`, [customer.id])).rows[0]!.exact).toBe(true);

    // Resolved by the P3.1 resolver, as the customer is told.
    const state = await commercialOf(customer);
    expect(state.tier).toEqual({ available: true, value: 'premium' });
    expect(state.subscription).toEqual({
      available: true,
      value: { status: 'active', planCode: 'premium_monthly', currentPeriodEnd: after.current!.currentPeriodEnd, cancelAtPeriodEnd: false },
    });

    // The history: who, when, why, from nothing to the plan.
    expect(after.history).toEqual([
      {
        sequence: 1,
        change: 'assign',
        source: 'admin',
        effectiveAt: expect.any(String),
        from: null,
        to: { planCode: 'premium_monthly', planVersion: 1, status: 'active', currentPeriodEnd: after.current!.currentPeriodEnd },
        actorUserId: admin.id,
        actorEmail: admin.email,
        reason: 'Outage goodwill',
        reference: 'T-100',
      },
    ]);

    // The audit record, with the previous and new state.
    const audits = await auditRows();
    expect(audits).toEqual([
      {
        actor_user_id: admin.id,
        actor_email: admin.email,
        action: 'subscription.assign',
        object_type: 'subscription',
        object_id: customer.id,
        before: null,
        after: expect.objectContaining({ planCode: 'premium_monthly', planVersion: 1, planVersionId: plans.monthly, status: 'active', premium: true }),
        reason: 'Outage goodwill',
        request_id: expect.any(String),
        metadata: { source: 'admin', historySequence: 1, effectiveAt: after.history[0]!.effectiveAt, reference: 'T-100' },
      },
    ]);
    expect(await auditCount()).toBe(1);
  });

  it('change_plan: the new plan now, with status and period end kept -- and the earlier history untouched', async () => {
    const plans = await catalogue();
    const customer = await account();
    const admin = await account(['administrator']);
    const assigned = await changed(live, admin, customer.id, assign('premium_monthly'));
    const periodEnd = assigned.current!.currentPeriodEnd;

    const moved = await changed(live, admin, customer.id, { action: 'change_plan', planCode: 'premium_annual', expectedVersion: 1, reason: 'Upgrade agreed with the customer' });
    expect(moved.current).toMatchObject({ plan: { code: 'premium_annual', versionId: plans.annual }, status: 'active', currentPeriodEnd: periodEnd, premium: true });
    expect(moved.history.map((h) => h.change)).toEqual(['change_plan', 'assign']);
    expect(moved.history[0]).toMatchObject({
      sequence: 2,
      from: { planCode: 'premium_monthly', planVersion: 1, status: 'active', currentPeriodEnd: periodEnd },
      to: { planCode: 'premium_annual', planVersion: 1, status: 'active', currentPeriodEnd: periodEnd },
    });
    expect(moved.history[1]).toEqual(assigned.history[0]);
    expect((await commercialOf(customer)).subscription).toMatchObject({ value: { planCode: 'premium_annual', status: 'active' } });

    const [, audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'subscription.change_plan',
      before: { planCode: 'premium_monthly', status: 'active' },
      after: { planCode: 'premium_annual', status: 'active' },
      reason: 'Upgrade agreed with the customer',
    });
  });

  it('cancel keeps Premium to the period end (P3.1); end expires it now; a new assign starts again -- every state kept in order', async () => {
    await catalogue();
    const customer = await account();
    const admin = await account(['administrator']);
    const assigned = await changed(live, admin, customer.id, assign('premium_monthly'));

    const cancelled = await changed(live, admin, customer.id, { action: 'cancel', expectedVersion: 1, reason: 'Customer asked to cancel' });
    expect(cancelled.current).toMatchObject({ status: 'cancelled', storedStatus: 'cancelled', premium: true, currentPeriodEnd: assigned.current!.currentPeriodEnd });
    expect(cancelled.actions).toEqual(['change_plan', 'end']);
    expect(await commercialOf(customer)).toMatchObject({ tier: { value: 'premium' }, subscription: { value: { status: 'cancelled', cancelAtPeriodEnd: true } } });

    const ended = await changed(live, admin, customer.id, { action: 'end', expectedVersion: 2, reason: 'Refunded in full', reference: 'R-9' });
    expect(ended.current).toMatchObject({ status: 'expired', storedStatus: 'expired', premium: false });
    expect(ended.actions).toEqual(['assign']);
    expect((await q<{ ended: boolean }>('SELECT current_period_end <= now() AS ended FROM subscriptions WHERE user_id = $1', [customer.id])).rows[0]!.ended).toBe(true);
    expect(await commercialOf(customer)).toMatchObject({ tier: { value: 'free' }, subscription: { value: { status: 'expired', planCode: 'premium_monthly' } } });

    const again = await changed(live, admin, customer.id, assign('premium_annual', 3));
    expect(again.current).toMatchObject({ plan: { code: 'premium_annual' }, status: 'active', premium: true });
    expect((await q<{ exact: boolean }>(`SELECT current_period_end = updated_at + interval '12 months' AS exact FROM subscriptions WHERE user_id = $1`, [customer.id])).rows[0]!.exact).toBe(true);

    // Four changes, newest first, each starting where the one before ended.
    expect(again.history.map((h) => [h.sequence, h.change])).toEqual([[4, 'assign'], [3, 'end'], [2, 'cancel'], [1, 'assign']]);
    const chronological = [...again.history].reverse();
    for (let i = 1; i < chronological.length; i++) expect(chronological[i]!.from).toEqual(chronological[i - 1]!.to);
    expect(chronological[0]!.from).toBeNull();
    expect((await auditRows()).map((a) => a.action)).toEqual(['subscription.assign', 'subscription.cancel', 'subscription.end', 'subscription.assign']);
  });

  it('the history cannot be rewritten or removed', async () => {
    await catalogue();
    const customer = await account();
    await changed(live, await account(['administrator']), customer.id, assign('premium_monthly'));
    await expect(q("UPDATE subscription_history SET reason = 'rewritten'")).rejects.toThrow(/append-only/);
    await expect(q('DELETE FROM subscription_history')).rejects.toThrow(/append-only/);
    expect(await historyCount()).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

describe('a refused change writes nothing', () => {
  async function unchanged(userId: string, check: () => Promise<void>) {
    const before = { row: await subscriptionRow(userId), history: await historyCount(), audit: await auditCount() };
    await check();
    expect({ row: await subscriptionRow(userId), history: await historyCount(), audit: await auditCount() }).toEqual(before);
  }

  it('refuses a malformed request (400), an unknown user (404) and a malformed User ID (400)', async () => {
    await catalogue();
    const customer = await account();
    const admin = await account(['administrator']);
    const bodies: unknown[] = [
      {},
      [assign('premium_monthly')],
      { ...assign('premium_monthly'), action: 'renew' },
      { ...assign('premium_monthly'), planCode: undefined },
      { ...assign('premium_monthly'), planCode: 'Premium Monthly' },
      { action: 'cancel', planCode: 'premium_monthly', expectedVersion: 0, reason: 'x' },
      { ...assign('premium_monthly'), expectedVersion: undefined },
      { ...assign('premium_monthly'), expectedVersion: -1 },
      { ...assign('premium_monthly'), expectedVersion: 1.5 },
      { ...assign('premium_monthly'), reason: '   ' },
      { ...assign('premium_monthly'), reason: 'x'.repeat(501) },
      { ...assign('premium_monthly'), reference: 'x'.repeat(101) },
      { ...assign('premium_monthly'), status: 'active' },
      { ...assign('premium_monthly'), currentPeriodEnd: '2099-01-01T00:00:00Z' },
    ];
    await unchanged(customer.id, async () => {
      for (const body of bodies) {
        const res = await post(live, admin, customer.id, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid_request' });
      }
      expect((await post(live, admin, 'not-a-user-id', assign('premium_monthly'))).statusCode).toBe(400);
      const unknown = await post(live, admin, randomUUID(), assign('premium_monthly'));
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: 'user_not_found' });
      expect((await live.app.inject({ method: 'GET', url: URL_OF(randomUUID()), cookies: admin.cookies })).statusCode).toBe(404);
    });
  });

  it('refuses a plan the catalogue does not offer now: unknown (400), retired, not yet in effect, never published (409)', async () => {
    await catalogue();
    await publish(await planVersion('future_plan', 1), new Date(Date.now() + 7 * 86_400_000));
    await planVersion('draft_plan', 1);
    const customer = await account();
    const admin = await account(['administrator']);
    await unchanged(customer.id, async () => {
      const unknown = await post(live, admin, customer.id, assign('no_such_plan'));
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toMatchObject({ error: 'unknown_plan' });
      for (const code of ['legacy_plan', 'future_plan', 'draft_plan']) {
        const res = await post(live, admin, customer.id, assign(code));
        expect(res.statusCode, code).toBe(409);
        expect(res.json()).toMatchObject({ error: 'plan_unavailable' });
      }
    });
  });

  it('refuses a change the current state does not allow (409), and a move to the plan already held', async () => {
    await catalogue();
    const customer = await account();
    const admin = await account(['administrator']);
    await unchanged(customer.id, async () => {
      for (const action of ['cancel', 'end']) {
        const res = await post(live, admin, customer.id, { action, expectedVersion: 0, reason: 'x' });
        expect(res.statusCode, action).toBe(409);
        expect(res.json()).toMatchObject({ error: 'invalid_transition' });
      }
      const change = await post(live, admin, customer.id, { action: 'change_plan', planCode: 'premium_annual', expectedVersion: 0, reason: 'x' });
      expect(change.json()).toMatchObject({ error: 'invalid_transition' });
    });

    await changed(live, admin, customer.id, assign('premium_monthly'));
    await unchanged(customer.id, async () => {
      expect((await post(live, admin, customer.id, assign('premium_annual', 1))).json()).toMatchObject({ error: 'invalid_transition' });
      const same = await post(live, admin, customer.id, { action: 'change_plan', planCode: 'premium_monthly', expectedVersion: 1, reason: 'x' });
      expect(same.statusCode).toBe(409);
      expect(same.json()).toMatchObject({ error: 'same_plan' });
    });

    await changed(live, admin, customer.id, { action: 'cancel', expectedVersion: 1, reason: 'x' });
    await unchanged(customer.id, async () => {
      expect((await post(live, admin, customer.id, { action: 'cancel', expectedVersion: 2, reason: 'x' })).json()).toMatchObject({ error: 'invalid_transition' });
    });
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency and atomicity
 * ------------------------------------------------------------------ */

describe('stale and concurrent changes', () => {
  it('a change made against a version that is no longer current is refused (409), with the current version', async () => {
    await catalogue();
    const customer = await account();
    const admin = await account(['administrator']);
    await changed(live, admin, customer.id, assign('premium_monthly'));
    const row = await subscriptionRow(customer.id);
    const stale = await post(live, await account(['administrator']), customer.id, { action: 'cancel', expectedVersion: 0, reason: 'Seen before the assign' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'subscription_conflict', currentVersion: 1 });
    expect(await subscriptionRow(customer.id)).toEqual(row);
    expect(await historyCount()).toBe(1);
    expect((await auditRows()).length).toBe(1);
  });

  it('the same change from several operators at once applies exactly once, with one history row and one audit record', async () => {
    await catalogue();
    const customer = await account();
    const operators = [await account(['administrator']), await account(['administrator']), await account(['administrator'])];
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => post(live, operators[i % 3]!, customer.id, assign(i % 2 ? 'premium_annual' : 'premium_monthly'))));
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    for (const r of responses.filter((x) => x.statusCode === 409)) expect(r.json()).toMatchObject({ error: 'subscription_conflict', currentVersion: 1 });
    expect(await historyCount()).toBe(1);
    expect((await auditRows()).length).toBe(1);
  });

  it('if the audit record cannot be written, nothing changes: no subscription, no history', async () => {
    await catalogue();
    const customer = await account();
    const admin = await account(['administrator']);
    await q(`CREATE TRIGGER test_refuse_audit_insert BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation()`);
    try {
      expect((await post(live, admin, customer.id, assign('premium_monthly'))).statusCode).toBe(500);
    } finally {
      await q('DROP TRIGGER test_refuse_audit_insert ON audit_log');
    }
    expect(await subscriptionRow(customer.id)).toBeUndefined();
    expect(await historyCount()).toBe(0);
    // Nothing half-done: the same change now applies, once.
    expect((await changed(live, admin, customer.id, assign('premium_monthly'))).version).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Nothing else changes
 * ------------------------------------------------------------------ */

describe('a subscription change touches only the subscription, its history and the audit log', () => {
  it('no wallet, ledger, plan definition or any other table changes', async () => {
    await catalogue();
    const customer = await account();
    const admin = await account(['administrator']);
    const credit = await live.app.inject({
      method: 'POST',
      url: `/admin/users/${customer.id}/wallets/credits/adjustments`,
      cookies: admin.cookies,
      payload: { direction: 'credit', amount: 40, reason: 'Goodwill', idempotencyKey: randomUUID() },
    });
    expect(credit.statusCode, credit.body).toBe(200);

    const OWN = new Set(['subscriptions', 'subscription_history', 'audit_log']);
    const snapshot = async () => {
      const tables = (await q<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
      const out: Record<string, string> = {};
      for (const t of tables.filter((name) => !OWN.has(name))) {
        out[t] = (await q<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0]!.h;
      }
      return out;
    };
    const before = await snapshot();
    const wallet = (await commercialOf(customer)).wallet;

    await changed(live, admin, customer.id, assign('premium_monthly'));
    await changed(live, admin, customer.id, { action: 'change_plan', planCode: 'premium_annual', expectedVersion: 1, reason: 'x' });
    await changed(live, admin, customer.id, { action: 'cancel', expectedVersion: 2, reason: 'x' });
    await changed(live, admin, customer.id, { action: 'end', expectedVersion: 3, reason: 'x' });

    expect(await snapshot()).toEqual(before);
    expect((await commercialOf(customer)).wallet).toEqual(wallet);
  });
});

/* ------------------------------------------------------------------ *
 * The User Detail
 * ------------------------------------------------------------------ */

describe('the User Detail after a change', () => {
  it('shows the resolved commercial state and the audited change at once', async () => {
    await catalogue();
    const customer = await account();
    const admin = await account(['administrator']);
    await changed(live, admin, customer.id, assign('premium_monthly', 0, { reason: 'Outage goodwill' }));
    const res = await live.app.inject({ method: 'GET', url: `/admin/users/${customer.id}`, cookies: admin.cookies });
    const detail = res.json() as AdminUserDetail;
    expect(detail.commercial).toMatchObject({ tier: { available: true, value: 'premium' }, subscription: { available: true, value: { planCode: 'premium_monthly', status: 'active' } } });
    const entries = detail.audit.available ? detail.audit.entries : [];
    expect(entries.map((e) => [e.action, e.actorEmail, e.reason])).toContainEqual(['subscription.assign', admin.email, 'Outage goodwill']);
  });
});
