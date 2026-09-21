import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomerCheckout, CustomerPaymentView, SimulatedPaymentResult } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { setContentOffer } from '../services/commercial-boundary.js';
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
 * PRD v1.2 P9.1 / P9.2 -- a payment becoming Premium and Credits.
 *
 * The processor is undecided (P9.D1), so these run against the FAKE provider --
 * which is the point: the simulated event goes through the same signature
 * check, the same store-first event log and the same exactly-once application
 * a real processor's webhook will. What is proven here is the commercial
 * behaviour, which does not change when the processor is chosen.
 *
 * `live` has the economy on and the fake provider selected; `dark` is the
 * production default. Every price and Credit figure is the P1.D1 launch ladder.
 */

const ACTOR = '00000000-0000-4000-8000-000000000001';
const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** P1.D1: the approved launch ladder, and 200 included Credits per cycle. */
const PLANS = [
  { code: 'premium_monthly', months: 1, priceMinor: 1299 },
  { code: 'premium_quarterly', months: 3, priceMinor: 2999 },
  { code: 'premium_annual', months: 12, priceMinor: 8999 },
] as const;
const INCLUDED_CREDITS = 200;

let dark: TestContext;
let live: TestContext;
let seq = 0;

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  const { db, pool } = createDb(TEST_DATABASE_URL);
  live = {
    app: await buildApp({ ...testEnv, commerce: { ...testEnv.commerce, enabled: true, paymentProvider: 'fake' } }, db),
    db,
    pool,
  };
});
afterAll(async () => {
  for (const ctx of [dark, live]) await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateAll(dark);
  await seedCharacters(dark.db);
  await seedVisualIdentities(dark.db);
  await seedPlans();
});

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  dark.pool.query<T & import('pg').QueryResultRow>(text, params);

/* ------------------------------------------------------------------ *
 * Fixtures -- the real P1 catalogue, published and in effect
 * ------------------------------------------------------------------ */

async function seedPlans() {
  for (const plan of PLANS) {
    const planId = (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [plan.code])).rows[0]!.id;
    const versionId = (
      await q<{ id: string }>(
        `INSERT INTO economy_plan_versions
           (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, is_purchasable)
         VALUES ($1, 1, $2, $3, $4, 'USD', $5, true) RETURNING id`,
        [planId, plan.code, plan.months, plan.priceMinor, INCLUDED_CREDITS],
      )
    ).rows[0]!.id;
    await q(`UPDATE economy_plan_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`, [versionId, ACTOR]);
  }
}

interface Account {
  id: string;
  cookies: Record<string, string>;
}

