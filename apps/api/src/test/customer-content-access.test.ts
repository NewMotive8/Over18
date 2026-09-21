import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CustomerContentAccess, CustomerContentAccessResponse } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { setContentOffer } from '../services/commercial-boundary.js';
import { CONTENT_ACCESS_MAX_IDS } from '../services/content-access.js';
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
 * PRD v1.2 P4.2 -- GET /api/content/access: what a signed-in customer may do
 * with the content they are looking at.
 *
 * The content's terms are P4.1's (free / premium / credit / unavailable, a
 * whole-Credit price, an age floor); the customer's tier and Credits are
 * P3.1's. This endpoint only decides; it charges nothing, unlocks nothing and
 * tells the customer nothing about the wallet behind their Credits.
 *
 * `live` has the economy on; `dark` is the production default. Every price,
 * Credit figure and age below is test data.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE = { storageDir: testEnv.media.storageDir, servePathPrefix: '/admin/content/uploads' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const ECONOMY_ON = { enabled: true };
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

interface Account {
  id: string;
  cookies: Record<string, string>;
}

/** A signed-in customer; staff when `admin` is set (to publish content). */
async function account(admin = false): Promise<Account> {
  const email = `p42-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'access-pass-1' } });
  expect(res.statusCode).toBe(201);
  const id = (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
  if (admin) await q(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
  const cookie = extractSessionCookie(res)!;
  return { id, cookies: { [cookie.name]: cookie.value } };
}

/** An approved clip, released to the character's Posts -- content a customer can meet. */
async function publishedClip(operator: Account): Promise<string> {
  const created = await uploadLibraryAsset(dark.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, originalName: 'clip.png' });
  const approved = await approveVisualAsset(dark.db, created.id);
  const released = await dark.app.inject({ method: 'POST', url: `/admin/content/assets/${approved.id}/publish`, cookies: operator.cookies });
  expect(released.statusCode, released.body).toBe(200);
  return approved.id;
}

/** An approved clip that was never released: a customer cannot reach it. */
async function unreleasedClip(): Promise<string> {
  const created = await uploadLibraryAsset(dark.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, originalName: 'private.png' });
  return (await approveVisualAsset(dark.db, created.id)).id;
}

/* ---- P3.1 fixtures: a subscription and Credits ---- */

async function planVersion(code = 'premium_monthly'): Promise<string> {
  const existing = await q<{ id: string }>('SELECT id FROM economy_plans WHERE code = $1', [code]);
  const planId = existing.rows[0]?.id ?? (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
  return (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits)
       VALUES ($1, 1, 'Fixture plan', 1, 1111, 'USD', 11) RETURNING id`,
      [planId],
    )
  ).rows[0]!.id;
}
/** A published plan version: the only kind P3.1 resolves. */
async function premiumPlanVersion(): Promise<string> {
  const versionId = await planVersion();
  await q(`UPDATE economy_plan_versions SET status = 'published', published_by = $2, publish_reason = 'test' WHERE id = $1`, [versionId, ACTOR]);
  return versionId;
}
async function makePremium(userId: string, planVersionId: string, status = 'active') {
  await q("INSERT INTO subscriptions (user_id, plan_version_id, status, current_period_end) VALUES ($1, $2, $3, now() + interval '30 days')", [
    userId,
    planVersionId,
    status,
  ]);
}
/** Raw P2.1 ledger rows: granting Credits is not a P4.2 operation. */
async function fund(userId: string, amount: number) {
  await q("INSERT INTO wallets (user_id, currency) VALUES ($1, 'credits') ON CONFLICT DO NOTHING", [userId]);
  await q(
    `INSERT INTO wallet_transactions (user_id, currency, entry_type, direction, amount, credit_class, idempotency_key)
     VALUES ($1, 'credits', 'grant', 'credit', $2, 'purchased', $3)`,
    [userId, amount, `fixture:${randomUUID()}`],
  );
}

/* ---- the endpoint ---- */

const ACCESS = (ids: string[]) => `/api/content/access?assetIds=${ids.join(',')}`;
const ask = async (who: Account, ids: string[], ctx: TestContext = live) => {
  const res = await ctx.app.inject({ method: 'GET', url: ACCESS(ids), cookies: who.cookies });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as CustomerContentAccessResponse).items;
};
const one = async (who: Account, id: string): Promise<CustomerContentAccess> => (await ask(who, [id]))[0]!;

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

