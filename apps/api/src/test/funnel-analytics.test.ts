import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AnalyticsFunnelsView, CustomerCheckout, SimulatedPaymentResult } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import type { Env } from '../env.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createAnalytics, createDbAnalyticsSink, track, type AnalyticsEvent, type AnalyticsSink } from '../services/analytics-service.js';
import { setContentOffer } from '../services/commercial-boundary.js';
import { refundContentUnlock } from '../services/content-unlock-service.js';
import { ANALYTICS_EXPORT_MAX, parseAnalyticsWindow, readAnalyticsFunnels } from '../services/analytics-funnels.js';
import { uploadLibraryAsset } from '../services/library-upload-service.js';
import { approveVisualAsset } from '../services/visual-asset-service.js';
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
 * Funnel analytics (Credits Store PR 3).
 *
 * What is proven:
 *   - nothing is recorded while ANALYTICS_ENABLED is off (the production default);
 *   - each server event is written once, AFTER its business transaction has
 *     committed, by the delivery that actually changed something;
 *   - a declined or cancelled pack payment is `credit_purchase_failed`, never
 *     `completed`;
 *   - a split spend is ONE `credit_spend`;
 *   - analytics failing changes nothing about the purchase or unlock;
 *   - the browser may report only client events, only as itself, and only
 *     allow-listed properties;
 *   - the funnels count people in order, and only analysts can read or export.
 *
 * This suite switches analytics on INSIDE its own in-process apps. Nothing here
 * reads or changes any deployed configuration.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const ACTOR = '00000000-0000-4000-8000-000000000001';
const ON = { enabled: true };

const economyOn = (analyticsEnabled: boolean): Env => ({
  ...testEnv,
  commerce: { ...testEnv.commerce, enabled: true, paymentProvider: 'fake', analyticsEnabled },
});

let dark: TestContext;
/** Economy on, analytics on, the real `analytics_events` sink. */
let live: TestContext;
/** Economy on, analytics OFF -- the production default. */
let off: TestContext;
/** Economy on, analytics on, and a sink that always fails. */
let broken: TestContext;
/** Economy on, analytics on, and a sink that looks at what has COMMITTED when it is called. */
let observer: TestContext;
/** Live, with admin permissions enforced: analysts versus everyone else. */
let enforced: TestContext;
let outside: import('pg').Pool;
const observed: Array<{ event: AnalyticsEvent; committed: Record<string, unknown> }> = [];

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  const make = async (env: Env, options: Parameters<typeof buildApp>[2] = {}): Promise<TestContext> => {
    const { db, pool } = createDb(TEST_DATABASE_URL);
    return { app: await buildApp(env, db, options), db, pool };
  };
  live = await make(economyOn(true));
  off = await make(economyOn(false));
  broken = await make(economyOn(true), { analyticsSink: { write: async () => Promise.reject(new Error('analytics store down')) } });
  // A separate connection: it can see only what other transactions committed.
  outside = createDb(TEST_DATABASE_URL).pool;
  const committedSink: AnalyticsSink = {
    async write(event) {
      const p = event.properties;
      const committed: Record<string, unknown> = {};
      if (typeof p.paymentId === 'string') {
        committed.payment = (await outside.query('SELECT status FROM payments WHERE id = $1', [p.paymentId])).rows[0]?.status ?? null;
        committed.ledger = (await outside.query('SELECT count(*)::int AS n FROM wallet_transactions WHERE source_id = $1', [p.paymentId])).rows[0]!.n;
      }
      if (typeof p.paidActionId === 'string') {
        committed.action = (await outside.query('SELECT status FROM paid_actions WHERE id = $1', [p.paidActionId])).rows[0]?.status ?? null;
      }
      if (typeof p.entitlementId === 'string') {
        committed.entitlement = (await outside.query('SELECT count(*)::int AS n FROM content_entitlements WHERE id = $1', [p.entitlementId])).rows[0]!.n;
      }
      observed.push({ event, committed });
    },
  };
  observer = await make(economyOn(true), { analyticsSink: committedSink });
  enforced = await make({ ...economyOn(true), admin: { auditEnabled: false, permissionsEnforced: true } });
});
afterAll(async () => {
  for (const ctx of [dark, live, off, broken, observer, enforced]) await destroyTestContext(ctx);
  await outside.end();
});
beforeEach(async () => {
  await truncateAll(dark);
  await seedCharacters(dark.db);
  await seedVisualIdentities(dark.db);
  observed.length = 0;
  await seedPlan();
  await publishPack({ code: 'starter', credits: 100, bonusCredits: 20, priceMinor: 499, wasPriceMinor: 699 });
});

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  dark.pool.query<T & import('pg').QueryResultRow>(text, params);

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

