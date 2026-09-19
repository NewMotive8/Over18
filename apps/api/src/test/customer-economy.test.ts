import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CustomerCommercialState, CustomerEconomyCatalog } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { economyNow, resolvePackCatalog, resolvePlanCatalog } from '../services/economy-resolver.js';
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
 * The customer economy read API: GET /api/economy/catalog and
 * GET /api/me/commercial-state.
 *
 * Two apps over one database: `off` is the production default (ECONOMY_ENABLED
 * off, as every other suite runs), `on` has the economy switched on -- here and
 * nowhere else. Every price and Credit figure below is a TEST FIXTURE written
 * straight to the configuration tables; none is a business value.
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

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

type Cookies = Record<string, string>;
async function signIn(role: 'user' | 'admin' = 'user'): Promise<{ id: string; cookies: Cookies }> {
  const email = `customer-${process.pid}-${++seq}@example.com`;
  const res = await off.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'customer-pass-1' } });
  expect(res.statusCode).toBe(201);
  const cookie = extractSessionCookie(res)!;
  const [row] = await off.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (role === 'admin') await off.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
  return { id: row!.id, cookies: { [cookie.name]: cookie.value } };
}

const get = (ctx: TestContext, url: string, cookies?: Cookies, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url, headers, ...(cookies ? { cookies } : {}) });

const CATALOG = '/api/economy/catalog';
const STATE = '/api/me/commercial-state';
const ROUTES = [CATALOG, STATE];

/* ------------------------------------------------------------------ *
 * Configuration fixtures (drafts until published)
 * ------------------------------------------------------------------ */

const ACTOR = '00000000-0000-4000-8000-000000000001';

