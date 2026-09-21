import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomerContentAccess, CustomerContentUnlock } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import type { SafeUser } from '../services/auth-service.js';
import { retireContentOffer, setContentOffer } from '../services/commercial-boundary.js';
import { readOwnedAssetIds } from '../services/content-ownership.js';
import { refundContentUnlock, unlockContent } from '../services/content-unlock-service.js';
import { uploadLibraryAsset } from '../services/library-upload-service.js';
import { approveVisualAsset } from '../services/visual-asset-service.js';
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
 * PRD v1.2 P8.2 -- unlocking Credit-priced content, and keeping it.
 *
 * The customer pays the content's own price and owns it from then on. Every
 * rule around that belongs to a phase that already exists: P4.2 decides whether
 * it CAN be unlocked, P4.1's offer says what it costs, P2 moves the Credits
 * through P7.1. What is proven here is that those fit together atomically, that
 * a retry never charges twice, and that ownership outlives everything
 * commercial.
 *
 * `live` has the economy on; `dark` is the production default. Every price and
 * Credit figure below is test data.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const ON = { enabled: true };
const ACTOR = '00000000-0000-4000-8000-000000000001';

let dark: TestContext;
let live: TestContext;
let seq = 0;

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  const { db, pool } = createDb(TEST_DATABASE_URL);
  live = { app: await buildApp({ ...testEnv, commerce: { ...testEnv.commerce, enabled: true } }, db), db, pool };
});
afterAll(async () => {
  for (const ctx of [dark, live]) await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateAll(dark);
  await seedCharacters(dark.db);
  await seedVisualIdentities(dark.db);
});

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  dark.pool.query<T & import('pg').QueryResultRow>(text, params);

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

interface Account {
  id: string;
  cookies: Record<string, string>;
}

async function account(admin = false): Promise<Account> {
  const email = `p82-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'unlock-pass-1' } });
  expect(res.statusCode).toBe(201);
  const id = (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
  if (admin) await q(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
  const cookie = extractSessionCookie(res)!;
  return { id, cookies: { [cookie.name]: cookie.value } };
}

/** Only the id is ever read by what is under test; the rest is not this suite's subject. */
const asUser = (id: string) => ({ id, email: 'fixture@example.com', role: 'user' }) as SafeUser;

/** An approved clip, released to the character's Posts -- content a customer can meet. */
async function publishedClip(operator: Account): Promise<string> {
  const created = await uploadLibraryAsset(dark.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, originalName: 'clip.png' });
  const approved = await approveVisualAsset(dark.db, created.id);
  const released = await dark.app.inject({ method: 'POST', url: `/admin/content/assets/${approved.id}/publish`, cookies: operator.cookies });
  expect(released.statusCode, released.body).toBe(200);
  return approved.id;
}

/** Raw P2.1 ledger rows: granting Credits is not a P8.2 operation. */
async function fund(userId: string, amount: number) {
  await q("INSERT INTO wallets (user_id, currency) VALUES ($1, 'credits') ON CONFLICT DO NOTHING", [userId]);
  if (amount > 0) {
    await q(
      `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
       VALUES ($1, 'credits', 'grant', 'credit', $2, 'purchased', $3)`,
      [userId, amount, `fixture:${randomUUID()}`],
    );
  }
}

async function premiumPlanVersion(): Promise<string> {
  const existing = await q<{ id: string }>('SELECT id FROM economy_plans WHERE code = $1', ['premium_monthly']);
  const planId = existing.rows[0]?.id ?? (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', ['premium_monthly'])).rows[0]!.id;
  const versionId = (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits)
       VALUES ($1, 1, 'Fixture plan', 1, 1111, 'USD', 11) RETURNING id`,
      [planId],
    )
  ).rows[0]!.id;
  await q(`UPDATE economy_plan_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`, [versionId, ACTOR]);
  return versionId;
}

/** A funded customer and a Credit-priced clip of hers, ready to unlock. */
async function priced(price = 50, credits = 100): Promise<{ customer: Account; clip: string; offerId: string }> {
  const operator = await account(true);
  const customer = await account();
  const clip = await publishedClip(operator);
  const offer = await setContentOffer(dark.db, ON, { assetId: clip, state: 'credit', creditPrice: price });
  await fund(customer.id, credits);
  return { customer, clip, offerId: offer.id };
}