async function seedPlan() {
  const planId = (await q<{ id: string }>("INSERT INTO economy_plans (code) VALUES ('premium_monthly') RETURNING id")).rows[0]!.id;
  const versionId = (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions
         (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, is_purchasable)
       VALUES ($1, 1, 'Premium monthly', 1, 1299, 'USD', 200, true) RETURNING id`,
      [planId],
    )
  ).rows[0]!.id;
  await q(`UPDATE economy_plan_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`, [versionId, ACTOR]);
}

async function publishPack(p: { code: string; credits: number; bonusCredits: number; priceMinor: number; wasPriceMinor: number | null }) {
  const packId = (await q<{ id: string }>('INSERT INTO economy_packs (code) VALUES ($1) RETURNING id', [p.code])).rows[0]!.id;
  const versionId = (
    await q<{ id: string }>(
      `INSERT INTO economy_pack_versions
         (pack_id, version, display_name, credits, price_minor, currency, sort_order, is_best_value, is_purchasable,
          badge, bonus_credits, was_price_minor, promotion_ends_at)
       VALUES ($1, 1, 'Starter', $2, $3, 'USD', 0, false, true, NULL, $4, $5, NULL) RETURNING id`,
      [packId, p.credits, p.priceMinor, p.bonusCredits, p.wasPriceMinor],
    )
  ).rows[0]!.id;
  await q(`UPDATE economy_pack_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`, [versionId, ACTOR]);
}

interface Account {
  id: string;
  email: string;
  cookies: Record<string, string>;
}
let seq = 0;

async function account(roles?: string[]): Promise<Account> {
  const email = `funnel-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'funnel-pass-1' } });
  expect(res.statusCode).toBe(201);
  const id = (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
  if (roles) {
    await q(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
    for (const role of roles) await q('INSERT INTO admin_role_grants (user_id, role) VALUES ($1, $2)', [id, role]);
  }
  const cookie = extractSessionCookie(res)!;
  return { id, email, cookies: { [cookie.name]: cookie.value } };
}

const CONTEXT = { origin: 'content', originAction: 'content_unlock', assetId: randomUUID(), characterId: LUNA.id };

async function startPack(ctx: TestContext, who: Account, over: Record<string, unknown> = {}): Promise<CustomerCheckout> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/payments/checkout',
    cookies: who.cookies,
    payload: { packCode: 'starter', method: 'apple_pay', idempotencyKey: `k-${++seq}`, context: CONTEXT, ...over },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CustomerCheckout;
}

async function simulate(ctx: TestContext, who: Account, checkoutRef: string, outcome: string, over: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/payments/simulate', cookies: who.cookies, payload: { checkoutRef, outcome, ...over } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SimulatedPaymentResult;
}

/** An approved clip on Luna's Posts, Credit-priced. */
async function pricedClip(price: number): Promise<{ clip: string; offerId: string }> {
  const operator = await account(['administrator']);
  const created = await uploadLibraryAsset(dark.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, originalName: 'clip.png' });
  const approved = await approveVisualAsset(dark.db, created.id);
  const released = await dark.app.inject({ method: 'POST', url: `/admin/content/assets/${approved.id}/publish`, cookies: operator.cookies });
  expect(released.statusCode, released.body).toBe(200);
  const offer = await setContentOffer(dark.db, ON, { assetId: approved.id, state: 'credit', creditPrice: price });
  return { clip: approved.id, offerId: offer.id };
}

async function fund(userId: string, amount: number, creditClass: 'purchased' | 'earned' = 'purchased') {
  await q("INSERT INTO wallets (user_id, currency) VALUES ($1, 'credits') ON CONFLICT DO NOTHING", [userId]);
  await q(
    `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
     VALUES ($1, 'credits', 'grant', 'credit', $2, $3, $4)`,
    [userId, amount, creditClass, `fixture:${randomUUID()}`],
  );
}

const unlock = (ctx: TestContext, who: Account, assetId: string, key = 'buy-1') =>
  ctx.app.inject({ method: 'POST', url: `/api/content/${assetId}/unlock`, cookies: who.cookies, payload: { idempotencyKey: key } });

interface Row {
  name: string;
  user_id: string | null;
  source: string;
  properties: Record<string, unknown>;
  request_id: string | null;
}
const rows = async (name?: string): Promise<Row[]> =>
  (
    await q<Row>(
      name
        ? 'SELECT name, user_id, source, properties, request_id FROM analytics_events WHERE name = $1 ORDER BY id'
        : 'SELECT name, user_id, source, properties, request_id FROM analytics_events ORDER BY id',
      name ? [name] : [],
    )
  ).rows;

