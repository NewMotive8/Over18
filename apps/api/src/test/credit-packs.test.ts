import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  CustomerCheckout,
  CustomerCommercialState,
  CustomerEconomyCatalog,
  CustomerPackOffer,
  CustomerPaymentView,
  SimulatedPaymentResult,
} from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { savePackDraft, validatePack } from '../services/economy-admin-service.js';
import { effectivePackTerms } from '../services/pack-terms.js';
import { CREDITS_CURRENCY, holdCredits } from '../services/wallet-service.js';
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
 * Credit packs (Credits Store PR 1): buying Credits, on top of -- and apart
 * from -- Premium.
 *
 * Runs against the FAKE provider, like payments.test.ts: the simulated event
 * goes through the same signature check, store-first event log and
 * exactly-once application a real processor's webhook will.
 *
 * What is proven: a pack is configured in the economy catalog (badge, bonus,
 * promotion), the store's catalog and the checkout agree on the price at every
 * instant, the terms are locked at checkout, and a confirmed payment awards
 * the Credits bought and the bonus as two separate ledger entries -- once.
 */

const ACTOR = '00000000-0000-4000-8000-000000000001';
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
  await seedPlan();
});

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  dark.pool.query<T & import('pg').QueryResultRow>(text, params);

/* ------------------------------------------------------------------ *
 * Fixtures -- packs published and in effect, as the admin would leave them
 * ------------------------------------------------------------------ */

async function seedPlan() {
  const planId = (await q<{ id: string }>("INSERT INTO economy_plans (code) VALUES ('premium_monthly') RETURNING id")).rows[0]!.id;
  const versionId = (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions
         (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, is_purchasable)
       VALUES ($1, 1, 'Premium monthly', 1, 1299, 'USD', $2, true) RETURNING id`,
      [planId, INCLUDED_CREDITS],
    )
  ).rows[0]!.id;
  await q(`UPDATE economy_plan_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`, [versionId, ACTOR]);
}

interface PackSeed {
  code: string;
  credits: number;
  priceMinor: number;
  bonusCredits?: number;
  badge?: string | null;
  wasPriceMinor?: number | null;
  /** SQL for the promotion end, e.g. `now() + interval '1 day'`; null for none. */
  promotionEndsSql?: string | null;
  isPurchasable?: boolean;
}

/** Publishes a new version of a pack (creating the pack the first time), in effect now. */
async function publishPack(p: PackSeed): Promise<void> {
  let packId = (await q<{ id: string }>('SELECT id FROM economy_packs WHERE code = $1', [p.code])).rows[0]?.id;
  if (!packId) packId = (await q<{ id: string }>('INSERT INTO economy_packs (code) VALUES ($1) RETURNING id', [p.code])).rows[0]!.id;
  const version = Number((await q<{ n: number }>('SELECT coalesce(max(version), 0) + 1 AS n FROM economy_pack_versions WHERE pack_id = $1', [packId])).rows[0]!.n);
  const versionId = (
    await q<{ id: string }>(
      `INSERT INTO economy_pack_versions
         (pack_id, version, display_name, credits, price_minor, currency, sort_order, is_best_value, is_purchasable,
          badge, bonus_credits, was_price_minor, promotion_ends_at)
       VALUES ($1, $2, $3, $4, $5, 'USD', 0, false, $6, $7, $8, $9, ${p.promotionEndsSql ?? 'NULL'}) RETURNING id`,
      [packId, version, `${p.credits} Credits`, p.credits, p.priceMinor, p.isPurchasable ?? true, p.badge ?? null, p.bonusCredits ?? 0, p.wasPriceMinor ?? null],
    )
  ).rows[0]!.id;
  await q(`UPDATE economy_pack_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`, [versionId, ACTOR]);
}

interface Account {
  id: string;
  cookies: Record<string, string>;
}

async function account(): Promise<Account> {
  const email = `packs-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'pack-pass-1' } });
  expect(res.statusCode).toBe(201);
  const id = (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
  const cookie = extractSessionCookie(res)!;
  return { id, cookies: { [cookie.name]: cookie.value } };
}