const walletOf = async (userId: string) =>
  (await q<{ balance: number; held: number }>("SELECT balance, held FROM wallets WHERE user_id = $1 AND currency = 'credits'", [userId])).rows[0] ?? {
    balance: 0,
    held: 0,
  };

const entitlements = async (userId?: string) =>
  (
    await q<{ n: number }>(
      userId
        ? 'SELECT count(*)::int AS n FROM content_entitlements WHERE user_id = $1 AND revoked_at IS NULL'
        : 'SELECT count(*)::int AS n FROM content_entitlements WHERE revoked_at IS NULL',
      userId ? [userId] : [],
    )
  ).rows[0]!.n;

const paidActionRows = async () =>
  (await q<{ status: string; amount: number; price_source: string; price_ref_id: string }>('SELECT status, amount, price_source, price_ref_id FROM paid_actions')).rows;

const ledger = async (userId: string) =>
  (await q<{ entry_type: string; amount: number }>('SELECT entry_type, amount FROM wallet_transactions WHERE user_id = $1 ORDER BY sequence', [userId])).rows;

/* ---- the endpoint ---- */

const unlockVia = (ctx: TestContext, who: Account, assetId: string, body: Record<string, unknown> = { idempotencyKey: 'buy-1' }) =>
  ctx.app.inject({ method: 'POST', url: `/api/content/${assetId}/unlock`, cookies: who.cookies, payload: body });

const accessOf = async (who: Account, assetId: string): Promise<CustomerContentAccess> => {
  const res = await live.app.inject({ method: 'GET', url: `/api/content/access?assetIds=${assetId}`, cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: CustomerContentAccess[] }).items[0]!;
};

/* ------------------------------------------------------------------ *
 * 1. The endpoint's contract
 * ------------------------------------------------------------------ */