describe('the access endpoint', () => {
  it('needs a session (401) and never names another account', async () => {
    const operator = await account(true);
    const clip = await publishedClip(operator);
    expect((await live.app.inject({ method: 'GET', url: ACCESS([clip]) })).statusCode).toBe(401);
  });

  it('answers one entry per asset asked about, in order, with exactly the agreed fields', async () => {
    const operator = await account(true);
    const customer = await account();
    const first = await publishedClip(operator);
    const second = await publishedClip(operator);
    const items = await ask(customer, [second, first]);
    expect(items.map((i) => i.assetId)).toEqual([second, first]);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['ageFloor', 'assetId', 'creditPrice', 'decision', 'state']);
  });

  it('collapses duplicates, accepts repeated or comma-separated ids, and matches ids whatever their case', async () => {
    const operator = await account(true);
    const customer = await account();
    const clip = await publishedClip(operator);
    // Marked Free so the decision under test is about id handling, not access.
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state: 'free' });
    expect(await ask(customer, [clip, clip])).toHaveLength(1);
    const repeated = await live.app.inject({ method: 'GET', url: `/api/content/access?assetIds=${clip}&assetIds=${randomUUID()}`, cookies: customer.cookies });
    expect((repeated.json() as CustomerContentAccessResponse).items).toHaveLength(2);
    expect((await one(customer, clip.toUpperCase())).decision).toBe('open');
  });

  it('refuses a malformed request (400)', async () => {
    const customer = await account();
    for (const query of ['', '?assetIds=', '?assetIds=not-an-id', `?assetIds=${randomUUID()},nope`, `?assetIds=${Array.from({ length: CONTENT_ACCESS_MAX_IDS + 1 }, () => randomUUID()).join(',')}`]) {
      const res = await live.app.inject({ method: 'GET', url: `/api/content/access${query}`, cookies: customer.cookies });
      expect(res.statusCode, query).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    }
  });

  it('tells the customer nothing about the wallet behind their Credits', async () => {
    const operator = await account(true);
    const customer = await account();
    await fund(customer.id, 500);
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state: 'credit', creditPrice: 50 });
    const res = await live.app.inject({ method: 'GET', url: ACCESS([clip]), cookies: customer.cookies });
    expect(res.body).not.toMatch(/wallet|ledger|held|spendable|balance|included|earned|purchased|offer|economy_ref/i);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});

/* ------------------------------------------------------------------ *
 * The four states, and who is asking
 * ------------------------------------------------------------------ */

describe('each P4.1 state, for each kind of customer', () => {
  it('content marked Free opens for everyone', async () => {
    const operator = await account(true);
    const free = await account();
    const premium = await account();
    await makePremium(premium.id, await premiumPlanVersion());
    const explicit = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: explicit, state: 'free' });
    for (const who of [free, premium]) {
      expect(await one(who, explicit)).toEqual({ assetId: explicit, state: 'free', creditPrice: null, ageFloor: null, decision: 'open' });
    }
  });

  /**
   * P4.D2: content nobody classified is PREMIUM, so the customer resolver locks
   * it for a Free customer and opens it for a subscriber -- without a single
   * offer row existing for it.
   */
  it('content nobody classified is Premium: locked for Free, open for Premium', async () => {
    const operator = await account(true);
    const free = await account();
    const premium = await account();
    await makePremium(premium.id, await premiumPlanVersion());
    const unpriced = await publishedClip(operator);

    expect(await one(free, unpriced)).toEqual({ assetId: unpriced, state: 'premium', creditPrice: null, ageFloor: null, decision: 'premium_required' });
    expect((await one(premium, unpriced)).decision).toBe('open');
  });

  it('premium content opens for a Premium customer and asks everyone else for Premium', async () => {
    const operator = await account(true);
    const free = await account();
    const premium = await account();
    const version = await premiumPlanVersion();
    await makePremium(premium.id, version);
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state: 'premium' });

    expect(await one(free, clip)).toEqual({ assetId: clip, state: 'premium', creditPrice: null, ageFloor: null, decision: 'premium_required' });
    expect(await one(premium, clip)).toMatchObject({ state: 'premium', decision: 'open' });

    // The P3.1 states that keep Premium keep access; an expired one does not.
    for (const [status, decision] of [['past_due', 'open'], ['grace', 'open'], ['cancelled', 'open'], ['expired', 'premium_required']] as const) {
      const person = await account();
      await makePremium(person.id, version, status);
      expect((await one(person, clip)).decision, status).toBe(decision);
    }
  });

  it('credit content states its price, and says when the customer has too few Credits', async () => {
    const operator = await account(true);
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state: 'credit', creditPrice: 50 });

    const rich = await account();
    await fund(rich.id, 60);
    expect(await one(rich, clip)).toEqual({ assetId: clip, state: 'credit', creditPrice: 50, ageFloor: null, decision: 'credits_required' });

    const exact = await account();
    await fund(exact.id, 50);
    expect((await one(exact, clip)).decision).toBe('credits_required');

    const poor = await account();
    await fund(poor.id, 49);
    expect(await one(poor, clip)).toMatchObject({ creditPrice: 50, decision: 'insufficient_credits' });

    // A customer who has never had Credits has none: not enough, never "open".
    const fresh = await account();
    expect((await one(fresh, clip)).decision).toBe('insufficient_credits');

    // Premium does not pay for Credit content.
    const premium = await account();
    await makePremium(premium.id, await premiumPlanVersion());
    expect((await one(premium, clip)).decision).toBe('insufficient_credits');
  });

  it('unavailable content is unavailable for everyone, with no price', async () => {
    const operator = await account(true);
    const premium = await account();
    await makePremium(premium.id, await premiumPlanVersion());
    await fund(premium.id, 5000);
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state: 'unavailable' });
    expect(await one(premium, clip)).toEqual({ assetId: clip, state: 'unavailable', creditPrice: null, ageFloor: null, decision: 'unavailable' });
  });
});