/* ------------------------------------------------------------------ *
 * The endpoints
 * ------------------------------------------------------------------ */

const checkoutPack = (who: Account, packCode: string, over: Record<string, unknown> = {}) =>
  live.app.inject({
    method: 'POST',
    url: '/api/payments/checkout',
    cookies: who.cookies,
    payload: { packCode, method: 'apple_pay', idempotencyKey: `pack-${packCode}-${++seq}`, ...over },
  });

const checkoutPlan = (who: Account) =>
  live.app.inject({
    method: 'POST',
    url: '/api/payments/checkout',
    cookies: who.cookies,
    payload: { planCode: 'premium_monthly', method: 'apple_pay', idempotencyKey: `plan-${++seq}`, returnUrl: '/subscription' },
  });

const simulate = (who: Account, checkoutRef: string, outcome: string, over: Record<string, unknown> = {}) =>
  live.app.inject({ method: 'POST', url: '/api/payments/simulate', cookies: who.cookies, payload: { checkoutRef, outcome, ...over } });

async function startedPack(who: Account, packCode: string, over: Record<string, unknown> = {}): Promise<CustomerCheckout> {
  const res = await checkoutPack(who, packCode, over);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CustomerCheckout;
}

async function confirm(who: Account, checkoutRef: string, over: Record<string, unknown> = {}): Promise<SimulatedPaymentResult> {
  const res = await simulate(who, checkoutRef, 'success', over);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SimulatedPaymentResult;
}

async function catalogPack(who: Account, code: string): Promise<CustomerPackOffer> {
  const res = await live.app.inject({ method: 'GET', url: '/api/economy/catalog', cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  const pack = (res.json() as CustomerEconomyCatalog).packs.find((p) => p.code === code);
  expect(pack, `pack ${code} in the catalog`).toBeTruthy();
  return pack!;
}

/* ---- what the server actually holds afterwards ---- */

const walletOf = async (userId: string) =>
  (await q<{ balance: number }>("SELECT balance FROM wallets WHERE user_id = $1 AND currency = 'credits'", [userId])).rows[0]?.balance ?? 0;

const ledgerOf = async (userId: string) =>
  (
    await q<{ entry_type: string; amount: number; credit_class: string; source_type: string | null; source_id: string | null }>(
      'SELECT entry_type, amount, credit_class, source_type, source_id FROM wallet_transactions WHERE user_id = $1 ORDER BY sequence',
      [userId],
    )
  ).rows;

const paymentOf = async (id: string) =>
  (
    await q<{ status: string; kind: string; amount_minor: number; terms: Record<string, unknown>; context: Record<string, unknown> }>(
      'SELECT status, kind, amount_minor, terms, context FROM payments WHERE id = $1',
      [id],
    )
  ).rows[0]!;

/* ------------------------------------------------------------------ *
 * Buying a pack
 * ------------------------------------------------------------------ */

describe('a confirmed Credit pack purchase', () => {
  it('with no bonus: adds the Credits bought, as ONE purchased entry, and settles the payment', async () => {
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999 });
    const customer = await account();
    const { checkoutRef, payment } = await startedPack(customer, 'starter');

    // A started checkout is not a purchase.
    expect(payment).toMatchObject({ status: 'pending', kind: 'credit_pack', productRef: 'starter', amountMinor: 999, currency: 'USD' });
    expect(payment.pack).toEqual({ packCode: 'starter', packVersion: 1, displayName: '100 Credits', credits: 100, bonusCredits: 0, totalCredits: 100 });
    expect(await walletOf(customer.id)).toBe(0);

    expect((await confirm(customer, checkoutRef)).status).toBe('processed');

    expect(await walletOf(customer.id)).toBe(100);
    expect(await ledgerOf(customer.id)).toEqual([
      { entry_type: 'purchase', amount: 100, credit_class: 'purchased', source_type: 'payment', source_id: payment.id },
    ]);
    expect((await paymentOf(payment.id)).status).toBe('succeeded');
  });

  it('with a bonus: adds purchased and bonus Credits as two entries of the same payment, shown as one balance', async () => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, bonusCredits: 100, badge: 'Best value' });
    const customer = await account();
    const { checkoutRef, payment } = await startedPack(customer, 'plus');
    expect(payment.pack).toMatchObject({ credits: 750, bonusCredits: 100, totalCredits: 850 });

    await confirm(customer, checkoutRef);

    // +750 purchased, +100 bonus -- never the bonus recorded as purchased.
    expect(await ledgerOf(customer.id)).toEqual([
      { entry_type: 'purchase', amount: 750, credit_class: 'purchased', source_type: 'payment', source_id: payment.id },
      { entry_type: 'grant', amount: 100, credit_class: 'bonus', source_type: 'payment', source_id: payment.id },
    ]);
    // The customer sees one number; the sources stay apart underneath.
    const state = (await live.app.inject({ method: 'GET', url: '/api/me/commercial-state', cookies: customer.cookies })).json() as CustomerCommercialState;
    expect(state.wallet).toEqual({
      available: true,
      value: { included: 0, earned: 0, purchased: 750, bonus: 100, held: 0, spendable: 850 },
    });
  });

  it('is open to an active Premium subscriber, without subscribing again, and keeps the included Credits apart', async () => {
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999 });
    const customer = await account();
    const plan = (await checkoutPlan(customer)).json() as CustomerCheckout;
    await confirm(customer, plan.checkoutRef);

    const pack = await startedPack(customer, 'starter');
    await confirm(customer, pack.checkoutRef);

    expect(await walletOf(customer.id)).toBe(INCLUDED_CREDITS + 100);
    expect((await ledgerOf(customer.id)).map((r) => [r.entry_type, r.credit_class, r.amount])).toEqual([
      ['grant', 'included', INCLUDED_CREDITS],
      ['purchase', 'purchased', 100],
    ]);
    // Still exactly one subscription: a pack never touches it.
    expect((await q('SELECT 1 FROM subscriptions WHERE user_id = $1', [customer.id])).rowCount).toBe(1);
  });
});