describe('the unlock endpoint', () => {
  it('needs a session (401)', async () => {
    const { clip } = await priced();
    const res = await live.app.inject({ method: 'POST', url: `/api/content/${clip}/unlock`, payload: { idempotencyKey: 'k' } });
    expect(res.statusCode).toBe(401);
  });

  it('is dark until the economy is switched on, and unlocks nothing while it is off', async () => {
    const { customer, clip } = await priced();
    const res = await unlockVia(dark, customer, clip);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'economy_unavailable' });
    expect(await entitlements()).toBe(0);
    expect(await walletOf(customer.id)).toMatchObject({ balance: 100, held: 0 });
  });

  it('refuses a request without an idempotency key (400), charging nothing', async () => {
    const { customer, clip } = await priced();
    const res = await unlockVia(live, customer, clip, {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
    expect(await walletOf(customer.id)).toMatchObject({ balance: 100, held: 0 });
  });

  it('answers 404 for content that is not there, and for content the customer could never reach', async () => {
    const { customer } = await priced();
    expect((await unlockVia(live, customer, randomUUID())).statusCode).toBe(404);
    // An approved clip that was never released.
    const created = await uploadLibraryAsset(dark.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, originalName: 'private.png' });
    const unreleased = await approveVisualAsset(dark.db, created.id);
    await setContentOffer(dark.db, ON, { assetId: unreleased.id, state: 'credit', creditPrice: 10 });
    expect((await unlockVia(live, customer, unreleased.id)).statusCode).toBe(404);
    expect(await entitlements()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The unlock itself
 * ------------------------------------------------------------------ */

describe('unlocking Credit-priced content', () => {
  it('charges the server price, records the ownership, and says exactly what was bought', async () => {
    const { customer, clip, offerId } = await priced(50, 100);
    const res = await unlockVia(live, customer, clip);
    expect(res.statusCode, res.body).toBe(200);

    const unlock = res.json() as CustomerContentUnlock;
    expect(Object.keys(unlock).sort()).toEqual(['acquiredAt', 'assetId', 'creditPrice', 'entitlementId', 'offerId', 'replayed']);
    expect(unlock).toMatchObject({ assetId: clip, offerId, creditPrice: 50, replayed: false });

    // The Credits are gone -- consumed, not merely reserved.
    expect(await walletOf(customer.id)).toMatchObject({ balance: 50, held: 0 });
    expect(await ledger(customer.id)).toEqual([
      { entry_type: 'grant', amount: 100 },
      { entry_type: 'hold', amount: 50 },
      { entry_type: 'capture', amount: 50 },
    ]);
    expect((await reconcileWallet(live.db, customer.id, 'credits')).status).toBe('clean');
  });

  it('pins the offer that priced it on the paid action, and captures it', async () => {
    const { customer, clip, offerId } = await priced(50);
    await unlockVia(live, customer, clip);
    expect(await paidActionRows()).toEqual([{ status: 'captured', amount: 50, price_source: 'content_offer', price_ref_id: offerId }]);
  });

  it('takes no price from the customer: a body naming one is ignored', async () => {
    const { customer, clip } = await priced(50, 100);
    const res = await unlockVia(live, customer, clip, { idempotencyKey: 'buy-1', creditPrice: 1, amount: 1, price: 1 });
    expect((res.json() as CustomerContentUnlock).creditPrice).toBe(50);
    expect(await walletOf(customer.id)).toMatchObject({ balance: 50 });
  });

  it('opens the content afterwards: the resolver says it is owned', async () => {
    const { customer, clip } = await priced(50);
    expect((await accessOf(customer, clip)).decision).toBe('credits_required');
    await unlockVia(live, customer, clip);
    expect(await accessOf(customer, clip)).toMatchObject({ decision: 'owned', state: 'credit', creditPrice: 50 });
  });

  it('refuses when the Credits are not there (402), and charges nothing', async () => {
    const { customer, clip } = await priced(50, 10);
    const res = await unlockVia(live, customer, clip);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'insufficient_credits' });
    expect(await entitlements()).toBe(0);
    expect(await walletOf(customer.id)).toMatchObject({ balance: 10, held: 0 });
    expect(await paidActionRows()).toEqual([]);
  });

  /**
   * THE CUSTOMER WHO HAS NEVER HELD A CREDIT.
   *
   * She has no wallet ROW at all, which is a different shape from a wallet
   * holding zero -- and the wallet says so with `wallet_not_found`, not
   * `insufficient_credits`. Only the second was translated, so the first
   * escaped as a 500 while P4.2 was already answering the same customer
   * `insufficient_credits`. The resolver and the unlock have to agree, and
   * "you have no Credits yet" is a customer's ordinary state, not an error.
   */
  it('refuses a customer who has never held Credits the same way, not a server error', async () => {
    const operator = await account(true);
    const customer = await account();
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ON, { assetId: clip, state: 'credit', creditPrice: 50 });

    const wallets = await q<{ n: number }>("SELECT count(*)::int AS n FROM wallets WHERE user_id = $1", [customer.id]);
    expect(wallets.rows[0]!.n, 'this customer must have no wallet row at all').toBe(0);
    expect((await accessOf(customer, clip)).decision).toBe('insufficient_credits');

    const res = await unlockVia(live, customer, clip);
    expect(res.statusCode, res.body).toBe(402);
    expect(res.json()).toMatchObject({ error: 'insufficient_credits' });
    expect(await entitlements()).toBe(0);
    expect(await paidActionRows()).toEqual([]);
  });

  it.each([
    ['free content', { state: 'free' as const }, 409, 'not_purchasable'],
    ['Premium content', { state: 'premium' as const }, 403, 'premium_required'],
    ['withdrawn content', { state: 'unavailable' as const }, 404, 'unavailable'],
    ['content with an age floor', { state: 'credit' as const, creditPrice: 20, ageFloor: 21 }, 403, 'age_restricted'],
  ])('refuses to sell %s', async (_label, terms, status, code) => {
    const operator = await account(true);
    const customer = await account();
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ON, { assetId: clip, ...terms });
    await fund(customer.id, 100);

    const res = await unlockVia(live, customer, clip);
    expect(res.statusCode, res.body).toBe(status);
    expect(res.json()).toMatchObject({ error: code });
    expect(await entitlements()).toBe(0);
    expect(await walletOf(customer.id)).toMatchObject({ balance: 100, held: 0 });
  });

  it('charges what the offer says NOW, not what it said before', async () => {
    const operator = await account(true);
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ON, { assetId: clip, state: 'credit', creditPrice: 20 });
    const early = await account();
    await fund(early.id, 100);
    expect(((await unlockVia(live, early, clip)).json() as CustomerContentUnlock).creditPrice).toBe(20);

    await setContentOffer(dark.db, ON, { assetId: clip, state: 'credit', creditPrice: 70 });
    const later = await account();
    await fund(later.id, 100);
    expect(((await unlockVia(live, later, clip)).json() as CustomerContentUnlock).creditPrice).toBe(70);
    expect(await walletOf(early.id)).toMatchObject({ balance: 80 });
    expect(await walletOf(later.id)).toMatchObject({ balance: 30 });
  });
});

