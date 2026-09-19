import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CustomerCommercialState, SubscriptionStatus } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { holdCredits } from '../services/wallet-service.js';
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
 * PRD v1.2 P3.1 -- subscription state, and GET /api/me/commercial-state.
 *
 * `off` is the production default (ECONOMY_ENABLED off); `on` has the economy
 * switched on. Subscriptions are written straight to the table -- nothing in
 * the application writes one yet (P9) -- and every plan, price and Credit
 * figure is a TEST FIXTURE, not a business value.
 */

let off: TestContext;
let on: TestContext;
let seq = 0;

beforeAll(async () => {
  migrateTestDb();
  off = await createTestContext();
  const { db, pool } = createDb(TEST_DATABASE_URL);
  const app = await buildApp({ ...testEnv, commerce: { ...testEnv.commerce, enabled: true } }, db);
  on = { app, db, pool };
});
afterAll(async () => {
  await destroyTestContext(off);
  await destroyTestContext(on);
});
beforeEach(async () => truncateAll(off));

const q = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  off.pool.query<T>(text, params);

type Cookies = Record<string, string>;
async function signIn(role: 'user' | 'admin' = 'user'): Promise<{ id: string; cookies: Cookies }> {
  const email = `subscriber-${process.pid}-${++seq}@example.com`;
  const res = await off.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'subscriber-pass-1' } });
  expect(res.statusCode).toBe(201);
  const cookie = extractSessionCookie(res)!;
  const [row] = await off.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (role === 'admin') await off.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
  return { id: row!.id, cookies: { [cookie.name]: cookie.value } };
}