describe('a pack payment that does not succeed', () => {
  it.each(['failure', 'cancel'])('%s: awards 0 Credits and writes no ledger entry', async (outcome) => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, bonusCredits: 100 });
    const customer = await account();
    const { checkoutRef, payment } = await startedPack(customer, 'plus');

    const res = await simulate(customer, checkoutRef, outcome);
    expect(res.statusCode, res.body).toBe(200);

    expect(await walletOf(customer.id)).toBe(0);
    expect(await ledgerOf(customer.id)).toEqual([]);
    expect((await paymentOf(payment.id)).status).not.toBe('succeeded');

    // And it cannot be turned into a success afterwards.
    await simulate(customer, checkoutRef, 'success');
    expect(await ledgerOf(customer.id)).toEqual([]);
  });
});

describe('a repeated payment notification awards the purchase once', () => {
  it('the same event again changes nothing -- neither the purchased nor the bonus Credits', async () => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, bonusCredits: 100 });
    const customer = await account();
    const { checkoutRef } = await startedPack(customer, 'plus');
    const eventRef = `evt-${randomUUID()}`;

    expect((await confirm(customer, checkoutRef, { eventRef })).status).toBe('processed');
    expect((await confirm(customer, checkoutRef, { eventRef })).status).toBe('replayed');

    expect(await walletOf(customer.id)).toBe(850);
    expect(await ledgerOf(customer.id)).toHaveLength(2);
  });

  it('a DIFFERENT event for the settled payment awards nothing either', async () => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, bonusCredits: 100 });
    const customer = await account();
    const { checkoutRef } = await startedPack(customer, 'plus');
    await confirm(customer, checkoutRef, { eventRef: `evt-${randomUUID()}` });
    await confirm(customer, checkoutRef, { eventRef: `evt-${randomUUID()}` });

    expect(await walletOf(customer.id)).toBe(850);
    expect(await ledgerOf(customer.id)).toHaveLength(2);
  });

  it('concurrent deliveries apply the whole award once', async () => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, bonusCredits: 100 });
    const customer = await account();
    const { checkoutRef } = await startedPack(customer, 'plus');
    await Promise.all(Array.from({ length: 5 }, (_, i) => simulate(customer, checkoutRef, 'success', { eventRef: `evt-race-${seq}-${i}` })));

    expect(await walletOf(customer.id)).toBe(850);
    expect((await ledgerOf(customer.id)).map((r) => r.credit_class).sort()).toEqual(['bonus', 'purchased']);
  });

  it('a double-tapped checkout opens one payment, not two', async () => {
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999 });
    const customer = await account();
    const first = await startedPack(customer, 'starter', { idempotencyKey: 'tap-tap' });
    const second = await startedPack(customer, 'starter', { idempotencyKey: 'tap-tap' });
    expect(second).toMatchObject({ replayed: true, checkoutRef: first.checkoutRef });
    expect((await q('SELECT 1 FROM payments WHERE user_id = $1', [customer.id])).rowCount).toBe(1);
  });
});