/* ------------------------------------------------------------------ *
 * 3. Idempotency: never twice
 * ------------------------------------------------------------------ */

describe('a retry never charges twice or owns twice', () => {
  it('the same key returns the same purchase and moves nothing', async () => {
    const { customer, clip } = await priced(50, 100);
    const first = (await unlockVia(live, customer, clip)).json() as CustomerContentUnlock;
    const again = (await unlockVia(live, customer, clip)).json() as CustomerContentUnlock;

    expect(again).toEqual({ ...first, replayed: true });
    expect(await entitlements(customer.id)).toBe(1);
    expect(await walletOf(customer.id)).toMatchObject({ balance: 50, held: 0 });
    expect(await ledger(customer.id)).toHaveLength(3);
  });

  it('a DIFFERENT key for content already owned charges nothing either', async () => {
    const { customer, clip } = await priced(50, 100);
    const first = (await unlockVia(live, customer, clip)).json() as CustomerContentUnlock;
    const res = await unlockVia(live, customer, clip, { idempotencyKey: 'buy-2' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...first, replayed: true });
    expect(await entitlements(customer.id)).toBe(1);
    expect(await walletOf(customer.id)).toMatchObject({ balance: 50 });
    expect(await paidActionRows()).toHaveLength(1);
  });

  it('concurrent requests under one key buy it once', async () => {
    const { customer, clip } = await priced(50, 100);
    const results = await Promise.all(Array.from({ length: 5 }, () => unlockVia(live, customer, clip)));
    for (const res of results) expect(res.statusCode, res.body).toBe(200);

    const ids = new Set(results.map((r) => (r.json() as CustomerContentUnlock).entitlementId));
    expect(ids.size).toBe(1);
    expect(await entitlements(customer.id)).toBe(1);
    expect(await walletOf(customer.id)).toMatchObject({ balance: 50, held: 0 });
    expect((await reconcileWallet(live.db, customer.id, 'credits')).status).toBe('clean');
  });

  it('concurrent requests under DIFFERENT keys still buy it once, and charge once', async () => {
    const { customer, clip } = await priced(50, 100);
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((key) => unlockVia(live, customer, clip, { idempotencyKey: key })),
    );
    for (const res of results) expect(res.statusCode, res.body).toBe(200);

    expect(new Set(results.map((r) => (r.json() as CustomerContentUnlock).entitlementId)).size).toBe(1);
    expect(await entitlements(customer.id)).toBe(1);
    // Exactly one purchase reached the wallet; every losing attempt rolled back whole.
    expect(await walletOf(customer.id)).toMatchObject({ balance: 50, held: 0 });
    expect((await ledger(customer.id)).filter((r) => r.entry_type === 'capture')).toHaveLength(1);
    expect((await reconcileWallet(live.db, customer.id, 'credits')).status).toBe('clean');
  });

  it('never leaves ownership without a captured payment, or a capture without ownership', async () => {
    const { customer, clip } = await priced(50, 100);
    await Promise.all([unlockVia(live, customer, clip), unlockVia(live, customer, clip, { idempotencyKey: 'other' })]);

    const orphans = await q<{ n: number }>(`
      SELECT count(*)::int AS n FROM content_entitlements e
        JOIN paid_actions p ON p.id = e.paid_action_id
       WHERE e.revoked_at IS NULL AND (p.status <> 'captured' OR p.amount <> e.credit_price)`);
    expect(orphans.rows[0]!.n).toBe(0);
    const unclaimed = await q<{ n: number }>(`
      SELECT count(*)::int AS n FROM paid_actions p
       WHERE p.price_source = 'content_offer' AND p.status = 'captured'
         AND NOT EXISTS (SELECT 1 FROM content_entitlements e WHERE e.paid_action_id = p.id)`);
    expect(unclaimed.rows[0]!.n).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Ownership outlives everything commercial
 * ------------------------------------------------------------------ */

describe('what is bought stays bought', () => {
  it('survives a Premium lapse and an empty wallet', async () => {
    const { customer, clip } = await priced(50, 100);
    const planVersionId = await premiumPlanVersion();
    await q("INSERT INTO subscriptions (user_id, plan_version_id, status, current_period_end) VALUES ($1, $2, 'active', now() + interval '30 days')", [
      customer.id,
      planVersionId,
    ]);
    await unlockVia(live, customer, clip);
    expect((await accessOf(customer, clip)).decision).toBe('owned');

    // Premium ends, and the remaining Credits are spent elsewhere.
    await q("UPDATE subscriptions SET status = 'expired', current_period_end = now() - interval '1 day' WHERE user_id = $1", [customer.id]);
    await q(
      `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
       VALUES ($1, 'credits', 'paid_action', 'debit', 50, 'purchased', $2)`,
      [customer.id, `spend:${randomUUID()}`],
    );
    expect(await walletOf(customer.id)).toMatchObject({ balance: 0 });
    expect((await accessOf(customer, clip)).decision).toBe('owned');
  });

  it('survives the content being re-priced under a new offer', async () => {
    const { customer, clip } = await priced(50, 100);
    await unlockVia(live, customer, clip);
    // The operator retires the offer and writes a dearer one.
    await setContentOffer(dark.db, ON, { assetId: clip, state: 'credit', creditPrice: 500 });
    expect((await accessOf(customer, clip)).decision).toBe('owned');
    // And a customer who never bought it faces the new price.
    const other = await account();
    await fund(other.id, 100);
    expect(await accessOf(other, clip)).toMatchObject({ decision: 'insufficient_credits', creditPrice: 500 });
  });

  it('survives the offer being retired altogether', async () => {
    const { customer, clip, offerId } = await priced(50, 100);
    await unlockVia(live, customer, clip);
    await retireContentOffer(dark.db, ON, offerId);
    expect((await accessOf(customer, clip)).decision).toBe('owned');
  });

  it('is one customer\'s alone', async () => {
    const { customer, clip } = await priced(50, 100);
    await unlockVia(live, customer, clip);
    const other = await account();
    await fund(other.id, 100);
    expect((await accessOf(other, clip)).decision).toBe('credits_required');
    expect(await readOwnedAssetIds(live.db, other.id, [clip])).toEqual(new Set());
    expect(await readOwnedAssetIds(live.db, customer.id, [clip])).toEqual(new Set([clip]));
  });

  it('still cannot bypass withdrawal or an age floor -- neither is a commercial condition', async () => {
    const { customer, clip } = await priced(50, 100);
    await unlockVia(live, customer, clip);

    await setContentOffer(dark.db, ON, { assetId: clip, state: 'credit', creditPrice: 50, ageFloor: 21 });
    expect((await accessOf(customer, clip)).decision).toBe('age_restricted');
    await setContentOffer(dark.db, ON, { assetId: clip, state: 'unavailable' });
    expect((await accessOf(customer, clip)).decision).toBe('unavailable');
  });
});

/* ------------------------------------------------------------------ *
 * 5. Reversing a purchase
 * ------------------------------------------------------------------ */

describe('refunding an unlock', () => {
  it('returns the Credits and takes the content back, together', async () => {
    const { customer, clip } = await priced(50, 100);
    await unlockVia(live, customer, clip);

    const { entitlementId } = await refundContentUnlock(live.db, ON, { userId: customer.id, assetId: clip, reason: 'bought by mistake' });
    expect(entitlementId).toBeTruthy();
    expect(await walletOf(customer.id)).toMatchObject({ balance: 100, held: 0 });
    expect(await entitlements(customer.id)).toBe(0);
    expect((await accessOf(customer, clip)).decision).toBe('credits_required');
    expect((await reconcileWallet(live.db, customer.id, 'credits')).status).toBe('clean');
  });

  it('keeps the revoked purchase as history, and lets the customer buy it again', async () => {
    const { customer, clip } = await priced(50, 100);
    await unlockVia(live, customer, clip);
    await refundContentUnlock(live.db, ON, { userId: customer.id, assetId: clip, reason: 'bought by mistake' });

    const rows = await q<{ revoke_reason: string }>('SELECT revoke_reason FROM content_entitlements WHERE revoked_at IS NOT NULL');
    expect(rows.rows).toEqual([{ revoke_reason: 'bought by mistake' }]);

    const again = await unlockVia(live, customer, clip, { idempotencyKey: 'buy-again' });
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as CustomerContentUnlock).replayed).toBe(false);
    expect(await walletOf(customer.id)).toMatchObject({ balance: 50 });
    expect(await entitlements(customer.id)).toBe(1);
  });

  it('does not let the refunded request be replayed into ownership again', async () => {
    const { customer, clip } = await priced(50, 100);
    await unlockVia(live, customer, clip);
    await refundContentUnlock(live.db, ON, { userId: customer.id, assetId: clip, reason: 'bought by mistake' });

    // The ORIGINAL key. Its paid action exists and was refunded, so replaying
    // it must not hand back the ownership that was taken away.
    const res = await unlockVia(live, customer, clip);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: 'purchase_reversed' });
    expect(await entitlements(customer.id)).toBe(0);
    expect(await walletOf(customer.id)).toMatchObject({ balance: 100, held: 0 });
    expect((await accessOf(customer, clip)).decision).toBe('credits_required');
  });

  it('refuses to refund content the customer does not own, and needs a reason', async () => {
    const { customer, clip } = await priced(50, 100);
    await expect(refundContentUnlock(live.db, ON, { userId: customer.id, assetId: clip, reason: 'nope' })).rejects.toMatchObject({
      name: 'ContentUnlockError',
      code: 'not_owned',
    });
    await unlockVia(live, customer, clip);
    await expect(refundContentUnlock(live.db, ON, { userId: customer.id, assetId: clip, reason: '  ' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('is refused while the economy is off', async () => {
    const { customer, clip } = await priced(50, 100);
    await unlockVia(live, customer, clip);
    await expect(refundContentUnlock(live.db, { enabled: false }, { userId: customer.id, assetId: clip, reason: 'x' })).rejects.toMatchObject({
      code: 'economy_disabled',
    });
    expect(await entitlements(customer.id)).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 6. The service, directly
 * ------------------------------------------------------------------ */

describe('the unlock service', () => {
  it('refuses a malformed request before touching anything', async () => {
    const { customer } = await priced();
    for (const request of [
      { assetId: 'not-an-id', idempotencyKey: 'k' },
      { assetId: randomUUID(), idempotencyKey: '   ' },
      { assetId: randomUUID(), idempotencyKey: 'x'.repeat(201) },
    ]) {
      await expect(unlockContent(live.db, ON, asUser(customer.id), request)).rejects.toMatchObject({
        name: 'ContentUnlockError',
        code: 'invalid_request',
      });
    }
    expect(await paidActionRows()).toEqual([]);
  });

  it('is refused while the economy is off, before any read', async () => {
    const { customer, clip } = await priced();
    await expect(unlockContent(live.db, { enabled: false }, asUser(customer.id), { assetId: clip, idempotencyKey: 'k' })).rejects.toMatchObject({
      code: 'economy_disabled',
    });
    expect(await entitlements()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 7. The boundaries P8.2 must keep
 * ------------------------------------------------------------------ */

describe('ownership stays where it belongs', () => {
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

  it('only one module names the entitlements table', () => {
    const ENTITLEMENTS = /\bcontentEntitlements\b|\bcontent_entitlements\b/;
    const offenders = application().filter((rel) => rel !== 'db/schema.ts' && rel !== 'services/content-ownership.ts' && ENTITLEMENTS.test(read(rel)));
    expect(offenders).toEqual([]);
    expect(ENTITLEMENTS.test(read('services/content-ownership.ts'))).toBe(true);
  });

  it('the unlock service decides no access for itself: it asks the P4.2 resolver', () => {
    const source = read('services/content-unlock-service.ts');
    expect(source).toMatch(/import \{ readContentAccess \} from '\.\/content-access\.js'/);
    // No reachability, tier, subscription or balance rule restated here.
    expect(source).not.toMatch(/publiclyReachableCondition|characterPostsCondition|resolveSubscription|readCommercialWallet|characterVisualAssets/);
  });

  it('it prices nothing itself: the price comes from the live offer, inside the charge', () => {
    const source = read('services/content-unlock-service.ts');
    expect(source).toMatch(/liveOfferFor/);
    // No arithmetic on a price, and no price taken from a request.
    expect(source).not.toMatch(/creditPrice\s*[*+\-/]|request\.creditPrice|body\.creditPrice/);
  });

  it('it moves no Credits of its own: every movement is P7.1\'s', () => {
    const source = read('services/content-unlock-service.ts');
    expect(source).not.toMatch(/\b(holdCredits|captureHold|releaseHold|refundTransaction|reverseTransaction|adjustWallet)\b/);
    expect(source).toMatch(/beginPaidAction/);
    expect(source).toMatch(/capturePaidAction/);
  });

  it('nothing else in the application unlocks content', () => {
    const callers = application().filter((rel) => rel !== 'services/content-unlock-service.ts' && /content-unlock-service/.test(read(rel)));
    expect(callers).toEqual(['routes/customer-economy.ts']);
  });
});