const STATE = '/api/me/commercial-state';
async function stateOf(cookies: Cookies, ctx = on): Promise<CustomerCommercialState> {
  const res = await ctx.app.inject({ method: 'GET', url: STATE, cookies });
  expect(res.statusCode).toBe(200);
  return res.json() as CustomerCommercialState;
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ACTOR = '00000000-0000-4000-8000-000000000001';

/** A plan version, as a draft. */
async function planVersion(code: string, version: number, over: { price?: number; purchasable?: boolean } = {}): Promise<string> {
  const existing = await q<{ id: string }>('SELECT id FROM economy_plans WHERE code = $1', [code]);
  const planId =
    existing.rows[0]?.id ?? (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
  return (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions
         (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, is_purchasable)
       VALUES ($1, $2, 'Fixture plan', 1, $3, 'USD', 11, $4) RETURNING id`,
      [planId, version, over.price ?? 1111, over.purchasable ?? true],
    )
  ).rows[0]!.id;
}

const publish = (id: string, effectiveFrom: Date | null = null) =>
  q(`UPDATE economy_plan_versions SET status = 'published', effective_from = $2, published_by = $3, publish_reason = 'test' WHERE id = $1`, [
    id,
    effectiveFrom,
    ACTOR,
  ]);

async function publishedPlan(code = 'premium_monthly', version = 1, over: { price?: number; purchasable?: boolean } = {}): Promise<string> {
  const id = await planVersion(code, version, over);
  await publish(id);
  return id;
}

/** The database clock, shifted: every period end is measured against it. */
const dbTime = async (interval: string) =>
  new Date((await q<{ t: Date }>(`SELECT clock_timestamp() + interval '${interval}' AS t`)).rows[0]!.t);

async function subscribe(userId: string, planVersionId: string, status: SubscriptionStatus, currentPeriodEnd: Date) {
  await q('INSERT INTO subscriptions (user_id, plan_version_id, status, current_period_end) VALUES ($1, $2, $3, $4)', [
    userId,
    planVersionId,
    status,
    currentPeriodEnd,
  ]);
}

/** Raw P2.1 ledger rows: granting is not a P3.1 operation. */
async function fund(userId: string, amount: number, creditClass: 'included' | 'earned' | 'purchased') {
  await q("INSERT INTO wallets (user_id, currency) VALUES ($1, 'credits') ON CONFLICT DO NOTHING", [userId]);
  await q(
    `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
     VALUES ($1, 'credits', 'grant', 'credit', $2, $3, $4)`,
    [userId, amount, creditClass, `fixture:${randomUUID()}`],
  );
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

describe('the subscriptions table', () => {
  it('holds one subscription per user, in a known state, on an existing plan version', async () => {
    const { id } = await signIn();
    const version = await publishedPlan();
    const end = await dbTime('30 days');
    await subscribe(id, version, 'active', end);
    await expect(subscribe(id, version, 'active', end)).rejects.toThrow(/subscriptions_pkey/);
    const other = (await signIn()).id;
    await expect(subscribe(other, version, 'trialing' as SubscriptionStatus, end)).rejects.toThrow(/invalid input value for enum subscription_status/);
    await expect(subscribe(other, randomUUID(), 'active', end)).rejects.toThrow(/subscriptions_plan_version_id_economy_plan_versions_id_fk/);
    await expect(subscribe(randomUUID(), version, 'active', end)).rejects.toThrow(/subscriptions_user_id_users_id_fk/);
  });

  it('stores a reference to the plan and nothing copied from it -- no price, Credits or benefit', async () => {
    const columns = (
      await q<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'subscriptions' ORDER BY ordinal_position",
      )
    ).rows.map((r) => r.column_name);
    expect(columns).toEqual(['user_id', 'plan_version_id', 'status', 'current_period_end', 'created_at', 'updated_at']);
  });
});

/* ------------------------------------------------------------------ *
 * Resolving the subscription
 * ------------------------------------------------------------------ */

describe('GET /api/me/commercial-state resolves the subscription', () => {
  it('no subscription: Free, with no plan -- not a "Free subscription"', async () => {
    const { cookies } = await signIn();
    const state = await stateOf(cookies);
    expect(state.tier).toEqual({ available: true, value: 'free' });
    expect(state.subscription).toEqual({ available: true, value: null });
  });

  it('active, past_due and grace keep Premium, and name the plan by its P1 code', async () => {
    const version = await publishedPlan('premium_monthly');
    const end = await dbTime('30 days');
    for (const status of ['active', 'past_due', 'grace'] as const) {
      const { id, cookies } = await signIn();
      await subscribe(id, version, status, end);
      const state = await stateOf(cookies);
      expect(state.tier, status).toEqual({ available: true, value: 'premium' });
      expect(state.subscription, status).toEqual({
        available: true,
        value: { status, planCode: 'premium_monthly', currentPeriodEnd: end.toISOString(), cancelAtPeriodEnd: false },
      });
    }
  });

  it('cancelled keeps Premium until its period ends, then reads as expired', async () => {
    const version = await publishedPlan('premium_monthly');
    const scheduled = await signIn();
    const future = await dbTime('3 days');
    await subscribe(scheduled.id, version, 'cancelled', future);
    expect(await stateOf(scheduled.cookies)).toMatchObject({
      tier: { available: true, value: 'premium' },
      subscription: { available: true, value: { status: 'cancelled', planCode: 'premium_monthly', cancelAtPeriodEnd: true } },
    });

    const ended = await signIn();
    const past = await dbTime('-1 second');
    await subscribe(ended.id, version, 'cancelled', past);
    expect(await stateOf(ended.cookies)).toMatchObject({
      tier: { available: true, value: 'free' },
      subscription: {
        available: true,
        value: { status: 'expired', planCode: 'premium_monthly', currentPeriodEnd: past.toISOString(), cancelAtPeriodEnd: false },
      },
    });
  });

  it('expired is Free, and still names the plan it was', async () => {
    const version = await publishedPlan('premium_annual');
    const { id, cookies } = await signIn();
    await subscribe(id, version, 'expired', await dbTime('-10 days'));
    expect(await stateOf(cookies)).toMatchObject({
      tier: { available: true, value: 'free' },
      subscription: { available: true, value: { status: 'expired', planCode: 'premium_annual', cancelAtPeriodEnd: false } },
    });
  });

  it('derives no other transition from dates: the recorded state stands until the billing lifecycle changes it', async () => {
    const version = await publishedPlan();
    for (const status of ['active', 'past_due', 'grace'] as const) {
      const { id, cookies } = await signIn();
      await subscribe(id, version, status, await dbTime('-2 days'));
      expect(await stateOf(cookies), status).toMatchObject({
        tier: { available: true, value: 'premium' },
        subscription: { available: true, value: { status } },
      });
    }
  });

  it('holds on to the version bought: a new price, a new version or a retirement changes nothing for the subscriber', async () => {
    const bought = await publishedPlan('premium_monthly', 1, { price: 1111 });
    const { id, cookies } = await signIn();
    await subscribe(id, bought, 'active', await dbTime('30 days'));
    await publishedPlan('premium_monthly', 2, { price: 2222, purchasable: false });
    expect(await stateOf(cookies)).toMatchObject({
      tier: { available: true, value: 'premium' },
      subscription: { available: true, value: { status: 'active', planCode: 'premium_monthly' } },
    });

    const retired = await publishedPlan('legacy_plan', 1, { purchasable: false });
    const holder = await signIn();
    await subscribe(holder.id, retired, 'active', await dbTime('30 days'));
    expect(await stateOf(holder.cookies)).toMatchObject({
      tier: { available: true, value: 'premium' },
      subscription: { available: true, value: { planCode: 'legacy_plan' } },
    });
  });

  it('a plan version that is not published never gives Premium: the subscription is unresolvable', async () => {
    const draft = await planVersion('premium_monthly', 1);
    const cancelled = await planVersion('premium_annual', 1);
    await publish(cancelled, await dbTime('2 hours'));
    await q(`UPDATE economy_plan_versions SET status = 'cancelled', cancelled_by = $2, cancel_reason = 'test' WHERE id = $1`, [
      cancelled,
      ACTOR,
    ]);
    for (const version of [draft, cancelled]) {
      const { id, cookies } = await signIn();
      await subscribe(id, version, 'active', await dbTime('30 days'));
      const res = await on.app.inject({ method: 'GET', url: STATE, cookies });
      const state = res.json() as CustomerCommercialState;
      expect(state.tier).toEqual({ available: false, reason: 'subscription_unresolvable' });
      expect(state.subscription).toEqual({ available: false, reason: 'subscription_unresolvable' });
      expect(res.body).not.toMatch(/premium/);
      // The rest of the state is still answered.
      expect(state.wallet).toEqual({ available: true, value: { included: 0, earned: 0, purchased: 0, held: 0, spendable: 0 } });
    }
  });

  it('exposes the plan code only -- no plan version, subscription or user row id beyond the viewer', async () => {
    const version = await publishedPlan();
    const { id, cookies } = await signIn();
    await subscribe(id, version, 'active', await dbTime('30 days'));
    const body = (await on.app.inject({ method: 'GET', url: STATE, cookies })).body;
    expect(body).not.toContain(version);
    expect(body).not.toMatch(/planVersionId|plan_version_id|versionId/);
    expect(body.split(id)).toHaveLength(2); // the viewer, once
  });

  it("answers each customer with their own subscription and Credits, never another's", async () => {
    const version = await publishedPlan();
    const alice = await signIn();
    const bob = await signIn();
    await subscribe(alice.id, version, 'active', await dbTime('30 days'));
    await fund(alice.id, 40, 'purchased');
    expect(await stateOf(bob.cookies)).toMatchObject({
      tier: { available: true, value: 'free' },
      subscription: { available: true, value: null },
      wallet: { available: true, value: { spendable: 0 } },
    });
  });

  it('does not treat an administrator as Premium without a subscription', async () => {
    const admin = await signIn('admin');
    expect((await stateOf(admin.cookies)).tier).toEqual({ available: true, value: 'free' });
  });
});

/* ------------------------------------------------------------------ *
 * The wallet: read, never written
 * ------------------------------------------------------------------ */

describe('the commercial state reads the wallet and never writes it', () => {
  it('reports spendable Credits by class, with held Credits apart', async () => {
    const { id, cookies } = await signIn();
    await fund(id, 30, 'included');
    await fund(id, 20, 'earned');
    await fund(id, 10, 'purchased');
    await holdCredits(off.db, { userId: id, currency: 'credits', amount: 5, idempotencyKey: 'in-flight' });
    expect((await stateOf(cookies)).wallet).toEqual({
      available: true,
      value: { included: 25, earned: 20, purchased: 10, held: 5, spendable: 55 },
    });
  });

  it('reading moves nothing: no Credit is granted, consumed or held, and no row changes', async () => {
    const version = await publishedPlan();
    const { id, cookies } = await signIn();
    await subscribe(id, version, 'active', await dbTime('30 days'));
    await fund(id, 12, 'included');
    const snapshot = async () =>
      (
        await q<{ h: string }>(
          `SELECT md5(coalesce((SELECT string_agg(t::text, '|' ORDER BY user_id, currency) FROM wallets t), '') ||
                      coalesce((SELECT string_agg(t::text, '|' ORDER BY id) FROM wallet_transactions t), '') ||
                      coalesce((SELECT string_agg(t::text, '|' ORDER BY user_id) FROM subscriptions t), '') ||
                      coalesce((SELECT count(*)::text FROM audit_log), '')) AS h`,
        )
      ).rows[0]!.h;
    const before = await snapshot();
    for (let i = 0; i < 3; i++) await stateOf(cookies);
    expect(await snapshot()).toBe(before);
  });

  it('a wallet whose Credit classes do not reconcile is unavailable -- never a number that cannot be trusted', async () => {
    const { id, cookies } = await signIn();
    await fund(id, 10, 'purchased');
    // P2.1 checks totals only: a raw debit of a class the wallet does not hold leaves it negative.
    await q(
      `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
       VALUES ($1, 'credits', 'paid_action', 'debit', 4, 'included', 'fixture:bad-class')`,
      [id],
    );
    const state = await stateOf(cookies);
    expect(state.wallet).toEqual({ available: false, reason: 'wallet_unresolvable' });
    expect(state.tier).toEqual({ available: true, value: 'free' });
  });
});

/* ------------------------------------------------------------------ *
 * Dark by default
 * ------------------------------------------------------------------ */

describe('while the economy is off', () => {
  it('a subscribed customer with Credits still gets 503 economy_unavailable, and nothing about either', async () => {
    const version = await publishedPlan();
    const { id, cookies } = await signIn();
    await subscribe(id, version, 'active', await dbTime('30 days'));
    await fund(id, 40, 'included');
    const res = await off.app.inject({ method: 'GET', url: STATE, cookies });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'economy_unavailable', reason: 'economy_disabled', message: 'The economy is not available yet.' });
    expect(res.body).not.toMatch(/premium|premium_monthly|40/);
  });
});

/* ------------------------------------------------------------------ *
 * One source of truth
 * ------------------------------------------------------------------ */

describe('one place resolves a subscription', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
    });
  }
  const src = fileURLToPath(new URL('..', import.meta.url));
  const application = () => sourceFiles(src).map((path) => relative(src, path).split('\\').join('/'));

  it('only the schema and the subscription service name the subscriptions table -- or its history (P3.5)', () => {
    const TABLE =
      /import\s*\{[^}]*\b(subscriptions|subscriptionHistory)\b[^}]*\}\s*from\s*'[^']*db\/schema\.js'|\b(from|into|update|join)\s+"?(subscriptions|subscription_history)\b/i;
    const readers = application().filter((rel) => rel !== 'db/schema.ts' && TABLE.test(readFileSync(join(src, rel), 'utf8')));
    expect(readers).toEqual(['services/subscription-service.ts']);
  });

  it('only the customer commercial state asks it for Premium -- no second derivation of Premium', () => {
    const askers = application().filter(
      (rel) => rel !== 'services/subscription-service.ts' && /resolveSubscription/.test(readFileSync(join(src, rel), 'utf8')),
    );
    expect(askers).toEqual(['services/customer-economy.ts']);
  });

  it('only the customer commercial state and the admin subscription management (P3.5) use the subscription service', () => {
    const importers = application().filter(
      (rel) => rel !== 'services/subscription-service.ts' && /['/]subscription-service\.js'/.test(readFileSync(join(src, rel), 'utf8')),
    );
    expect(importers).toEqual(['routes/admin-users.ts', 'services/admin-subscription-service.ts', 'services/customer-economy.ts']);
  });
});