describe('the terms are locked at checkout', () => {
  it('a price, Credit or bonus change published after checkout does not alter the purchase', async () => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, bonusCredits: 100 });
    const customer = await account();
    const { checkoutRef, payment } = await startedPack(customer, 'plus');

    // The operator reprices the pack while the customer is at the processor.
    await publishPack({ code: 'plus', credits: 500, priceMinor: 6999, bonusCredits: 0 });
    expect(await catalogPack(customer, 'plus')).toMatchObject({ version: 2, credits: 500, priceMinor: 6999 });

    await confirm(customer, checkoutRef);

    expect((await ledgerOf(customer.id)).map((r) => [r.credit_class, r.amount])).toEqual([
      ['purchased', 750],
      ['bonus', 100],
    ]);
    const stored = await paymentOf(payment.id);
    expect(stored.amount_minor).toBe(4999);
    // The snapshot accounting and support will read.
    expect(stored.terms).toMatchObject({
      packCode: 'plus',
      packVersion: 1,
      credits: 750,
      bonusCredits: 100,
      priceMinor: 4999,
      currency: 'USD',
      wasPriceMinor: null,
      promotionEndsAt: null,
    });
  });

  it('a pack retired after checkout is still awarded on the terms paid for', async () => {
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999 });
    const customer = await account();
    const { checkoutRef } = await startedPack(customer, 'starter');
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999, isPurchasable: false });

    await confirm(customer, checkoutRef);
    expect(await walletOf(customer.id)).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * Promotions: shown only when real, charged the same as shown
 * ------------------------------------------------------------------ */

describe('a pack promotion', () => {
  it('in effect: the catalog shows the struck-through price and the end, and the checkout charges the promotional price', async () => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, wasPriceMinor: 7999, promotionEndsSql: "now() + interval '1 day'" });
    const customer = await account();

    const offer = await catalogPack(customer, 'plus');
    expect(offer).toMatchObject({ priceMinor: 4999, wasPriceMinor: 7999 });
    expect(Date.parse(offer.promotionEndsAt!)).toBeGreaterThan(Date.now());

    const { payment } = await startedPack(customer, 'plus');
    expect(payment.amountMinor).toBe(4999);
    expect((await paymentOf(payment.id)).terms).toMatchObject({ priceMinor: 4999, wasPriceMinor: 7999 });
  });

  it('with no end: shows the struck-through price and no countdown', async () => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, wasPriceMinor: 7999 });
    const customer = await account();
    expect(await catalogPack(customer, 'plus')).toMatchObject({ priceMinor: 4999, wasPriceMinor: 7999, promotionEndsAt: null });
  });

  it('ended: shows no promotion at all, and the regular price is the price -- in the catalog and at checkout', async () => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, wasPriceMinor: 7999, promotionEndsSql: "now() - interval '1 minute'" });
    const customer = await account();

    expect(await catalogPack(customer, 'plus')).toMatchObject({ priceMinor: 7999, wasPriceMinor: null, promotionEndsAt: null });

    const { payment, checkoutRef } = await startedPack(customer, 'plus');
    expect(payment.amountMinor).toBe(7999);
    await confirm(customer, checkoutRef);
    expect(await walletOf(customer.id)).toBe(750);
  });

  it('none configured: no was price and no end, whatever the badge says', async () => {
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999, badge: 'Most popular' });
    const customer = await account();
    expect(await catalogPack(customer, 'starter')).toMatchObject({
      priceMinor: 999,
      wasPriceMinor: null,
      promotionEndsAt: null,
      badge: 'Most popular',
      bonusCredits: 0,
      totalCredits: 100,
    });
  });

  it('the rule itself: an end at the instant counts as ended', () => {
    const at = '2026-10-01T12:00:00.000000Z';
    const pack = { priceMinor: 4999, wasPriceMinor: 7999, promotionEndsAt: at, credits: 750, bonusCredits: 50 };
    expect(effectivePackTerms(pack, '2026-10-01T11:59:59.999999Z')).toMatchObject({ priceMinor: 4999, wasPriceMinor: 7999, promotionEndsAt: at });
    expect(effectivePackTerms(pack, at)).toMatchObject({ priceMinor: 7999, wasPriceMinor: null, promotionEndsAt: null, totalCredits: 800 });
  });
});

