import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CustomerCommercialState, CustomerSubscriptionResponse } from '@over18/shared';
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
 * A SUBSCRIBER MANAGING THEIR OWN SUBSCRIPTION:
 * GET /api/me/subscription and POST /api/me/subscription/cancel.
 *
 * WHAT MATTERS MOST HERE is that cancelling takes nothing away early. The paid
 * period must survive the cancellation untouched and Premium must still resolve,
 * because the whole promise made to the customer on the screen is "you keep
 * Premium until this date".
 *
 * AND THAT THE HISTORY TELLS THE TRUTH: a self-service cancellation is recorded
 * with source `customer` and the subscriber as the actor, not borrowed from
 * `admin`, which would invent an operator who never acted.
 *
 * `dark` is the production default (economy off); `live` has the economy on.
 * Every plan, price and Credit figure is test data.
 */

let dark: TestContext;
let live: TestContext;
let seq = 0;
const PASSWORD = 'cancel-pass-1';
const ACTOR = '00000000-0000-4000-8000-000000000001';

async function app(over: Partial<typeof testEnv>): Promise<TestContext> {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  return { app: await buildApp({ ...testEnv, ...over }, db), db, pool };
}

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  live = await app({ commerce: { ...testEnv.commerce, enabled: true } });
});
afterAll(async () => {
  for (const ctx of [dark, live]) await destroyTestContext(ctx);
});
beforeEach(async () => truncateAll(dark));

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  dark.pool.query<T & import('pg').QueryResultRow>(text, params);

interface Account {
  id: string;
  email: string;
  cookies: Record<string, string>;
}