async function account(): Promise<Account> {
  const email = `p9-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'pay-pass-1' } });
  expect(res.statusCode).toBe(201);
  const id = (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
  const cookie = extractSessionCookie(res)!;
  return { id, cookies: { [cookie.name]: cookie.value } };
}

/* ------------------------------------------------------------------ *
 * The endpoints
 * ------------------------------------------------------------------ */

const checkout = (who: Account, planCode: string, over: Record<string, unknown> = {}, ctx: TestContext = live) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/payments/checkout',
    cookies: who.cookies,
    payload: { planCode, method: 'apple_pay', idempotencyKey: `buy-${planCode}-${seq}`, returnUrl: '/subscription', ...over },
  });

const simulate = (who: Account, checkoutRef: string, outcome: string, over: Record<string, unknown> = {}) =>
  live.app.inject({ method: 'POST', url: '/api/payments/simulate', cookies: who.cookies, payload: { checkoutRef, outcome, ...over } });

/** Start a checkout and return its reference. */
async function started(who: Account, planCode: string): Promise<CustomerCheckout> {
  const res = await checkout(who, planCode);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CustomerCheckout;
}

/* ---- what the server actually holds afterwards ---- */

const subscriptionOf = async (userId: string) =>
  (
    await q<{ status: string; code: string; months: number; period_days: number }>(
      `SELECT s.status, p.code, v.billing_period_months AS months,
              round(extract(epoch from (s.current_period_end - now())) / 86400)::int AS period_days
         FROM subscriptions s
         JOIN economy_plan_versions v ON v.id = s.plan_version_id
         JOIN economy_plans p ON p.id = v.plan_id
        WHERE s.user_id = $1`,
      [userId],
    )
  ).rows[0] ?? null;

const walletOf = async (userId: string) =>
  (await q<{ balance: number; held: number }>("SELECT balance, held FROM wallets WHERE user_id = $1 AND currency = 'credits'", [userId])).rows[0] ?? {
    balance: 0,
    held: 0,
  };

const ledgerOf = async (userId: string) =>
  (
    await q<{ entry_type: string; amount: number; credit_class: string }>(
      'SELECT entry_type, amount, credit_class FROM wallet_transactions WHERE user_id = $1 ORDER BY sequence',
      [userId],
    )
  ).rows;

const paymentRows = async () => (await q<{ status: string; product_ref: string }>('SELECT status, product_ref FROM payments')).rows;
const eventRows = async () =>
  (await q<{ type: string; signature_valid: boolean; processed_at: string | null }>('SELECT type, signature_valid, processed_at FROM payment_events')).rows;

/* ------------------------------------------------------------------ *
 * 1-3, 5. A successful purchase of each plan
 * ------------------------------------------------------------------ */

describe.each(PLANS)('a confirmed $code payment', (plan) => {
  it('activates Premium for the right period, grants the included Credits, and settles the payment', async () => {
    const customer = await account();
    const { checkoutRef, payment } = await started(customer, plan.code);

    // Nothing at all has happened yet: a started checkout is not a purchase.
    expect(payment.status).toBe('pending');
    expect(await subscriptionOf(customer.id)).toBeNull();
    expect(await walletOf(customer.id)).toMatchObject({ balance: 0 });

    const res = await simulate(customer, checkoutRef, 'success');
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as SimulatedPaymentResult).status).toBe('processed');

    // Premium, on the plan that was paid for, for that plan's period.
    const subscription = await subscriptionOf(customer.id);
    expect(subscription).toMatchObject({ status: 'active', code: plan.code, months: plan.months });
    // 1 month ~30d, 3 ~90d, 12 ~365d -- a few days' tolerance for month lengths.
    expect(Math.abs(subscription!.period_days - plan.months * 30.4)).toBeLessThan(6);

    // The included Credits, once, in the `included` class.
    expect(await walletOf(customer.id)).toMatchObject({ balance: INCLUDED_CREDITS, held: 0 });
    expect(await ledgerOf(customer.id)).toEqual([{ entry_type: 'grant', amount: INCLUDED_CREDITS, credit_class: 'included' }]);

    expect(await paymentRows()).toEqual([{ status: 'succeeded', product_ref: plan.code }]);
  });
});

/* ------------------------------------------------------------------ *
 * 4, 6. What the customer can then see and reach
 * ------------------------------------------------------------------ */

describe('after a confirmed payment', () => {
  it('reports Premium and the new balance through the existing commercial state', async () => {
    const customer = await account();
    const { checkoutRef } = await started(customer, 'premium_monthly');
    await simulate(customer, checkoutRef, 'success');

    const res = await live.app.inject({ method: 'GET', url: '/api/me/commercial-state', cookies: customer.cookies });
    expect(res.statusCode, res.body).toBe(200);
    const state = res.json() as {
      tier: { available: boolean; value?: string };
      subscription: { available: boolean; value?: { status: string; currentPeriodEnd: string } };
      wallet: { available: boolean; value?: { spendable: number; included: number } };
    };
    expect(state.tier).toMatchObject({ available: true, value: 'premium' });
    expect(state.subscription.value).toMatchObject({ status: 'active' });
    expect(new Date(state.subscription.value!.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now());
    expect(state.wallet.value).toMatchObject({ spendable: INCLUDED_CREDITS, included: INCLUDED_CREDITS });
  });

  it('opens Premium-priced content through the existing access resolver, with nothing unlocked by hand', async () => {
    const operator = await account();
    await q(`UPDATE users SET role = 'admin' WHERE id = $1`, [operator.id]);
    const customer = await account();

    // A real clip, through the real content workflow, priced Premium.
    const created = await uploadLibraryAsset(dark.db, STORAGE, {
      characterId: LUNA.id,
      mimeType: 'image/png',
      bytes: PNG,
      originalName: 'clip.png',
    });
    const approved = await approveVisualAsset(dark.db, created.id);
    const released = await dark.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${approved.id}/publish`,
      cookies: operator.cookies,
    });
    expect(released.statusCode, released.body).toBe(200);
    const assetId = approved.id;
    await setContentOffer(dark.db, { enabled: true }, { assetId, state: 'premium' });

    const ask = async () => {
      const res = await live.app.inject({ method: 'GET', url: `/api/content/access?assetIds=${assetId}`, cookies: customer.cookies });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { items: Array<{ decision: string }> }).items[0]!.decision;
    };

    expect(await ask()).toBe('premium_required');
    const { checkoutRef } = await started(customer, 'premium_monthly');
    await simulate(customer, checkoutRef, 'success');
    // Opened by the subscription alone -- no entitlement row was written.
    expect(await ask()).toBe('open');
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM content_entitlements')).rows[0]!.n).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Replays and duplicates
 * ------------------------------------------------------------------ */