describe('a promotion must be real to be configured', () => {
  const base = { displayName: 'Plus', credits: 750, priceMinor: 4999, currency: 'USD', sortOrder: 0, isBestValue: false, isPurchasable: true };

  it('refuses a was price not above the price, an end without a was price, and an over-long badge', () => {
    expect(validatePack({ ...base, wasPriceMinor: 4999 })).toEqual([expect.stringMatching(/wasPriceMinor must be higher/)]);
    expect(validatePack({ ...base, promotionEndsAt: '2030-01-01T00:00:00Z' })).toEqual([expect.stringMatching(/promotionEndsAt needs a wasPriceMinor/)]);
    expect(validatePack({ ...base, badge: 'x'.repeat(41) })).toEqual([expect.stringMatching(/badge/)]);
    expect(validatePack({ ...base, bonusCredits: -1 })).toEqual([expect.stringMatching(/bonusCredits/)]);
    expect(validatePack({ ...base, badge: 'Best value', bonusCredits: 100, wasPriceMinor: 7999, promotionEndsAt: '2030-01-01T00:00:00Z' })).toEqual([]);
  });

  it('the database refuses them too, whoever writes', async () => {
    const packId = (await q<{ id: string }>("INSERT INTO economy_packs (code) VALUES ('raw') RETURNING id")).rows[0]!.id;
    const insert = (extra: string) =>
      q(`INSERT INTO economy_pack_versions (pack_id, version, display_name, credits, price_minor, currency, ${extra.split('=')[0]})
         VALUES ($1, 1, 'Raw', 100, 999, 'USD', ${extra.split('=')[1]})`, [packId]);
    await expect(insert('was_price_minor=999')).rejects.toThrow(/economy_pack_versions_was_price/);
    await expect(insert("promotion_ends_at=now()")).rejects.toThrow(/economy_pack_versions_promotion_needs_was_price/);
    await expect(insert('bonus_credits=-5')).rejects.toThrow(/economy_pack_versions_bonus_credits/);
  });

  it('an admin draft keeps every new field, as entered', async () => {
    const saved = await savePackDraft(
      dark.db,
      'plus',
      { ...base, badge: 'Best value', bonusCredits: 100, wasPriceMinor: 7999, promotionEndsAt: '2030-01-01T10:00:00.000Z' },
      { actor: { userId: ACTOR, email: 'admin@example.com' }, reason: 'test', requestId: null },
    );
    expect(saved).toMatchObject({ badge: 'Best value', bonusCredits: 100, wasPriceMinor: 7999 });
    expect(Date.parse(saved.promotionEndsAt!)).toBe(Date.parse('2030-01-01T10:00:00.000Z'));
  });
});

/* ------------------------------------------------------------------ *
 * Where the purchase started -- kept, validated, never a URL
 * ------------------------------------------------------------------ */