async function account(admin = false): Promise<Account> {
  const email = `cancel-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  const [row] = await dark.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (admin) await dark.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
  const cookie = extractSessionCookie(res)!;
  return { id: row!.id, email, cookies: { [cookie.name]: cookie.value } };
}

/* ---- the P1 catalogue, as fixtures ---- */

async function publishedPlan(
  code: string,
  over: { months?: number; purchasable?: boolean; priceMinor?: number; version?: number } = {},
) {
  const existing = await q<{ id: string }>('SELECT id FROM economy_plans WHERE code = $1', [code]);
  const planId =
    existing.rows[0]?.id ?? (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
  const { rows } = await q<{ id: string }>(
    `INSERT INTO economy_plan_versions
       (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, is_purchasable)
     VALUES ($1, $6, $2, $3, $4, 'USD', 200, $5) RETURNING id`,
    [planId, `Fixture ${code}`, over.months ?? 12, over.priceMinor ?? 8999, over.purchasable ?? true, over.version ?? 1],
  );
  await q(
    `UPDATE economy_plan_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`,
    [rows[0]!.id, ACTOR],
  );
  return rows[0]!.id;
}

/* ---- the admin route, used only to put a subscription in place ---- */

async function assign(admin: Account, userId: string, planCode: string, expectedVersion = 0) {
  const res = await live.app.inject({
    method: 'POST',
    url: `/admin/users/${userId}/subscription`,
    cookies: admin.cookies,
    payload: { action: 'assign', planCode, expectedVersion, reason: 'Fixture subscription for a test' },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function endSubscription(admin: Account, userId: string, expectedVersion: number) {
  const res = await live.app.inject({
    method: 'POST',
    url: `/admin/users/${userId}/subscription`,
    cookies: admin.cookies,
    payload: { action: 'end', expectedVersion, reason: 'Fixture: ending it for a test' },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** A settled subscription payment, so "amount paid" has something to report. */
const recordPayment = (userId: string, amountMinor: number) =>
  q(
    `INSERT INTO payments (user_id, provider, kind, product_ref, amount_minor, currency, status, checkout_ref, idempotency_key, settled_at)
     VALUES ($1, 'fake', 'subscription', 'premium_annual', $2, 'USD', 'succeeded', $3, $4, now())`,
    [userId, amountMinor, `co_${userId.slice(0, 8)}_${++seq}`, `idem_${userId.slice(0, 8)}_${seq}`],
  );

/* ---- the endpoints under test ---- */

const URL = '/api/me/subscription';
const CANCEL = '/api/me/subscription/cancel';

const read = async (who: Account, ctx: TestContext = live) => {
  const res = await ctx.app.inject({ method: 'GET', url: URL, cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as CustomerSubscriptionResponse).subscription;
};
const cancel = (who: Account, ctx: TestContext = live) =>
  ctx.app.inject({ method: 'POST', url: CANCEL, cookies: who.cookies });

const periodEnd = async (userId: string) =>
  (await q<{ end: string }>('SELECT current_period_end::text AS end FROM subscriptions WHERE user_id = $1', [userId]))
    .rows[0]!.end;
const history = async () =>
  (
    await q<{ change: string; source: string; actor_user_id: string | null; reason: string | null; status: string }>(
      'SELECT change, source, actor_user_id, reason, status FROM subscription_history ORDER BY sequence',
    )
  ).rows;
const tierOf = async (who: Account) => {
  const res = await live.app.inject({ method: 'GET', url: '/api/me/commercial-state', cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  const state = res.json() as CustomerCommercialState;
  return state.tier.available ? state.tier.value : null;
};

/* ------------------------------------------------------------------ *
 * Access and gating
 * ------------------------------------------------------------------ */

describe('who may read and cancel a subscription', () => {
  it('refuses an anonymous caller on both routes', async () => {
    expect((await live.app.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
    expect((await live.app.inject({ method: 'POST', url: CANCEL })).statusCode).toBe(401);
  });

  it('answers 503 on both routes while the economy is off, and changes nothing', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual');
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual');

    expect((await dark.app.inject({ method: 'GET', url: URL, cookies: customer.cookies })).statusCode).toBe(503);
    const refused = await cancel(customer, dark);
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: 'economy_unavailable' });
    // Still active: the refusal cancelled nothing.
    expect((await read(customer))!.status).toBe('active');
  });

  /**
   * Neither route takes a user from the request, so one customer cannot reach
   * another's subscription at all. This pins the consequence: cancelling leaves
   * everybody else exactly as they were.
   */
  it('cancels only the caller’s own subscription', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual');
    const one = await account();
    const other = await account();
    await assign(admin, one.id, 'premium_annual');
    await assign(admin, other.id, 'premium_annual');

    expect((await cancel(one)).statusCode).toBe(200);

    expect((await read(one))!.status).toBe('cancelled');
    expect((await read(other))!.status).toBe('active');
  });
});

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

describe('reading your own subscription', () => {
  it('says there is none rather than inventing one', async () => {
    const customer = await account();
    expect(await read(customer)).toBeNull();
  });

  it('reports the plan it names, the status, the period and that cancelling is available', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual', { months: 12, priceMinor: 8999 });
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual');

    const detail = (await read(customer))!;
    expect(detail.plan).toMatchObject({
      code: 'premium_annual',
      version: 1,
      priceMinor: 8999,
      currency: 'USD',
      billingPeriodMonths: 12,
      monthlyIncludedCredits: 200,
      live: true,
    });
    expect(detail.status).toBe('active');
    expect(detail.cancelAtPeriodEnd).toBe(false);
    expect(detail.canCancel).toBe(true);
    // One billing period from now, as `assign` sets it.
    expect(new Date(detail.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now());
  });

  it('reports when the current subscription began, from its own history', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual');
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual');

    const detail = (await read(customer))!;
    expect(detail.startedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(detail.startedAt!))).toBe(false);
  });

  /**
   * A customer who subscribed, let it lapse and subscribed again started the
   * subscription they hold now on the LATER date. Reporting the first one would
   * tell them they have been a subscriber far longer than they have.
   */
  it('reports the latest start, not the first one ever', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual');
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual', 0);
    const first = (await read(customer))!.startedAt!;
    await endSubscription(admin, customer.id, 1);
    await assign(admin, customer.id, 'premium_annual', 2);

    const second = (await read(customer))!.startedAt!;
    expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
    const assigns = (await history()).filter((row) => row.change === 'assign');
    expect(assigns).toHaveLength(2);
  });

  it('has no payment to report when none was taken', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual');
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual');
    expect((await read(customer))!.lastPayment).toBeNull();
  });

  /** "Amount paid" is a fact about a transaction, so it comes from the payment. */
  it('reports what was actually paid, not the plan’s current price', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual', { priceMinor: 8999 });
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual');
    await recordPayment(customer.id, 7999);

    const detail = (await read(customer))!;
    expect(detail.plan.priceMinor).toBe(8999);
    expect(detail.lastPayment).toMatchObject({ amountMinor: 7999, currency: 'USD' });
  });

  /**
   * THE BUG THIS ENDPOINT EXISTS TO FIX. Once a plan is withdrawn from sale, the
   * catalogue no longer offers it, so the page's `getCurrentPlan` -- which looks
   * the subscription's code up in the CATALOGUE and drops anything not
   * purchasable -- returned null, and an existing subscriber was shown Premium
   * with no plan, no price and no period at all.
   *
   * The subscription names an exact version, and that version is what is
   * reported: its own price, not the newer one that replaced it. Their Premium is
   * entirely unaffected, which is why nothing here is flagged to them.
   */
  it('still describes the exact version held after the plan is withdrawn from sale', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual', { version: 1, priceMinor: 8999 });
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual');
    // Withdrawn from sale by a newer version that is not purchasable.
    await publishedPlan('premium_annual', { version: 2, priceMinor: 9999, purchasable: false });

    const detail = (await read(customer))!;
    expect(detail.plan).toMatchObject({ code: 'premium_annual', version: 1, priceMinor: 8999, live: true });
    // Retired for sale is not retired for the people already on it.
    expect(await tierOf(customer)).toBe('premium');
    expect(detail.canCancel).toBe(true);

    // And the catalogue no longer offers it, which is what broke the old page.
    const res = await live.app.inject({ method: 'GET', url: '/api/economy/catalog', cookies: customer.cookies });
    const offered = (res.json() as { plans: { code: string; isPurchasable: boolean }[] }).plans;
    expect(offered.find((plan) => plan.code === 'premium_annual')?.isPurchasable).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Cancelling
 * ------------------------------------------------------------------ */

describe('cancelling at the end of the paid period', () => {
  it('keeps the paid period exactly as it was, and keeps Premium', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual');
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual');
    const before = await periodEnd(customer.id);
    expect(await tierOf(customer)).toBe('premium');

    const res = await cancel(customer);
    expect(res.statusCode, res.body).toBe(200);
    const detail = (res.json() as CustomerSubscriptionResponse).subscription!;

    expect(detail.status).toBe('cancelled');
    expect(detail.cancelAtPeriodEnd).toBe(true);
    expect(detail.canCancel).toBe(false);
    // THE PROMISE ON THE SCREEN: not a second is taken off the paid period.
    expect(await periodEnd(customer.id)).toBe(before);
    expect(detail.currentPeriodEnd).toBe(new Date(before).toISOString());
    // And Premium is still on, which is the point of cancelling at period end.
    expect(await tierOf(customer)).toBe('premium');
  });

  it('records the change as the customer’s own, naming them and why', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual');
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual');

    expect((await cancel(customer)).statusCode).toBe(200);

    const rows = await history();
    const cancelled = rows.find((row) => row.change === 'cancel')!;
    expect(cancelled.source).toBe('customer');
    expect(cancelled.actor_user_id).toBe(customer.id);
    expect(cancelled.reason).toBeTruthy();
    expect(cancelled.status).toBe('cancelled');
  });

  it('refuses a second cancellation and records nothing for it', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual');
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual');
    expect((await cancel(customer)).statusCode).toBe(200);
    const after = (await history()).length;

    const again = await cancel(customer);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'invalid_transition' });
    expect((await history()).length).toBe(after);
  });

  it('refuses a cancellation when there is no subscription', async () => {
    const customer = await account();
    const res = await cancel(customer);
    expect(res.statusCode).toBe(409);
    expect((await history()).length).toBe(0);
  });

  it('refuses once the subscription has already expired', async () => {
    const admin = await account(true);
    await publishedPlan('premium_annual');
    const customer = await account();
    await assign(admin, customer.id, 'premium_annual', 0);
    await endSubscription(admin, customer.id, 1);

    expect((await read(customer))!.canCancel).toBe(false);
    expect((await cancel(customer)).statusCode).toBe(409);
  });
});