/* ------------------------------------------------------------------ *
 * The age floor
 * ------------------------------------------------------------------ */

describe('an age floor', () => {
  it('outranks every other access: nobody meets one until age verification exists (P5)', async () => {
    const operator = await account(true);
    const premium = await account();
    await makePremium(premium.id, await premiumPlanVersion());
    await fund(premium.id, 5000);
    for (const [state, creditPrice] of [['free', null], ['premium', null], ['credit', 50]] as const) {
      const clip = await publishedClip(operator);
      await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state, creditPrice, ageFloor: 21 });
      expect(await one(premium, clip), state).toMatchObject({ state, ageFloor: 21, decision: 'age_restricted' });
    }
  });

  it('is absent when the content states none', async () => {
    const operator = await account(true);
    const customer = await account();
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state: 'premium' });
    expect((await one(customer, clip)).ageFloor).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Failing closed
 * ------------------------------------------------------------------ */

describe('anything unknown fails closed', () => {
  it('an id that names nothing, content never released, and private chat media are all unavailable', async () => {
    const customer = await account();
    const unknown = randomUUID();
    const unreleased = await unreleasedClip();
    const chat = (await approveVisualAsset(
      dark.db,
      (await uploadLibraryAsset(dark.db, STORAGE, { characterId: LUNA.id, mimeType: 'image/png', bytes: PNG, originalName: 'chat.png', kind: 'chat' })).id,
    )).id;
    for (const id of [unknown, unreleased, chat]) {
      expect(await one(customer, id), id).toEqual({ assetId: id, state: 'unavailable', creditPrice: null, ageFloor: null, decision: 'unavailable' });
    }
  });

  it('content withdrawn after release stops being available', async () => {
    const operator = await account(true);
    const customer = await account();
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state: 'free' });
    expect((await one(customer, clip)).decision).toBe('open');
    expect((await dark.app.inject({ method: 'POST', url: `/admin/content/assets/${clip}/unpublish`, cookies: operator.cookies })).statusCode).toBe(200);
    expect(await one(customer, clip)).toMatchObject({ state: 'unavailable', decision: 'unavailable' });
  });

  it('a subscription whose plan cannot be resolved is not Premium', async () => {
    const operator = await account(true);
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state: 'premium' });

    const resolvable = await account();
    await makePremium(resolvable.id, await premiumPlanVersion());
    expect((await one(resolvable, clip)).decision).toBe('open');

    // The same subscription, on a plan version that was never published: P3.1
    // reports it as unresolvable, and an unresolvable tier is never Premium.
    const unresolvable = await account();
    await makePremium(unresolvable.id, await planVersion('draft_only_plan'));
    expect((await one(unresolvable, clip)).decision).toBe('premium_required');
  });
});

/* ------------------------------------------------------------------ *
 * Dark, and read-only
 * ------------------------------------------------------------------ */

describe('while the economy is off', () => {
  it('answers 503 and resolves nothing', async () => {
    const operator = await account(true);
    const customer = await account();
    const clip = await publishedClip(operator);
    const res = await dark.app.inject({ method: 'GET', url: ACCESS([clip]), cookies: customer.cookies });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'economy_unavailable', reason: 'economy_disabled' });
    expect(res.body).not.toContain(clip);
  });
});

describe('deciding changes nothing', () => {
  it('no wallet, subscription, offer, asset or any other row moves', async () => {
    const operator = await account(true);
    const customer = await account();
    await fund(customer.id, 100);
    await makePremium(customer.id, await premiumPlanVersion());
    const free = await publishedClip(operator);
    const credit = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: credit, state: 'credit', creditPrice: 50, ageFloor: 21 });

    const snapshot = async () => {
      const tables = (await q<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
      const out: Record<string, string> = {};
      for (const t of tables) out[t] = (await q<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0]!.h;
      return out;
    };
    const before = await snapshot();
    await ask(customer, [free, credit, randomUUID()]);
    await ask(customer, [credit]);
    expect(await snapshot()).toEqual(before);
  });

  it("answers each customer for themselves, from their own session", async () => {
    const operator = await account(true);
    const clip = await publishedClip(operator);
    await setContentOffer(dark.db, ECONOMY_ON, { assetId: clip, state: 'premium' });
    const premium = await account();
    await makePremium(premium.id, await premiumPlanVersion());
    const free = await account();
    expect((await one(premium, clip)).decision).toBe('open');
    expect((await one(free, clip)).decision).toBe('premium_required');
  });
});