describe('the purchase context', () => {
  it('travels with the payment and comes back with it', async () => {
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999 });
    const customer = await account();
    const assetId = randomUUID();
    const conversationId = randomUUID();
    const { payment } = await startedPack(customer, 'starter', {
      context: { origin: 'chat', originAction: 'content_unlock', assetId, conversationId, somethingElse: 'dropped' },
    });
    const context = { origin: 'chat', originAction: 'content_unlock', assetId, conversationId, characterId: null };
    expect(payment.context).toEqual(context);
    expect((await paymentOf(payment.id)).context).toEqual(context);

    const read = (await live.app.inject({ method: 'GET', url: `/api/payments/${payment.id}`, cookies: customer.cookies })).json() as CustomerPaymentView;
    expect(read.context).toEqual(context);
  });

  it('refuses values outside the fixed lists, and ids that are not ids', async () => {
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999 });
    const customer = await account();
    for (const context of [{ origin: 'https://evil.example' }, { originAction: 'transfer' }, { assetId: '../../etc' }, 'chat']) {
      const res = await checkoutPack(customer, 'starter', { context });
      expect(res.statusCode, JSON.stringify(context)).toBe(400);
    }
    expect((await q('SELECT 1 FROM payments')).rowCount).toBe(0);
  });

  it('a pack always returns to the Credits Store; no checkout returns to another site', async () => {
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999 });
    const customer = await account();
    const { redirectUrl } = await startedPack(customer, 'starter', { returnUrl: 'https://evil.example/steal' });
    expect(new URL(redirectUrl!).searchParams.get('return')).toBe('/credits');

    for (const returnUrl of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const res = await live.app.inject({
        method: 'POST',
        url: '/api/payments/checkout',
        cookies: customer.cookies,
        payload: { planCode: 'premium_monthly', method: 'apple_pay', idempotencyKey: `plan-${++seq}`, returnUrl },
      });
      expect(res.statusCode, returnUrl).toBe(400);
    }
  });
});

describe('checkout refusals', () => {
  it('an unknown pack, a retired pack, both a plan and a pack, or neither', async () => {
    await publishPack({ code: 'retired', credits: 100, priceMinor: 999, isPurchasable: false });
    const customer = await account();
    expect((await checkoutPack(customer, 'no_such_pack')).statusCode).toBe(404);
    expect((await checkoutPack(customer, 'retired')).statusCode).toBe(409);
    expect((await checkoutPack(customer, 'retired', { planCode: 'premium_monthly' })).statusCode).toBe(400);
    const neither = await live.app.inject({
      method: 'POST',
      url: '/api/payments/checkout',
      cookies: customer.cookies,
      payload: { method: 'apple_pay', idempotencyKey: 'k' },
    });
    expect(neither.statusCode).toBe(400);
  });

  it('takes no price, Credits or bonus from the client', async () => {
    await publishPack({ code: 'starter', credits: 100, priceMinor: 999 });
    const customer = await account();
    const { payment } = await startedPack(customer, 'starter', { amountMinor: 1, credits: 99999, bonusCredits: 99999 });
    expect(payment).toMatchObject({ amountMinor: 999, pack: { credits: 100, bonusCredits: 0 } });
  });
});

/* ------------------------------------------------------------------ *
 * Spending: promotional Credits before paid ones
 * ------------------------------------------------------------------ */

describe('the spend order', () => {
  it('spends bonus Credits first, then included, and purchased Credits last', async () => {
    await publishPack({ code: 'plus', credits: 750, priceMinor: 4999, bonusCredits: 20 });
    const customer = await account();
    const plan = (await checkoutPlan(customer)).json() as CustomerCheckout;
    await confirm(customer, plan.checkoutRef);
    const pack = await startedPack(customer, 'plus');
    await confirm(customer, pack.checkoutRef);

    const hold = (amount: number) =>
      holdCredits(dark.db, { userId: customer.id, currency: CREDITS_CURRENCY, amount, idempotencyKey: `hold-${randomUUID()}` });

    expect((await hold(10)).transaction.creditClass).toBe('bonus');
    expect((await hold(10)).transaction.creditClass).toBe('bonus');
    // Bonus is spent; the subscription's Credits come next, before anything paid for.
    expect((await hold(10)).transaction.creditClass).toBe('included');
    expect((await hold(INCLUDED_CREDITS - 10)).transaction.creditClass).toBe('included');
    expect((await hold(10)).transaction.creditClass).toBe('purchased');
  });
});