describe('a replayed confirmation grants nothing twice', () => {
  it('the same event, delivered again, changes nothing', async () => {
    const customer = await account();
    const { checkoutRef } = await started(customer, 'premium_monthly');

    const first = await simulate(customer, checkoutRef, 'success');
    expect((first.json() as SimulatedPaymentResult).status).toBe('processed');
    const after = await walletOf(customer.id);

    // Same outcome -> same deterministic event reference -> a true redelivery.
    const again = await simulate(customer, checkoutRef, 'success');
    expect((again.json() as SimulatedPaymentResult).status).toBe('replayed');

    expect(await walletOf(customer.id)).toEqual(after);
    expect(await ledgerOf(customer.id)).toHaveLength(1);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM subscription_history')).rows[0]!.n).toBe(1);
    expect(await eventRows()).toHaveLength(1);
  });

  it('a DIFFERENT event for a payment already settled also grants nothing', async () => {
    const customer = await account();
    const { checkoutRef } = await started(customer, 'premium_monthly');
    await simulate(customer, checkoutRef, 'success');
    const after = await walletOf(customer.id);

    // A fresh delivery id: past the event store, stopped by the payment's status.
    const res = await simulate(customer, checkoutRef, 'success', { eventRef: `evt-${randomUUID()}` });
    expect((res.json() as SimulatedPaymentResult).status).toBe('processed');
    expect(await walletOf(customer.id)).toEqual(after);
    expect(await ledgerOf(customer.id)).toHaveLength(1);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM subscription_history')).rows[0]!.n).toBe(1);
  });

  it('concurrent deliveries of the same payment apply it once', async () => {
    const customer = await account();
    const { checkoutRef } = await started(customer, 'premium_monthly');

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => simulate(customer, checkoutRef, 'success', { eventRef: `evt-race-${i}` })),
    );
    for (const res of results) expect(res.statusCode, res.body).toBe(200);
    expect(await walletOf(customer.id)).toMatchObject({ balance: INCLUDED_CREDITS });
    expect(await ledgerOf(customer.id)).toHaveLength(1);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM subscription_history')).rows[0]!.n).toBe(1);
  });

  it('starting the same checkout twice opens one, not two', async () => {
    const customer = await account();
    const first = await started(customer, 'premium_monthly');
    const res = await checkout(customer, 'premium_monthly', { idempotencyKey: `buy-premium_monthly-${seq}` });
    const again = res.json() as CustomerCheckout;
    expect(again.replayed).toBe(true);
    expect(again.checkoutRef).toBe(first.checkoutRef);
    expect(await paymentRows()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 8, 9. Failure and cancellation
 * ------------------------------------------------------------------ */

describe.each([
  ['a failed payment', 'failure', 'failed'],
  ['a cancelled payment', 'cancel', 'failed'],
])('%s', (_label, outcome, expectedStatus) => {
  it('activates no Premium and grants no Credits', async () => {
    const customer = await account();
    const { checkoutRef } = await started(customer, 'premium_monthly');

    const res = await simulate(customer, checkoutRef, outcome);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as SimulatedPaymentResult).payment).toMatchObject({ status: expectedStatus });

    expect(await subscriptionOf(customer.id)).toBeNull();
    expect(await walletOf(customer.id)).toMatchObject({ balance: 0 });
    expect(await ledgerOf(customer.id)).toEqual([]);
  });

  it('cannot be turned into a success afterwards', async () => {
    const customer = await account();
    const { checkoutRef } = await started(customer, 'premium_monthly');
    await simulate(customer, checkoutRef, outcome);

    await simulate(customer, checkoutRef, 'success');
    expect(await subscriptionOf(customer.id)).toBeNull();
    expect(await walletOf(customer.id)).toMatchObject({ balance: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * The authority rules
 * ------------------------------------------------------------------ */

describe('only a signed provider event is authoritative', () => {
  it('a started checkout grants nothing, however often it is read', async () => {
    const customer = await account();
    const { checkoutRef, payment } = await started(customer, 'premium_annual');
    for (let i = 0; i < 3; i++) {
      const res = await live.app.inject({ method: 'GET', url: `/api/payments/${payment.id}`, cookies: customer.cookies });
      expect((res.json() as CustomerPaymentView).status).toBe('pending');
    }
    expect(await subscriptionOf(customer.id)).toBeNull();
    expect(checkoutRef).toBeTruthy();
  });

  it('a forged event is stored as evidence and never applied', async () => {
    const customer = await account();
    const { checkoutRef, payment } = await started(customer, 'premium_monthly');

    // Signed with the wrong secret: the shape is perfect, the signature is not.
    const { simulatePaymentEvent } = await import('../services/simulated-payment.js');
    const { createFakePaymentProvider } = await import('../commerce/fake-providers.js');
    const provider = createFakePaymentProvider({ secret: 'the-real-secret', checkoutBaseUrl: 'http://localhost' });
    const result = await simulatePaymentEvent(live.db, { enabled: true }, provider, 'a-different-secret', {
      checkoutRef,
      outcome: 'success',
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    });

    expect(result).toMatchObject({ status: 'rejected', reason: 'bad_signature' });
    expect(await subscriptionOf(customer.id)).toBeNull();
    expect(await walletOf(customer.id)).toMatchObject({ balance: 0 });
    // Stored, so a forgery leaves a trace rather than silence.
    expect(await eventRows()).toEqual([{ type: 'payment_succeeded', signature_valid: false, processed_at: null }]);
  });

  it('one customer cannot confirm another customer\'s checkout', async () => {
    const buyer = await account();
    const stranger = await account();
    const { checkoutRef } = await started(buyer, 'premium_monthly');

    const res = await simulate(stranger, checkoutRef, 'success');
    expect(res.statusCode).toBe(404);
    expect(await subscriptionOf(buyer.id)).toBeNull();
  });

  it('needs a session', async () => {
    const res = await live.app.inject({ method: 'POST', url: '/api/payments/checkout', payload: { planCode: 'premium_monthly' } });
    expect(res.statusCode).toBe(401);
  });

  it('takes no price from the client', async () => {
    const customer = await account();
    const res = await checkout(customer, 'premium_monthly', { amountMinor: 1, priceMinor: 1, currency: 'XXX' });
    const { payment } = res.json() as CustomerCheckout;
    expect(payment).toMatchObject({ amountMinor: 1299, currency: 'USD' });
  });

  it('refuses an unknown plan, a bad method and a missing key', async () => {
    const customer = await account();
    expect((await checkout(customer, 'not_a_plan')).statusCode).toBe(404);
    expect((await checkout(customer, 'premium_monthly', { method: 'bitcoin' })).statusCode).toBe(400);
    expect((await checkout(customer, 'premium_monthly', { idempotencyKey: '  ' })).statusCode).toBe(400);
  });

  it('refuses a second subscription while one is active', async () => {
    const customer = await account();
    const { checkoutRef } = await started(customer, 'premium_monthly');
    await simulate(customer, checkoutRef, 'success');

    const res = await checkout(customer, 'premium_annual', { idempotencyKey: 'second-go' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'already_subscribed' });
  });
});

/* ------------------------------------------------------------------ *
 * 10. The economy-off safety behaviour
 * ------------------------------------------------------------------ */

describe('the existing safety gates still hold', () => {
  it('every payment route is dark while the economy is off, and writes nothing', async () => {
    const customer = await account();
    for (const call of [
      dark.app.inject({ method: 'POST', url: '/api/payments/checkout', cookies: customer.cookies, payload: { planCode: 'premium_monthly', method: 'paypal', idempotencyKey: 'k', returnUrl: '/' } }),
      dark.app.inject({ method: 'POST', url: '/api/payments/simulate', cookies: customer.cookies, payload: { checkoutRef: 'chk_x', outcome: 'success' } }),
      dark.app.inject({ method: 'GET', url: `/api/payments/${randomUUID()}`, cookies: customer.cookies }),
    ]) {
      const res = await call;
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'economy_unavailable' });
    }
    expect(await paymentRows()).toEqual([]);
    expect(await eventRows()).toEqual([]);
  });

  it('a configured economy with NO provider still cannot take a payment', async () => {
    const { db, pool } = createDb(TEST_DATABASE_URL);
    const noProvider = await buildApp({ ...testEnv, commerce: { ...testEnv.commerce, enabled: true, paymentProvider: 'none' } }, db);
    const customer = await account();
    const res = await noProvider.inject({
      method: 'POST',
      url: '/api/payments/checkout',
      cookies: customer.cookies,
      payload: { planCode: 'premium_monthly', method: 'paypal', idempotencyKey: 'k', returnUrl: '/' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'payments_unavailable' });
    await noProvider.close();
    await pool.end();
  });
});

/* ------------------------------------------------------------------ *
 * The boundary that lets a real provider replace the simulation
 * ------------------------------------------------------------------ */

describe('the simulation is a provider, not a shortcut', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const read = (rel: string) => readFileSync(join(src, rel), 'utf8');
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
    });
  }
  const application = () => sourceFiles(src).map((path) => relative(src, path).split('\\').join('/'));

  /** What a module imports is the real signal; its prose is not. */
  const importsOf = (rel: string): string[] =>
    [...new Set([...read(rel).matchAll(/^import[^;]*? from '([^']+)'/gm)].map((m) => m[1]!))].sort();

  it('the simulator writes no commercial state of its own: it only makes an event', () => {
    expect(read('services/simulated-payment.ts')).toMatch(/ingestPaymentEvent/);
    // It reaches nothing commercial -- not the subscription service, not the
    // wallet, not content. Only the provider interface and the ingestion.
    expect(importsOf('services/simulated-payment.ts')).toEqual(
      [
        '../commerce/fake-providers.js',
        '../commerce/payment-provider.js',
        '../db/client.js',
        '../env.js',
        './payment-service.js',
        '@over18/shared',
        'node:crypto',
      ].sort(),
    );
  });

  it('only the payment service turns a payment into commercial state', () => {
    const callers = application().filter((rel) => /ingestPaymentEvent/.test(read(rel)));
    expect(callers.sort()).toEqual(['routes/customer-payments.ts', 'services/payment-service.ts', 'services/simulated-payment.ts']);
  });

  it('the payment service names no processor: it imports only the provider interface', () => {
    // No processor SDK, and not the fake provider either -- only the interface.
    expect(importsOf('services/payment-service.ts')).toEqual([
      '../commerce/payment-provider.js',
      '../db/client.js',
      '../env.js',
      '../db/schema.js',
      './economy-resolver.js',
      './subscription-service.js',
      './wallet-service.js',
      '@over18/shared',
      'drizzle-orm',
    ].sort());
    // Subscriptions and the wallet are reached through their services, never
    // by writing their tables here: the only schema objects it imports are its
    // own two. Asserted on the import rather than the file text, because the
    // prose above it names those tables when explaining why it avoids them.
    const schemaImport = read('services/payment-service.ts').match(/import \{([^}]*)\} from '\.\.\/db\/schema\.js'/)![1]!;
    expect(
      schemaImport
        .split(',')
        .map((name) => name.trim().replace(/^type /, ''))
        .filter(Boolean)
        .sort(),
    ).toEqual(['PaymentRow', 'paymentEvents', 'payments'].sort());
  });

  it('grants Credits only through the wallet service, and only the included class', () => {
    const source = read('services/payment-service.ts');
    expect(source).toMatch(/grantCredits/);
    expect(source).not.toMatch(/\b(holdCredits|captureHold|releaseHold|adjustWallet|reverseTransaction)\b/);
  });
});