async function plan(code: string, version: number, over: { price?: number; credits?: number; purchasable?: boolean; features?: object } = {}) {
  const existing = await q<{ id: string }>('SELECT id FROM economy_plans WHERE code = $1', [code]);
  const planId =
    existing.rows[0]?.id ?? (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
  return (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions
         (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, features, is_purchasable)
       VALUES ($1, $2, 'Fixture plan', 1, $3, 'USD', $4, $5, $6) RETURNING id`,
      [planId, version, over.price ?? 1111, over.credits ?? 111, JSON.stringify(over.features ?? {}), over.purchasable ?? true],
    )
  ).rows[0]!.id;
}

async function pack(code: string, version: number, credits: number, priceMinor: number, sortOrder: number, bestValue = false) {
  const existing = await q<{ id: string }>('SELECT id FROM economy_packs WHERE code = $1', [code]);
  const packId =
    existing.rows[0]?.id ?? (await q<{ id: string }>('INSERT INTO economy_packs (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
  return (
    await q<{ id: string }>(
      `INSERT INTO economy_pack_versions (pack_id, version, display_name, credits, price_minor, currency, sort_order, is_best_value)
       VALUES ($1, $2, 'Fixture pack', $3, $4, 'USD', $5, $6) RETURNING id`,
      [packId, version, credits, priceMinor, sortOrder, bestValue],
    )
  ).rows[0]!.id;
}

async function ruleset(version: number) {
  const id = (await q<{ id: string }>('INSERT INTO economy_rulesets (version) VALUES ($1) RETURNING id', [version])).rows[0]!.id;
  await q(
    `INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, quality_tier, unit, credit_cost)
     VALUES ($1, 'image', 'standard', 'per_action', 7)`,
    [id],
  );
  return id;
}

type Table = 'economy_plan_versions' | 'economy_pack_versions' | 'economy_rulesets';
const publish = (table: Table, id: string, effectiveFrom: Date | null = null) =>
  q(`UPDATE ${table} SET status = 'published', effective_from = $2, published_by = $3, publish_reason = 'test' WHERE id = $1`, [
    id,
    effectiveFrom,
    ACTOR,
  ]);
const inFuture = async (interval: string) =>
  new Date((await q<{ t: Date }>(`SELECT clock_timestamp() + interval '${interval}' AS t`)).rows[0]!.t);

/** A small live economy: one plan, two packs, one ruleset -- all published now. */
async function liveEconomy() {
  await publish('economy_plan_versions', await plan('premium_monthly', 1, { price: 1299, credits: 300, features: { unlimited_text: true } }));
  await publish('economy_pack_versions', await pack('max', 1, 4500, 17999, 4, true));
  await publish('economy_pack_versions', await pack('starter', 1, 150, 999, 0));
  await publish('economy_rulesets', await ruleset(1));
}

/* ================================================================== *
 * Authentication
 * ================================================================== */

describe('every customer economy route requires a session', () => {
  it('refuses an anonymous caller, whether the economy is on or off', async () => {
    await liveEconomy();
    for (const ctx of [on, off]) {
      for (const url of ROUTES) {
        const res = await get(ctx, url);
        expect(res.statusCode, url).toBe(401);
        expect(res.json()).toEqual({ error: 'unauthorized', message: 'Authentication required.' });
      }
    }
  });

  it('refuses a session token that does not exist', async () => {
    const { cookies } = await signIn();
    const [name] = Object.keys(cookies);
    for (const url of ROUTES) expect((await get(on, url, { [name!]: 'not-a-real-session' })).statusCode, url).toBe(401);
  });
});

/* ================================================================== *
 * Dark by default
 * ================================================================== */

describe('while the economy is off -- the production default', () => {
  it('the suite default matches production: the switch is off', () => {
    expect(testEnv.commerce.enabled).toBe(false);
  });

  it('answers 503 economy_unavailable on every route, and shows nothing that is published', async () => {
    await liveEconomy();
    const { cookies } = await signIn();
    for (const url of ROUTES) {
      const res = await get(off, url, cookies);
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toEqual({ error: 'economy_unavailable', reason: 'economy_disabled', message: 'The economy is not available yet.' });
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body).not.toMatch(/premium_monthly|starter|1299|4500/);
    }
  });
});

/* ================================================================== *
 * GET /api/economy/catalog
 * ================================================================== */

describe('GET /api/economy/catalog', () => {
  it('serves exactly what the resolver says is in effect, field by field', async () => {
    await liveEconomy();
    const { cookies } = await signIn();
    const res = await get(on, CATALOG, cookies);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const catalog = res.json() as CustomerEconomyCatalog;

    const asOf = await economyNow(on.db);
    const [{ plans }, { packs }] = await Promise.all([resolvePlanCatalog(on.db, asOf), resolvePackCatalog(on.db, asOf)]);
    expect(catalog.plans).toEqual(
      plans.map((p) => ({
        code: p.ref.code,
        version: p.ref.version,
        versionId: p.ref.id,
        displayName: p.displayName,
        billingPeriodMonths: p.billingPeriodMonths,
        priceMinor: p.priceMinor,
        currency: p.currency,
        monthlyIncludedCredits: p.monthlyIncludedCredits,
        isPurchasable: p.isPurchasable,
        effectiveFrom: p.effectiveFrom,
      })),
    );
    // The resolver's ladder order: sort_order, then code.
    expect(catalog.packs.map((p) => [p.code, p.credits, p.priceMinor, p.sortOrder, p.isBestValue])).toEqual([
      ['starter', 150, 999, 0, false],
      ['max', 4500, 17999, 4, true],
    ]);
    expect(catalog.packs.map((p) => p.versionId)).toEqual(packs.map((p) => p.ref.id));
    expect(catalog.plans[0]).toMatchObject({ code: 'premium_monthly', priceMinor: 1299, monthlyIncludedCredits: 300 });
    // Stored plan features are machine rules for the server, never customer-facing.
    expect(catalog.plans[0]).not.toHaveProperty('features');
    expect(Date.parse(catalog.asOf)).not.toBeNaN();
  });

  it('publishes an allow-list: no lifecycle, audit or ruleset field reaches a customer', async () => {
    await liveEconomy();
    const catalog = (await get(on, CATALOG, (await signIn()).cookies)).json() as CustomerEconomyCatalog;
    expect(Object.keys(catalog).sort()).toEqual(['asOf', 'packs', 'plans']);
    expect(Object.keys(catalog.plans[0]!).sort()).toEqual(
      ['billingPeriodMonths', 'code', 'currency', 'displayName', 'effectiveFrom', 'isPurchasable', 'monthlyIncludedCredits', 'priceMinor', 'version', 'versionId'],
    );
    expect(Object.keys(catalog.packs[0]!).sort()).toEqual(
      ['code', 'credits', 'currency', 'displayName', 'effectiveFrom', 'isBestValue', 'isPurchasable', 'priceMinor', 'sortOrder', 'version', 'versionId'],
    );
    expect(JSON.stringify(catalog)).not.toMatch(/publish_reason|publishedBy|published_by|status|draft|creditCost|features|unlimited_text/);
  });

  it('never exposes a draft or a future-scheduled version -- though the admin preview can see them', async () => {
    await liveEconomy();
    await plan('premium_monthly', 2, { price: 2599 }); // a draft of a live plan
    await plan('draft_only', 1); // a plan that has never been published
    await pack('draft_pack', 1, 999, 1, 9); // a pack that has never been published
    const scheduled = await pack('starter', 2, 200, 999, 0);
    await publish('economy_pack_versions', scheduled, await inFuture('7 days'));
    await ruleset(2); // a drafted ruleset

    const catalog = (await get(on, CATALOG, (await signIn()).cookies)).json() as CustomerEconomyCatalog;
    expect(catalog.plans.map((p) => [p.code, p.version, p.priceMinor])).toEqual([['premium_monthly', 1, 1299]]);
    expect(catalog.packs.map((p) => [p.code, p.version])).toEqual([
      ['starter', 1],
      ['max', 1],
    ]);

    // The drafts are real: the admin preview, in drafted mode, does show them.
    const admin = await signIn('admin');
    const drafted = await on.app.inject({ method: 'POST', url: '/admin/economy/preview', payload: { mode: 'drafted' }, cookies: admin.cookies });
    expect(drafted.statusCode).toBe(200);
    expect((drafted.json() as { configuration: { plans: Array<{ code: string; version: number }> } }).configuration.plans).toContainEqual(
      expect.objectContaining({ code: 'premium_monthly', version: 2 }),
    );
  });

  it('lists a retired version as not purchasable, rather than hiding or offering it', async () => {
    await publish('economy_plan_versions', await plan('legacy_monthly', 1, { purchasable: false }));
    const catalog = (await get(on, CATALOG, (await signIn()).cookies)).json() as CustomerEconomyCatalog;
    expect(catalog.plans.map((p) => [p.code, p.isPurchasable])).toEqual([['legacy_monthly', false]]);
  });

  it('with nothing published, the catalog is empty -- never a sample', async () => {
    const res = await get(on, CATALOG, (await signIn()).cookies);
    expect(res.statusCode).toBe(200);
    const catalog = res.json() as CustomerEconomyCatalog;
    expect(catalog.plans).toEqual([]);
    expect(catalog.packs).toEqual([]);
  });

  it('ignores anything the client sends: no price, mode or instant is taken from the request', async () => {
    await liveEconomy();
    await plan('premium_monthly', 2, { price: 1 }); // a draft the request tries to reach
    const { cookies } = await signIn();
    const plain = (await get(on, CATALOG, cookies)).json() as CustomerEconomyCatalog;
    const tampered = (
      await get(on, `${CATALOG}?mode=drafted&priceMinor=1&credits=999999&asOf=2000-01-01T00:00:00Z&version=2`, cookies, {
        'x-economy-mode': 'drafted',
      })
    ).json() as CustomerEconomyCatalog;
    expect(tampered.plans).toEqual(plain.plans);
    expect(tampered.packs).toEqual(plain.packs);
  });

  it('answers only GET', async () => {
    const { cookies } = await signIn();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await on.app.inject({ method, url: CATALOG, cookies, payload: { priceMinor: 1 } });
      expect(res.statusCode, method).toBe(404);
    }
  });
});

/* ================================================================== *
 * GET /api/me/commercial-state
 * ================================================================== */

describe('GET /api/me/commercial-state', () => {
  it('states who the customer is, and that nothing else is known yet -- no placeholder values', async () => {
    const { id, cookies } = await signIn();
    const res = await get(on, STATE, cookies);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toEqual({
      viewer: { userId: id },
      economyEnabled: true,
      tier: { available: false, reason: 'subscriptions_not_supported' },
      subscription: { available: false, reason: 'subscriptions_not_supported' },
      wallet: { available: false, reason: 'wallet_not_supported' },
      age: { available: false, reason: 'age_verification_not_supported' },
    } satisfies CustomerCommercialState);
  });

  it("answers each customer with their own state, whatever they ask for", async () => {
    const alice = await signIn();
    const bob = await signIn();
    const asAlice = await get(on, `${STATE}?userId=${bob.id}`, alice.cookies, { 'x-user-id': bob.id });
    expect((asAlice.json() as CustomerCommercialState).viewer).toEqual({ userId: alice.id });
    expect(((await get(on, STATE, bob.cookies)).json() as CustomerCommercialState).viewer).toEqual({ userId: bob.id });
    expect((await get(on, `${STATE}/${bob.id}`, alice.cookies)).statusCode).toBe(404);
  });

  it('does not treat an administrator as Premium -- staff access is not a commercial tier', async () => {
    const admin = await signIn('admin');
    const state = (await get(on, STATE, admin.cookies)).json() as CustomerCommercialState;
    expect(state.tier).toEqual({ available: false, reason: 'subscriptions_not_supported' });
    expect(state.wallet).toEqual({ available: false, reason: 'wallet_not_supported' });
  });

  it('answers only GET', async () => {
    const { cookies } = await signIn();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await on.app.inject({ method, url: STATE, cookies, payload: { wallet: { spendable: 1_000_000 } } });
      expect(res.statusCode, method).toBe(404);
    }
  });
});

/* ================================================================== *
 * Read-only, and structurally separate from drafts and the preview
 * ================================================================== */

describe('the customer economy API writes nothing', () => {
  async function snapshot() {
    const tables = (
      await q<{ t: string }>(
        `SELECT table_name AS t FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
      )
    ).rows.map((r) => r.t);
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0]!.n;
    const economy = await q<{ h: string }>(
      `SELECT md5(coalesce((SELECT string_agg(t::text, '|' ORDER BY id) FROM economy_plan_versions t), '') ||
                  coalesce((SELECT string_agg(t::text, '|' ORDER BY id) FROM economy_pack_versions t), '') ||
                  coalesce((SELECT string_agg(t::text, '|' ORDER BY id) FROM economy_rulesets t), '')) AS h`,
    );
    return { counts, economy: economy.rows[0]!.h };
  }

  it('no table gains or loses a row, and no economy row changes', async () => {
    await liveEconomy();
    await plan('premium_monthly', 2, { price: 2599 });
    const { cookies } = await signIn();
    const before = await snapshot();
    for (const ctx of [on, off]) {
      for (const url of ROUTES) await get(ctx, url, cookies);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('never reaches draft, preview or placeholder-entitlement code', () => {
    const expected = {
      '../routes/customer-economy.ts': '../services/customer-economy.js',
      '../services/customer-economy.ts': './economy-resolver.js',
    };
    for (const [file, mustImport] of Object.entries(expected)) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      // Import statements only: the doc comments may name what they avoid.
      const imports = (source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? []).join('\n');
      expect(imports, file).toContain(mustImport);
      expect(imports, file).not.toMatch(/economy-preview|loadEconomyDrafts|entitlement-service|resolveEntitlement|fixture/);
    }
  });
});