/** Events are fire-and-forget: wait until the expected number have landed. */
async function landed(count: number, name?: string, timeoutMs = 3_000): Promise<Row[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = await rows(name);
    if (found.length >= count || Date.now() > until) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** For "nothing was recorded": give any stray emit time to land first. */
const quiet = () => new Promise((r) => setTimeout(r, 250));

/* ------------------------------------------------------------------ *
 * 1. Off means off
 * ------------------------------------------------------------------ */

describe('while ANALYTICS_ENABLED is off (the production default)', () => {
  it('a purchase, a failure, an unlock and a client report record nothing', async () => {
    const customer = await account();
    const paid = await startPack(off, customer);
    await simulate(off, customer, paid.checkoutRef, 'success');
    const declined = await startPack(off, customer);
    await simulate(off, customer, declined.checkoutRef, 'failure');
    const { clip } = await pricedClip(50);
    expect((await unlock(off, customer, clip)).statusCode).toBe(200);
    const client = await off.app.inject({ method: 'POST', url: '/api/analytics/events', cookies: customer.cookies, payload: { name: 'paywall_viewed' } });
    expect(client.statusCode).toBe(202);
    expect(client.json()).toEqual({ recorded: false });
    await quiet();
    expect(await rows()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Credit pack purchases
 * ------------------------------------------------------------------ */

describe('a Credit pack purchase', () => {
  it('records started then completed, with the locked terms and where it started -- and no email', async () => {
    const customer = await account();
    const checkout = await startPack(live, customer);
    const [started] = await landed(1, 'credit_purchase_started');
    expect(started).toMatchObject({ user_id: customer.id, source: 'server' });
    expect(started!.request_id).toEqual(expect.any(String));
    expect(started!.properties).toEqual({
      paymentId: checkout.payment.id,
      packCode: 'starter',
      packVersion: 1,
      credits: 100,
      bonusCredits: 20,
      totalCredits: 120,
      priceMinor: 499,
      currency: 'USD',
      promoted: true,
      tier: 'free',
      method: 'apple_pay',
      origin: 'content',
      originAction: 'content_unlock',
      assetId: CONTEXT.assetId,
      characterId: CONTEXT.characterId,
    });

    await simulate(live, customer, checkout.checkoutRef, 'success');
    const [completed] = await landed(1, 'credit_purchase_completed');
    const { method: _method, ...terms } = started!.properties;
    expect(completed!.properties).toEqual(terms);
    expect(await rows('credit_purchase_failed')).toEqual([]);
    expect(JSON.stringify(await rows())).not.toContain(customer.email);
  });

  it('a replayed checkout key and a redelivered confirmation add no second event', async () => {
    const customer = await account();
    const key = `same-${++seq}`;
    const checkout = await startPack(live, customer, { idempotencyKey: key });
    const again = await startPack(live, customer, { idempotencyKey: key });
    expect(again.replayed).toBe(true);
    await simulate(live, customer, checkout.checkoutRef, 'success', { eventRef: 'evt-1' });
    await simulate(live, customer, checkout.checkoutRef, 'success', { eventRef: 'evt-1' }); // same delivery
    await simulate(live, customer, checkout.checkoutRef, 'success', { eventRef: 'evt-2' }); // new delivery, already settled
    await landed(2);
    await quiet();
    expect((await rows()).map((r) => r.name)).toEqual(['credit_purchase_started', 'credit_purchase_completed']);
  });

  it.each(['failure', 'cancel'])('a %s is credit_purchase_failed -- never completed', async (outcome) => {
    const customer = await account();
    const checkout = await startPack(live, customer);
    await simulate(live, customer, checkout.checkoutRef, outcome);
    const [failed] = await landed(1, 'credit_purchase_failed');
    // The provider interface has one "did not happen" event for both, so the
    // stored payment -- and the event -- say `failed`.
    expect(failed!.properties).toMatchObject({ paymentId: checkout.payment.id, packCode: 'starter', totalCredits: 120, status: 'failed', originAction: 'content_unlock' });
    // A success arriving after the failure changes nothing, and claims nothing.
    await simulate(live, customer, checkout.checkoutRef, 'success');
    await quiet();
    expect(await rows('credit_purchase_completed')).toEqual([]);
    expect(await rows('credit_purchase_failed')).toHaveLength(1);
  });

  it('a Premium buyer is recorded with tier premium', async () => {
    const customer = await account();
    const sub = await live.app.inject({ method: 'POST', url: '/api/payments/checkout', cookies: customer.cookies, payload: { planCode: 'premium_monthly', method: 'paypal', idempotencyKey: `p-${++seq}` } });
    await simulate(live, customer, (sub.json() as CustomerCheckout).checkoutRef, 'success');
    await startPack(live, customer);
    const [started] = await landed(1, 'credit_purchase_started');
    expect(started!.properties.tier).toBe('premium');
  });
});

describe('a subscription purchase', () => {
  it('records subscription_started once, after the payment is confirmed', async () => {
    const customer = await account();
    const res = await live.app.inject({ method: 'POST', url: '/api/payments/checkout', cookies: customer.cookies, payload: { planCode: 'premium_monthly', method: 'paypal', idempotencyKey: `p-${++seq}` } });
    const checkout = res.json() as CustomerCheckout;
    await quiet();
    expect(await rows()).toEqual([]); // starting a plan checkout is not a funnel step
    await simulate(live, customer, checkout.checkoutRef, 'success');
    await simulate(live, customer, checkout.checkoutRef, 'success', { eventRef: 'again' });
    const [started] = await landed(1, 'subscription_started');
    await quiet();
    expect(await rows('subscription_started')).toHaveLength(1);
    expect(started!.properties).toEqual({ paymentId: checkout.payment.id, planCode: 'premium_monthly', billingPeriodMonths: 1, priceMinor: 1299, currency: 'USD' });
  });
});

/* ------------------------------------------------------------------ *
 * 3. Spending: unlocks and refunds
 * ------------------------------------------------------------------ */

describe('a content unlock', () => {
  it('records one credit_spend and one locked_content_unlocked -- one spend even when two classes pay', async () => {
    const customer = await account();
    const { clip, offerId } = await pricedClip(50);
    await fund(customer.id, 30, 'earned');
    await fund(customer.id, 30, 'purchased');
    const res = await unlock(live, customer, clip);
    expect(res.statusCode, res.body).toBe(200);
    const spends = await landed(1, 'credit_spend');
    const [unlocked] = await landed(1, 'locked_content_unlocked');
    await quiet();
    expect(await rows('credit_spend')).toHaveLength(1);
    expect(spends[0]!.properties).toEqual({ paidActionId: expect.any(String), actionType: 'content_unlock', amount: 50 });
    expect(unlocked!.properties).toEqual({ assetId: clip, offerId, entitlementId: res.json().entitlementId, creditPrice: 50 });

    // A retry of the same key, and an unlock of what is already owned: no new events.
    expect((await unlock(live, customer, clip)).json().replayed).toBe(true);
    expect((await unlock(live, customer, clip, 'other-key')).json().replayed).toBe(true);
    await quiet();
    expect(await rows()).toHaveLength(2);
  });

  it('an unlock that fails records nothing', async () => {
    const customer = await account();
    const { clip } = await pricedClip(50);
    await fund(customer.id, 10);
    expect((await unlock(live, customer, clip)).statusCode).toBe(402);
    await quiet();
    expect(await rows()).toEqual([]);
  });

  it('a refund records spend_refunded once', async () => {
    const customer = await account();
    const { clip } = await pricedClip(50);
    await fund(customer.id, 60);
    expect((await unlock(live, customer, clip)).statusCode).toBe(200);
    const [spend] = await landed(1, 'credit_spend');
    // The service is the only refund path (no route calls it yet); the app's own recorder is passed.
    const analytics = createAnalytics({ enabled: true, sink: createDbAnalyticsSink(live.db) });
    await refundContentUnlock(live.db, ON, { userId: customer.id, assetId: clip, reason: 'test refund' }, { analytics });
    const [refunded] = await landed(1, 'spend_refunded');
    expect(refunded!.properties).toEqual({ paidActionId: spend!.properties.paidActionId, actionType: 'content_unlock', amount: 50 });
    // Refunding again is refused (nothing owned) and records nothing more.
    await expect(
      refundContentUnlock(live.db, ON, { userId: customer.id, assetId: clip, reason: 'again' }, { analytics }),
    ).rejects.toMatchObject({ code: 'not_owned' });
    await quiet();
    expect(await rows('spend_refunded')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 4. After commit, and never in the way
 * ------------------------------------------------------------------ */

describe('emitted only after the business transaction commits', () => {
  it('every server event finds its effect already committed when it is written', async () => {
    const customer = await account();
    const checkout = await startPack(observer, customer);
    await simulate(observer, customer, checkout.checkoutRef, 'success');
    const declined = await startPack(observer, customer);
    await simulate(observer, customer, declined.checkoutRef, 'failure');
    const { clip } = await pricedClip(50);
    expect((await unlock(observer, customer, clip)).statusCode).toBe(200);
    const until = Date.now() + 3_000;
    while (observed.length < 6 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));

    const by = (name: string) => observed.filter((o) => o.event.name === name).map((o) => o.committed);
    // Started: the pending payment row is already visible to another connection.
    // (Its later state can race ahead of this fire-and-forget write, so only existence is asserted.)
    const started = by('credit_purchase_started');
    expect(started).toHaveLength(2);
    for (const s of started) expect(s.payment).not.toBeNull();
    // Completed is written when the payment is settled AND both ledger entries exist.
    expect(by('credit_purchase_completed')).toEqual([{ payment: 'succeeded', ledger: 2 }]);
    expect(by('credit_purchase_failed')).toEqual([{ payment: 'failed', ledger: 0 }]);
    expect(by('credit_spend')).toEqual([{ action: 'captured' }]);
    expect(by('locked_content_unlocked')).toEqual([{ entitlement: 1 }]);
  });

  it('an event is dated when it is emitted: a slow property builder cannot make it later than the next event', async () => {
    const customer = await account();
    const analytics = createAnalytics({ enabled: true, sink: createDbAnalyticsSink(live.db) });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    // First: completed, whose properties take a while to build (as a DB read can).
    const first = track(analytics, 'credit_purchase_completed', async () => {
      await held;
      return { userId: customer.id, properties: { packCode: 'starter' } };
    });
    await new Promise((r) => setTimeout(r, 20));
    // Then: a spend, emitted after it and stored straight away.
    await track(analytics, 'credit_spend', () => ({ userId: customer.id, properties: { amount: 5 } }));
    expect((await rows()).map((r) => r.name)).toEqual(['credit_spend']); // completed is still being built
    await new Promise((r) => setTimeout(r, 150));
    release();
    expect(await first).toBe(true);

    const stored = (
      await q<{ name: string; occurred_at: Date; id: string }>('SELECT id, name, occurred_at FROM analytics_events ORDER BY id')
    ).rows;
    // Stored second...
    expect(stored.map((r) => r.name)).toEqual(['credit_spend', 'credit_purchase_completed']);
    const at = Object.fromEntries(stored.map((r) => [r.name, r.occurred_at.getTime()]));
    // ...but dated first, when it was emitted -- not ~170ms later, when it was written.
    expect(at.credit_purchase_completed!).toBeLessThan(at.credit_spend!);
  });

  it('the sink writes the time the emitter gave, and the table never supplies one of its own', async () => {
    const customer = await account();
    const stated = new Date('2026-09-20T08:00:00.123Z');
    const analytics = createAnalytics({ enabled: true, sink: createDbAnalyticsSink(live.db), now: () => new Date('2030-01-01T00:00:00Z') });
    expect(await analytics.emit('credit_spend', { userId: customer.id, occurredAt: stated })).toBe(true);
    const [row] = (await q<{ occurred_at: Date }>('SELECT occurred_at FROM analytics_events')).rows;
    expect(row!.occurred_at.toISOString()).toBe(stated.toISOString());
    // No column default: a row without a time is refused, not dated by the database.
    await expect(q(`INSERT INTO analytics_events (name, source) VALUES ('credit_spend', 'server')`)).rejects.toMatchObject({ code: '23502' });
  });

  it('a failing analytics store changes nothing: the purchase completes and the unlock owns', async () => {
    const customer = await account();
    const checkout = await startPack(broken, customer);
    const result = await simulate(broken, customer, checkout.checkoutRef, 'success');
    expect(result.payment).toMatchObject({ status: 'succeeded' });
    const balance = (await q<{ balance: number }>("SELECT balance FROM wallets WHERE user_id = $1 AND currency = 'credits'", [customer.id])).rows[0]!;
    expect(balance.balance).toBe(120);
    const { clip } = await pricedClip(50);
    expect((await unlock(broken, customer, clip)).statusCode).toBe(200);
    const client = await broken.app.inject({ method: 'POST', url: '/api/analytics/events', cookies: customer.cookies, payload: { name: 'paywall_viewed' } });
    expect(client.statusCode).toBe(202);
    expect(client.json()).toEqual({ recorded: false });
  });
});

/* ------------------------------------------------------------------ *
 * 5. What a browser may report
 * ------------------------------------------------------------------ */

describe('POST /api/analytics/events', () => {
  const report = (ctx: TestContext, who: Account | null, payload: unknown) =>
    ctx.app.inject({ method: 'POST', url: '/api/analytics/events', ...(who ? { cookies: who.cookies } : {}), payload: payload as Record<string, unknown> });

  it('stores a client event as the session user, keeping only allow-listed properties', async () => {
    const customer = await account();
    const res = await report(live, customer, {
      name: 'credit_purchase_viewed',
      properties: {
        origin: 'chat',
        originAction: 'image',
        // Server-owned: whatever the browser claims is replaced with the server's facts.
        tier: 'premium',
        balanceState: 'normal',
        packCount: 3,
        // None of these survive: unknown keys, free text, a wrong type, an invalid enum.
        email: 'someone@example.com',
        userId: randomUUID(),
        note: 'free text',
        packCount2: 1,
        characterId: 'not-an-id',
        origin2: 'chat',
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ recorded: true });
    const [row] = await rows();
    expect(row).toMatchObject({ name: 'credit_purchase_viewed', user_id: customer.id, source: 'client' });
    // The only purchasable pack in this suite's catalog is 'starter': the server recommends it.
    expect(row!.properties).toEqual({ origin: 'chat', originAction: 'image', tier: 'free', balanceState: 'zero', packCount: 3, recommendedPackCode: 'starter' });
  });

  it("states a locked post's decision and price, and the tier and balance, from the server -- never from the browser", async () => {
    const customer = await account();
    const { clip } = await pricedClip(50);
    await fund(customer.id, 8, 'earned'); // low: at most LOW_CREDIT_BALANCE
    const res = await report(live, customer, {
      name: 'locked_content_viewed',
      properties: { surface: 'posts', assetId: clip, characterId: LUNA.id, decision: 'premium_required', creditPrice: 1 },
    });
    expect(res.json()).toEqual({ recorded: true });
    expect((await rows())[0]!.properties).toEqual({
      surface: 'posts',
      assetId: clip,
      characterId: LUNA.id,
      decision: 'insufficient_credits',
      creditPrice: 50,
    });
    await report(live, customer, { name: 'credit_purchase_viewed', properties: { tier: 'premium', balanceState: 'normal' } });
    expect((await rows('credit_purchase_viewed'))[0]!.properties).toEqual({ tier: 'free', balanceState: 'low', recommendedPackCode: 'starter' });
  });

  describe('credit_purchase_viewed.recommendedPackCode is the server\'s (store conversion)', () => {
    const ladder = async () => {
      // 'starter' (120 Credits, $4.99) is published by beforeEach; two more make a ladder.
      await publishPack({ code: 'mid', credits: 300, bonusCredits: 0, priceMinor: 999, wasPriceMinor: null });
      await publishPack({ code: 'big', credits: 750, bonusCredits: 50, priceMinor: 1999, wasPriceMinor: null });
    };
    const viewed = async () => (await rows('credit_purchase_viewed'))[0]!.properties;
    /** A NEW published version of an existing pack -- published versions are immutable. */
    const republish = async (code: string, over: { isBestValue?: boolean; isPurchasable?: boolean }) => {
      const packId = (await q<{ id: string }>('SELECT id FROM economy_packs WHERE code = $1', [code])).rows[0]!.id;
      const prev = (await q<{ version: number; credits: number; bonus_credits: number; price_minor: number }>(
        'SELECT version, credits, bonus_credits, price_minor FROM economy_pack_versions WHERE pack_id = $1 ORDER BY version DESC LIMIT 1',
        [packId],
      )).rows[0]!;
      const versionId = (
        await q<{ id: string }>(
          `INSERT INTO economy_pack_versions
             (pack_id, version, display_name, credits, price_minor, currency, sort_order, is_best_value, is_purchasable, badge, bonus_credits, was_price_minor, promotion_ends_at)
           VALUES ($1, $2, $3, $4, $5, 'USD', 0, $6, $7, NULL, $8, NULL, NULL) RETURNING id`,
          [packId, prev.version + 1, code, prev.credits, prev.price_minor, over.isBestValue ?? false, over.isPurchasable ?? true, prev.bonus_credits],
        )
      ).rows[0]!.id;
      await q(`UPDATE economy_pack_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`, [versionId, ACTOR]);
    };

    it('a plain visit: the second-cheapest pack -- whatever the browser claims', async () => {
      await ladder();
      const customer = await account();
      await report(live, customer, { name: 'credit_purchase_viewed', properties: { origin: 'store', recommendedPackCode: 'big' } });
      expect((await viewed()).recommendedPackCode).toBe('mid');
    });

    it('arriving to unlock: the smallest pack covering the server price less the server balance', async () => {
      await ladder();
      const customer = await account();
      const { clip } = await pricedClip(400);
      await fund(customer.id, 30); // needs 370: 'starter' (120) and 'mid' (300) fall short, 'big' (800) covers it
      await report(live, customer, {
        name: 'credit_purchase_viewed',
        properties: { origin: 'profile', originAction: 'content_unlock', assetId: clip, characterId: LUNA.id, recommendedPackCode: 'starter' },
      });
      expect(await viewed()).toMatchObject({ assetId: clip, recommendedPackCode: 'big' });
    });

    it("the operator's best value wins, and a code the catalog does not offer can never be stored", async () => {
      await ladder();
      await republish('starter', { isBestValue: true });
      const customer = await account();
      await report(live, customer, { name: 'credit_purchase_viewed', properties: { recommendedPackCode: 'not_a_pack' } });
      expect((await viewed()).recommendedPackCode).toBe('starter');
    });

    it('nothing on sale: no recommended pack at all', async () => {
      await republish('starter', { isPurchasable: false });
      const customer = await account();
      await report(live, customer, { name: 'credit_purchase_viewed', properties: { recommendedPackCode: 'starter' } });
      expect(await viewed()).not.toHaveProperty('recommendedPackCode');
    });
  });

  it.each([
    ['a server event', 'credit_purchase_completed'],
    ['a spend', 'credit_spend'],
    ['an unknown name', 'made_up'],
  ])('refuses %s (400) and stores nothing', async (_label, name) => {
    const customer = await account();
    const res = await report(live, customer, { name, properties: { paymentId: randomUUID() } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_event' });
    expect(await rows()).toEqual([]);
  });

  it('refuses properties that are not an object', async () => {
    const customer = await account();
    expect((await report(live, customer, { name: 'paywall_viewed', properties: ['x'] })).statusCode).toBe(400);
    expect((await report(live, customer, { name: 'paywall_viewed', properties: 'x' })).statusCode).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('drops an anonymous report without storing it', async () => {
    const res = await report(live, null, { name: 'paywall_viewed', properties: { surface: 'premium_gate' } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ recorded: false });
    expect(await rows()).toEqual([]);
  });

  it('refuses an oversized body (413)', async () => {
    const customer = await account();
    const res = await report(live, customer, { name: 'paywall_viewed', properties: { surface: 'x'.repeat(8_000) } });
    expect(res.statusCode).toBe(413);
    expect(await rows()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Funnels and export
 * ------------------------------------------------------------------ */

async function event(userId: string | null, name: string, at: string, properties: Record<string, unknown> = {}) {
  await q('INSERT INTO analytics_events (name, user_id, occurred_at, source, properties) VALUES ($1, $2, $3, $4, $5)', [
    name,
    userId,
    at,
    'server',
    JSON.stringify(properties),
  ]);
}

describe('the funnels', () => {
  it('count people who reach each step in order, inside the window', async () => {
    const analyst = await account(['analyst']);
    const [a, b, c, d] = [await account(), await account(), await account(), await account()];
    // A: a converts; b clicks but never pays; c pays BEFORE seeing the paywall (out of order);
    // d saw the paywall as Premium (not a free viewer).
    await event(a.id, 'paywall_viewed', '2026-09-10T10:00:00Z', { tier: 'free' });
    await event(a.id, 'subscription_cta_clicked', '2026-09-10T10:01:00Z');
    await event(a.id, 'subscription_started', '2026-09-10T10:02:00Z');
    await event(b.id, 'paywall_viewed', '2026-09-11T10:00:00Z', { tier: 'free' });
    await event(b.id, 'paywall_viewed', '2026-09-11T10:05:00Z', { tier: 'free' }); // counted once
    await event(b.id, 'subscription_cta_clicked', '2026-09-11T10:06:00Z');
    await event(c.id, 'subscription_started', '2026-09-12T09:00:00Z');
    await event(c.id, 'subscription_cta_clicked', '2026-09-12T09:30:00Z');
    await event(c.id, 'paywall_viewed', '2026-09-12T10:00:00Z', { tier: 'free' });
    await event(d.id, 'paywall_viewed', '2026-09-12T10:00:00Z', { tier: 'premium' });
    // B and D.
    await event(a.id, 'credit_purchase_viewed', '2026-09-13T10:00:00Z', { tier: 'free' });
    await event(a.id, 'credit_purchase_started', '2026-09-13T10:01:00Z');
    await event(a.id, 'credit_purchase_completed', '2026-09-13T10:02:00Z');
    await event(a.id, 'credit_spend', '2026-09-13T11:00:00Z');
    await event(b.id, 'credit_purchase_completed', '2026-09-13T10:02:00Z');
    await event(b.id, 'credit_purchase_failed', '2026-09-13T10:03:00Z');
    // C: locked content -> checkout to unlock it -> paid -> unlocked, all the same post.
    const postC = randomUUID();
    const postD = randomUUID();
    await event(c.id, 'locked_content_viewed', '2026-09-14T10:00:00Z', { assetId: postC });
    await event(c.id, 'credit_purchase_started', '2026-09-14T10:01:00Z', { originAction: 'content_unlock', assetId: postC });
    await event(c.id, 'credit_purchase_completed', '2026-09-14T10:02:00Z', { originAction: 'content_unlock', assetId: postC });
    await event(c.id, 'locked_content_unlocked', '2026-09-14T10:03:00Z', { assetId: postC });
    await event(d.id, 'locked_content_viewed', '2026-09-14T10:00:00Z', { assetId: postD });
    await event(d.id, 'credit_purchase_started', '2026-09-14T10:01:00Z', { originAction: 'browse', assetId: postD }); // not to unlock
    // Outside the window, and anonymous: neither is in a funnel.
    await event(d.id, 'paywall_viewed', '2026-08-01T10:00:00Z', { tier: 'free' });
    await event(null, 'paywall_viewed', '2026-09-15T10:00:00Z', { tier: 'free' });

    const res = await enforced.app.inject({ method: 'GET', url: '/admin/analytics/funnels?from=2026-09-01&to=2026-09-30', cookies: analyst.cookies });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as AnalyticsFunnelsView;
    const steps = (key: string) => view.funnels.find((f) => f.key === key)!.steps.map((s) => s.users);
    expect(view.from).toBe('2026-09-01');
    expect(view.to).toBe('2026-09-30');
    expect(steps('free_to_premium')).toEqual([3, 2, 1]);
    expect(steps('free_to_credit_purchase')).toEqual([1, 1, 1]);
    expect(steps('locked_content_to_unlock')).toEqual([2, 1, 1, 1]);
    expect(steps('purchase_to_spend')).toEqual([3, 1]);
    expect(view.eventCounts.paywall_viewed).toBe(6); // anonymous included, August excluded
    expect(view.failedCreditPurchases).toBe(1);
    expect(view.recording).toBe(true);
  });

  describe('Funnel C follows ONE post: the same assetId at every step', () => {
    const WINDOW = { from: new Date('2026-09-01T00:00:00Z'), toExclusive: new Date('2026-10-01T00:00:00Z') };
    const funnelC = async () =>
      (await readAnalyticsFunnels(dark.db, WINDOW, true)).funnels.find((f) => f.key === 'locked_content_to_unlock')!.steps.map((s) => s.users);
    const UNLOCK = { originAction: 'content_unlock' };
    /** One journey step for `who` on `post`, a minute apart. */
    const step = (who: Account, name: string, minute: number, post: string, extra: Record<string, unknown> = {}) =>
      event(who.id, name, `2026-09-14T10:${String(minute).padStart(2, '0')}:00Z`, { assetId: post, ...extra });

    it('view A -> buy A -> unlock A counts at every step', async () => {
      const who = await account();
      const A = randomUUID();
      await step(who, 'locked_content_viewed', 0, A);
      await step(who, 'credit_purchase_started', 1, A, UNLOCK);
      await step(who, 'credit_purchase_completed', 2, A, UNLOCK);
      await step(who, 'locked_content_unlocked', 3, A);
      expect(await funnelC()).toEqual([1, 1, 1, 1]);
    });

    it('view A -> buy B -> unlock B does NOT count for A', async () => {
      const who = await account();
      const [A, B] = [randomUUID(), randomUUID()];
      await step(who, 'locked_content_viewed', 0, A);
      await step(who, 'credit_purchase_started', 1, B, UNLOCK);
      await step(who, 'credit_purchase_completed', 2, B, UNLOCK);
      await step(who, 'locked_content_unlocked', 3, B);
      expect(await funnelC()).toEqual([1, 0, 0, 0]);
    });

    it('view A -> buy B -> unlock A does NOT count', async () => {
      const who = await account();
      const [A, B] = [randomUUID(), randomUUID()];
      await step(who, 'locked_content_viewed', 0, A);
      await step(who, 'credit_purchase_started', 1, B, UNLOCK);
      await step(who, 'credit_purchase_completed', 2, B, UNLOCK);
      await step(who, 'locked_content_unlocked', 3, A);
      expect(await funnelC()).toEqual([1, 0, 0, 0]);
    });

    it("one customer's purchases for different posts are never merged into one journey", async () => {
      const who = await account();
      const [A, B] = [randomUUID(), randomUUID()];
      // Saw both; started a checkout for A but paid for B; unlocked both.
      await step(who, 'locked_content_viewed', 0, A);
      await step(who, 'locked_content_viewed', 1, B);
      await step(who, 'credit_purchase_started', 2, A, UNLOCK);
      await step(who, 'credit_purchase_completed', 3, B, UNLOCK);
      await step(who, 'locked_content_unlocked', 4, A);
      await step(who, 'locked_content_unlocked', 5, B);
      // A stops after its checkout; B never had one. Merged, this would read [1, 1, 1, 1].
      expect(await funnelC()).toEqual([1, 1, 0, 0]);
    });

    it('two finished journeys by one customer are still one person at each step', async () => {
      const who = await account();
      for (const [i, post] of [randomUUID(), randomUUID()].entries()) {
        await step(who, 'locked_content_viewed', i * 10, post);
        await step(who, 'credit_purchase_started', i * 10 + 1, post, UNLOCK);
        await step(who, 'credit_purchase_completed', i * 10 + 2, post, UNLOCK);
        await step(who, 'locked_content_unlocked', i * 10 + 3, post);
      }
      expect(await funnelC()).toEqual([1, 1, 1, 1]);
    });

    it('an event with no assetId belongs to no journey', async () => {
      const who = await account();
      const A = randomUUID();
      await step(who, 'locked_content_viewed', 0, A);
      await event(who.id, 'credit_purchase_started', '2026-09-14T10:01:00Z', UNLOCK); // no asset
      expect(await funnelC()).toEqual([1, 0, 0, 0]);
    });
  });

  it('refuses a bad or oversized window (400)', async () => {
    const analyst = await account(['analyst']);
    for (const query of ['from=2026-13-01', 'from=yesterday', 'from=2026-09-10&to=2026-09-01', 'from=2024-01-01&to=2026-01-01']) {
      const res = await enforced.app.inject({ method: 'GET', url: `/admin/analytics/funnels?${query}`, cookies: analyst.cookies });
      expect(res.statusCode, query).toBe(400);
    }
  });

  it('defaults to the last 30 days, both ends inclusive', () => {
    const window = parseAnalyticsWindow({}, new Date('2026-10-02T15:00:00Z'));
    expect(window.from.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    expect(window.toExclusive.toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });
});

describe('who may read and export', () => {
  it('analysts and administrators read; customers, other staff and visitors do not', async () => {
    const url = '/admin/analytics/funnels';
    const get = (who: Account | null) => enforced.app.inject({ method: 'GET', url, ...(who ? { cookies: who.cookies } : {}) });
    expect((await get(null)).statusCode).toBe(401);
    expect((await get(await account())).statusCode).toBe(403);
    expect((await get(await account(['support']))).statusCode).toBe(403);
    expect((await get(await account(['analyst']))).statusCode).toBe(200);
    expect((await get(await account(['administrator']))).statusCode).toBe(200);
  });

  it('exports the window as CSV: stored fields only, never an email, bounded', async () => {
    const analyst = await account(['analyst']);
    const customer = await account();
    await event(customer.id, 'credit_purchase_completed', '2026-09-13T10:02:00Z', { packCode: 'starter', totalCredits: 120 });
    await event(customer.id, 'credit_spend', '2026-09-13T11:00:00Z', { amount: 50 });
    const url = '/admin/analytics/events/export.csv?from=2026-09-01&to=2026-09-30';
    expect((await enforced.app.inject({ method: 'GET', url, cookies: (await account()).cookies })).statusCode).toBe(403);
    const res = await enforced.app.inject({ method: 'GET', url, cookies: analyst.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['x-export-truncated']).toBe('false');
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('occurred_at,name,source,user_id,properties');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('credit_purchase_completed');
    expect(lines[1]).toContain(customer.id);
    expect(res.body).not.toContain(customer.email);
    expect(ANALYTICS_EXPORT_MAX).toBeLessThanOrEqual(10_000);
  });
});
