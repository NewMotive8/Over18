import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actionCostFor,
  allowanceFor,
  economyInstantAt,
  economyNow,
  loadPackVersion,
  loadPlanVersion,
  loadRuleset,
  resolvePackCatalog,
  resolvePackVersion,
  resolvePlanCatalog,
  resolvePlanVersion,
  lockEconomyRefForRecording,
  resolveRuleset,
  rewardFor,
  type EconomyInstant,
  type RulesetSnapshot,
} from '../services/economy-resolver.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * PRD v1.2 P1.2 -- the economy resolver, the single runtime authority on which
 * configuration applies, and the migration 0029 guarantees it relies on.
 */

let on: TestContext;
const ACTOR = randomUUID();

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => truncateAll(on));

const q = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  on.pool.query<T>(text, params);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Database-computed instants, so no test depends on the application clock. */
async function dbInstant(expression: string, params: unknown[] = []): Promise<string> {
  const { rows } = await q<{ iso: string }>(
    `SELECT to_char((${expression}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS iso`,
    params,
  );
  return rows[0]!.iso;
}
const inFuture = async (interval: string) => new Date(await dbInstant(`clock_timestamp() + interval '${interval}'`));
const shift = async (iso: string, interval: string) =>
  economyInstantAt(await dbInstant(`$1::timestamptz + interval '${interval}'`, [iso]));

async function newPlan(code: string) {
  return (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
}
async function planVersion(planId: string, version: number, price: number, over: { purchasable?: boolean } = {}) {
  return (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions
         (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, is_purchasable)
       VALUES ($1, $2, 'Premium', 1, $3, 'USD', 300, $4) RETURNING id`,
      [planId, version, price, over.purchasable ?? true],
    )
  ).rows[0]!.id;
}
async function newPack(code: string) {
  return (await q<{ id: string }>('INSERT INTO economy_packs (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
}
async function packVersion(packId: string, version: number, credits: number, price: number, sortOrder = 0) {
  return (
    await q<{ id: string }>(
      `INSERT INTO economy_pack_versions (pack_id, version, display_name, credits, price_minor, currency, sort_order)
       VALUES ($1, $2, 'Pack', $3, $4, 'USD', $5) RETURNING id`,
      [packId, version, credits, price, sortOrder],
    )
  ).rows[0]!.id;
}
type Table = 'economy_plan_versions' | 'economy_pack_versions' | 'economy_rulesets';
async function publish(table: Table, id: string, effectiveFrom: Date | null = null) {
  return (
    await q<{ effective_from_iso: string }>(
      `UPDATE ${table} SET status = 'published', effective_from = $2, published_by = $3, publish_reason = 'test'
        WHERE id = $1
        RETURNING to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_from_iso`,
      [id, effectiveFrom, ACTOR],
    )
  ).rows[0]!.effective_from_iso;
}
const cancel = (table: Table, id: string) =>
  q(`UPDATE ${table} SET status = 'cancelled', cancelled_by = $2, cancel_reason = 'test' WHERE id = $1`, [id, ACTOR]);

async function rulesetWith(version: number, build: (id: string) => Promise<void> = async () => {}) {
  const id = (await q<{ id: string }>('INSERT INTO economy_rulesets (version) VALUES ($1) RETURNING id', [version])).rows[0]!.id;
  await build(id);
  return id;
}
const cost = (rulesetId: string, action: string, tier: string, maxDuration: number | null, credits: number, enabled = true, unit = 'per_action') =>
  q(
    `INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, quality_tier, max_duration_seconds, unit, credit_cost, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [rulesetId, action, tier, maxDuration, unit, credits, enabled],
  );
const allowance = (rulesetId: string, key: string, value: number) =>
  q('INSERT INTO economy_ruleset_allowances (ruleset_id, key, value) VALUES ($1, $2, $3)', [rulesetId, key, value]);
const reward = (rulesetId: string, key: string, credits: number, enabled = true) =>
  q('INSERT INTO economy_ruleset_rewards (ruleset_id, reward_key, credits, enabled) VALUES ($1, $2, $3, $4)', [rulesetId, key, credits, enabled]);

/* ------------------------------------------------------------------ *
 * Instants
 * ------------------------------------------------------------------ */

describe('resolution instants', () => {
  it('reads "now" from the database clock, with microsecond precision', async () => {
    const before = await dbInstant('clock_timestamp()');
    const now = await economyNow(on.db);
    const after = await dbInstant('clock_timestamp()');
    expect(now.source).toBe('database');
    expect(now.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(now.iso >= before && now.iso <= after).toBe(true);
  });

  it('accepts an explicit UTC instant and refuses anything ambiguous', () => {
    expect(economyInstantAt('2026-10-01T00:00:00.123456Z')).toEqual({ iso: '2026-10-01T00:00:00.123456Z', source: 'explicit' });
    for (const bad of ['2026-10-01', '2026-10-01T00:00:00+03:00', '2026-13-40T00:00:00Z', 'tomorrow', '']) {
      expect(() => economyInstantAt(bad)).toThrow(RangeError);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

describe('resolving a plan version', () => {
  it('says unknown_plan for a code that does not exist -- no fallback plan', async () => {
    const r = await resolvePlanVersion(on.db, 'nope', await economyNow(on.db));
    expect(r).toMatchObject({ ok: false, reason: 'unknown_plan' });
  });

  it('says no_effective_version when the plan has only a draft -- even a draft with a past schedule', async () => {
    const planId = await newPlan('premium_monthly');
    const draft = await planVersion(planId, 1, 1999);
    await q(`UPDATE economy_plan_versions SET effective_from = clock_timestamp() - interval '1 day' WHERE id = $1`, [draft]);
    expect(await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db))).toMatchObject({
      ok: false,
      reason: 'no_effective_version',
    });
  });

  it('returns the full live version with its exact identity', async () => {
    const planId = await newPlan('premium_monthly');
    const v1 = await planVersion(planId, 1, 1999);
    const effective = await publish('economy_plan_versions', v1);
    const asOf = await economyNow(on.db);
    const r = await resolvePlanVersion(on.db, 'premium_monthly', asOf);
    expect(r).toEqual({
      ok: true,
      asOf,
      value: {
        ref: { kind: 'plan_version', id: v1, code: 'premium_monthly', version: 1 },
        planId,
        status: 'published',
        displayName: 'Premium',
        billingPeriodMonths: 1,
        priceMinor: 1999,
        currency: 'USD',
        monthlyIncludedCredits: 300,
        features: {},
        isPurchasable: true,
        effectiveFrom: effective,
        publishedAt: effective,
      },
    });
  });

  it('picks the latest published version effective by the instant, across several', async () => {
    const planId = await newPlan('premium_monthly');
    const at1 = await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    const at2 = await publish('economy_plan_versions', await planVersion(planId, 2, 2000));
    const at3 = await publish('economy_plan_versions', await planVersion(planId, 3, 3000));
    const price = async (iso: string) => {
      const r = await resolvePlanVersion(on.db, 'premium_monthly', economyInstantAt(iso));
      return r.ok ? r.value.priceMinor : r.reason;
    };
    expect(await price(at1)).toBe(1000);
    expect(await price(at2)).toBe(2000);
    expect(await price(at3)).toBe(3000);
    expect(await price((await economyNow(on.db)).iso)).toBe(3000);
  });

  it('treats effective_from as inclusive, to the microsecond', async () => {
    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    const at2 = await publish('economy_plan_versions', await planVersion(planId, 2, 2000));
    const exactly = await resolvePlanVersion(on.db, 'premium_monthly', economyInstantAt(at2));
    const justBefore = await resolvePlanVersion(on.db, 'premium_monthly', await shift(at2, '-1 microsecond'));
    expect(exactly.ok && exactly.value.ref.version).toBe(2);
    expect(justBefore.ok && justBefore.value.ref.version).toBe(1);
  });

  it('does not activate a scheduled version before its instant, and does at it', async () => {
    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    const at2 = await publish('economy_plan_versions', await planVersion(planId, 2, 2000), await inFuture('7 days'));

    const now = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
    expect(now.ok && now.value.ref.version).toBe(1);
    const scheduled = await resolvePlanVersion(on.db, 'premium_monthly', economyInstantAt(at2));
    expect(scheduled.ok && scheduled.value.ref.version).toBe(2);
  });

  it('switches to a scheduled version in real time, by the database clock', async () => {
    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    await publish('economy_plan_versions', await planVersion(planId, 2, 2000), await inFuture('1200 milliseconds'));
    const before = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
    await sleep(1600);
    const after = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
    expect(before.ok && before.value.ref.version).toBe(1);
    expect(after.ok && after.value.ref.version).toBe(2);
  });

  it('never returns a cancelled version, at any instant', async () => {
    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    const v2 = await planVersion(planId, 2, 2000);
    const at2 = await publish('economy_plan_versions', v2, await inFuture('3 days'));
    await cancel('economy_plan_versions', v2);
    for (const asOf of [economyInstantAt(at2), await shift(at2, '10 days')]) {
      const r = await resolvePlanVersion(on.db, 'premium_monthly', asOf);
      expect(r.ok && r.value.ref.version).toBe(1);
    }
  });

  it('reports no_effective_version when every published version is cancelled or not yet effective', async () => {
    const planId = await newPlan('premium_monthly');
    const v1 = await planVersion(planId, 1, 1000);
    await publish('economy_plan_versions', v1, await inFuture('2 days'));
    await cancel('economy_plan_versions', v1);
    await publish('economy_plan_versions', await planVersion(planId, 2, 2000), await inFuture('5 days'));
    expect(await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db))).toMatchObject({
      ok: false,
      reason: 'no_effective_version',
    });
  });

  it('still resolves a RETIRED version -- purchasability is the caller’s decision, stated where made', async () => {
    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    await publish('economy_plan_versions', await planVersion(planId, 2, 1000, { purchasable: false }));
    const r = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
    expect(r.ok && [r.value.ref.version, r.value.isPurchasable]).toEqual([2, false]);
  });

  /**
   * THE CLOCK-AUTHORITY PROPERTY. Resolving with the database clock straight
   * after an immediate publish always sees the new version. The P1.1 review
   * showed an application clock can lag and still see the previous one.
   */
  it('always sees an immediately published version when resolving by the database clock', async () => {
    const planId = await newPlan('premium_monthly');
    for (let version = 1; version <= 15; version += 1) {
      await publish('economy_plan_versions', await planVersion(planId, version, 1000 + version));
      const r = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
      expect(r.ok && r.value.ref.version).toBe(version);
    }
  });
});

describe('the plan catalog', () => {
  it('lists each plan’s live version by code, and omits plans with none', async () => {
    const monthly = await newPlan('premium_monthly');
    const annual = await newPlan('premium_annual');
    const future = await newPlan('premium_quarterly');
    await newPlan('empty_plan');
    await publish('economy_plan_versions', await planVersion(monthly, 1, 1999));
    await publish('economy_plan_versions', await planVersion(monthly, 2, 2499));
    await publish('economy_plan_versions', await planVersion(annual, 1, 17999));
    await publish('economy_plan_versions', await planVersion(future, 1, 5397), await inFuture('1 day'));

    const { plans } = await resolvePlanCatalog(on.db, await economyNow(on.db));
    expect(plans.map((p) => [p.ref.code, p.ref.version, p.priceMinor])).toEqual([
      ['premium_annual', 1, 17999],
      ['premium_monthly', 2, 2499],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Exact identity
 * ------------------------------------------------------------------ */

describe('exact version identity', () => {
  it('reloads a recorded version exactly, however many versions follow it', async () => {
    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1999));
    const resolved = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
    if (!resolved.ok) throw new Error('expected a live version');
    const recorded = resolved.value.ref;

    await publish('economy_plan_versions', await planVersion(planId, 2, 2999));
    await publish('economy_plan_versions', await planVersion(planId, 3, 3999));

    const reloaded = await loadPlanVersion(on.db, recorded.id);
    expect(reloaded).toEqual({ ok: true, value: resolved.value });
    const live = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
    expect(live.ok && live.value.ref.version).toBe(3);
  });

  it('never loads a draft or an unknown id', async () => {
    const planId = await newPlan('premium_monthly');
    const draft = await planVersion(planId, 1, 1999);
    expect(await loadPlanVersion(on.db, draft)).toEqual({ ok: false, reason: 'not_found' });
    expect(await loadPlanVersion(on.db, randomUUID())).toEqual({ ok: false, reason: 'not_found' });
  });

  it('guarantees a version the resolver returned can never afterwards become cancelled', async () => {
    const planId = await newPlan('premium_monthly');
    const v1 = await planVersion(planId, 1, 1999);
    await publish('economy_plan_versions', v1);
    const r = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
    expect(r.ok && r.value.ref.id).toBe(v1);
    await expect(cancel('economy_plan_versions', v1)).rejects.toThrow(/already taken effect/);
  });
});

/* ------------------------------------------------------------------ *
 * Packs
 * ------------------------------------------------------------------ */

describe('resolving packs', () => {
  it('resolves by code with explicit failures, and reloads by id', async () => {
    const asOf = await economyNow(on.db);
    expect(await resolvePackVersion(on.db, 'starter', asOf)).toMatchObject({ ok: false, reason: 'unknown_pack' });
    const packId = await newPack('starter');
    const v1 = await packVersion(packId, 1, 150, 999);
    expect(await resolvePackVersion(on.db, 'starter', await economyNow(on.db))).toMatchObject({
      ok: false,
      reason: 'no_effective_version',
    });
    await publish('economy_pack_versions', v1);
    const r = await resolvePackVersion(on.db, 'starter', await economyNow(on.db));
    expect(r.ok && [r.value.ref, r.value.credits, r.value.priceMinor]).toEqual([
      { kind: 'pack_version', id: v1, code: 'starter', version: 1 },
      150,
      999,
    ]);
    expect(await loadPackVersion(on.db, v1)).toMatchObject({ ok: true, value: { ref: { id: v1 } } });
  });

  it('lists the live ladder in sort order, then code', async () => {
    for (const [code, credits, price, order] of [
      ['popular', 400, 2499, 1],
      ['starter', 150, 999, 0],
      ['value', 900, 4999, 2],
      ['alpha_value', 900, 4999, 2],
    ] as const) {
      await publish('economy_pack_versions', await packVersion(await newPack(code), 1, credits, price, order));
    }
    const { packs } = await resolvePackCatalog(on.db, await economyNow(on.db));
    expect(packs.map((p) => p.ref.code)).toEqual(['starter', 'popular', 'alpha_value', 'value']);
  });
});

/* ------------------------------------------------------------------ *
 * Rulesets
 * ------------------------------------------------------------------ */

describe('resolving a ruleset', () => {
  it('says no_effective_ruleset when none is published, or only drafts and future ones exist', async () => {
    expect(await resolveRuleset(on.db, await economyNow(on.db))).toMatchObject({ ok: false, reason: 'no_effective_ruleset' });
    const draft = await rulesetWith(1);
    expect(await resolveRuleset(on.db, await economyNow(on.db))).toMatchObject({ ok: false, reason: 'no_effective_ruleset' });
    await publish('economy_rulesets', draft, await inFuture('1 day'));
    expect(await resolveRuleset(on.db, await economyNow(on.db))).toMatchObject({ ok: false, reason: 'no_effective_ruleset' });
  });

  it('returns the whole live snapshot with its identity, ignoring cancelled and future rulesets', async () => {
    const r1 = await rulesetWith(1, async (id) => {
      await cost(id, 'image', 'standard', null, 10);
      await allowance(id, 'free_daily_messages', 10);
      await reward(id, 'first_chat', 5);
    });
    await publish('economy_rulesets', r1);
    const r2 = await rulesetWith(2, async (id) => {
      await cost(id, 'image', 'standard', null, 99);
    });
    await publish('economy_rulesets', r2, await inFuture('3 days'));
    await cancel('economy_rulesets', r2);
    const r3 = await rulesetWith(3, async (id) => {
      await cost(id, 'image', 'standard', null, 12);
    });
    await publish('economy_rulesets', r3, await inFuture('5 days'));

    const live = await resolveRuleset(on.db, await economyNow(on.db));
    if (!live.ok) throw new Error('expected a live ruleset');
    expect(live.value.ref).toEqual({ kind: 'ruleset', id: r1, version: 1 });
    expect(live.value.actionCosts).toEqual([
      { actionType: 'image', qualityTier: 'standard', maxDurationSeconds: null, unit: 'per_action', creditCost: 10, enabled: true },
    ]);
    expect([...live.value.allowances]).toEqual([['free_daily_messages', 10]]);
    expect(live.value.rewards).toEqual([{ rewardKey: 'first_chat', credits: 5, perUserCap: null, enabled: true }]);

    const later = await resolveRuleset(on.db, await shift((await economyNow(on.db)).iso, '6 days'));
    expect(later.ok && later.value.ref.id).toBe(r3);
  });

  it('reloads a recorded ruleset with its frozen rows after a newer one takes over', async () => {
    const r1 = await rulesetWith(1, async (id) => cost(id, 'image', 'standard', null, 10).then(() => undefined));
    await publish('economy_rulesets', r1);
    const resolved = await resolveRuleset(on.db, await economyNow(on.db));
    const r2 = await rulesetWith(2, async (id) => cost(id, 'image', 'standard', null, 20).then(() => undefined));
    await publish('economy_rulesets', r2);
    expect(await loadRuleset(on.db, r1)).toEqual({ ok: true, value: resolved.ok && resolved.value });
    expect(await loadRuleset(on.db, randomUUID())).toEqual({ ok: false, reason: 'not_found' });
  });

  it('resolves several entities from ONE instant, so they cannot straddle a switch', async () => {
    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    await publish('economy_rulesets', await rulesetWith(1, async (id) => cost(id, 'image', 'standard', null, 10).then(() => undefined)));
    const switchAt = await inFuture('2 days');
    const at = await publish('economy_plan_versions', await planVersion(planId, 2, 2000), switchAt);
    await publish('economy_rulesets', await rulesetWith(2, async (id) => cost(id, 'image', 'standard', null, 20).then(() => undefined)), switchAt);

    for (const [asOf, expected] of [
      [await shift(at, '-1 microsecond'), [1, 1]],
      [economyInstantAt(at), [2, 2]],
    ] as Array<[EconomyInstant, number[]]>) {
      const plan = await resolvePlanVersion(on.db, 'premium_monthly', asOf);
      const ruleset = await resolveRuleset(on.db, asOf);
      expect([plan.ok && plan.value.ref.version, ruleset.ok && ruleset.value.ref.version]).toEqual(expected);
    }
  });
});

describe('lookups on a resolved ruleset', () => {
  let snapshot: RulesetSnapshot;

  beforeEach(async () => {
    const id = await rulesetWith(1, async (rs) => {
      await cost(rs, 'image', 'standard', null, 10);
      await cost(rs, 'image', 'high', null, 15);
      await cost(rs, 'video', 'standard', 5, 40);
      await cost(rs, 'video', 'standard', 15, 100);
      await cost(rs, 'video', 'standard', 30, 200, false);
      await cost(rs, 'voice_call', 'standard', null, 5, true, 'per_minute');
      await cost(rs, 'gif', 'standard', null, 3, false);
      await allowance(rs, 'free_daily_messages', 10);
      await allowance(rs, 'grace_period_days', 0);
      await reward(rs, 'first_chat', 5);
      await reward(rs, 'referral', 10, false);
    });
    await publish('economy_rulesets', id);
    const r = await resolveRuleset(on.db, await economyNow(on.db));
    if (!r.ok) throw new Error('expected a live ruleset');
    snapshot = r.value;
  });

  const credits = (lookup: ReturnType<typeof actionCostFor>) => (lookup.ok ? lookup.cost.creditCost : lookup.reason);

  it('prices an action by quality tier, and names the ruleset that priced it', () => {
    const lookup = actionCostFor(snapshot, 'image');
    expect(lookup).toEqual({
      ok: true,
      ruleset: snapshot.ref,
      cost: { actionType: 'image', qualityTier: 'standard', maxDurationSeconds: null, unit: 'per_action', creditCost: 10, enabled: true },
    });
    expect(credits(actionCostFor(snapshot, 'image', { qualityTier: 'high' }))).toBe(15);
    expect(credits(actionCostFor(snapshot, 'image', { qualityTier: 'ultra' }))).toBe('unknown_quality_tier');
    expect(credits(actionCostFor(snapshot, 'teleport'))).toBe('unknown_action');
  });

  it('picks the smallest duration tier that covers the request, and never undercharges past the top', () => {
    expect(credits(actionCostFor(snapshot, 'video', { durationSeconds: 1 }))).toBe(40);
    expect(credits(actionCostFor(snapshot, 'video', { durationSeconds: 5 }))).toBe(40);
    expect(credits(actionCostFor(snapshot, 'video', { durationSeconds: 5.5 }))).toBe(100);
    expect(credits(actionCostFor(snapshot, 'video', { durationSeconds: 15 }))).toBe(100);
    // The 16-30s tier exists but is disabled: refused, not priced at a cheaper tier.
    expect(credits(actionCostFor(snapshot, 'video', { durationSeconds: 20 }))).toBe('action_disabled');
    expect(credits(actionCostFor(snapshot, 'video', { durationSeconds: 31 }))).toBe('duration_exceeds_tiers');
    expect(credits(actionCostFor(snapshot, 'video'))).toBe('duration_required');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(credits(actionCostFor(snapshot, 'video', { durationSeconds: bad }))).toBe('invalid_duration');
    }
  });

  it('returns a per-minute rate as configured -- the caller multiplies', () => {
    const lookup = actionCostFor(snapshot, 'voice_call', { durationSeconds: 125 });
    expect(lookup.ok && [lookup.cost.unit, lookup.cost.creditCost]).toEqual(['per_minute', 5]);
  });

  it('refuses a disabled action instead of treating it as free', () => {
    expect(credits(actionCostFor(snapshot, 'gif'))).toBe('action_disabled');
  });

  it('refuses a configuration that is ambiguous between tiered and untiered rows', async () => {
    await truncateAll(on);
    const id = await rulesetWith(1, async (rs) => {
      await cost(rs, 'video', 'standard', null, 50);
      await cost(rs, 'video', 'standard', 5, 40);
    });
    await publish('economy_rulesets', id);
    const r = await resolveRuleset(on.db, await economyNow(on.db));
    if (!r.ok) throw new Error('expected a live ruleset');
    for (const options of [{}, { durationSeconds: 3 }, { durationSeconds: 60 }]) {
      expect(credits(actionCostFor(r.value, 'video', options))).toBe('ambiguous_configuration');
    }
  });

  it('returns allowances exactly, including zero, and never invents a missing one', () => {
    expect(allowanceFor(snapshot, 'free_daily_messages')).toEqual({ ok: true, value: 10, ruleset: snapshot.ref });
    expect(allowanceFor(snapshot, 'grace_period_days')).toEqual({ ok: true, value: 0, ruleset: snapshot.ref });
    expect(allowanceFor(snapshot, 'signup_credit_grant')).toEqual({ ok: false, reason: 'missing_allowance', ruleset: snapshot.ref });
  });

  it('returns rewards, refusing unknown and disabled ones', () => {
    expect(rewardFor(snapshot, 'first_chat')).toMatchObject({ ok: true, reward: { credits: 5 }, ruleset: snapshot.ref });
    expect(rewardFor(snapshot, 'referral')).toMatchObject({ ok: false, reason: 'reward_disabled' });
    expect(rewardFor(snapshot, 'streak')).toMatchObject({ ok: false, reason: 'unknown_reward' });
  });
});

/* ------------------------------------------------------------------ *
 * Migration 0029 guarantees the resolver depends on
 * ------------------------------------------------------------------ */

describe('migration 0029', () => {
  it('refuses to cancel a version within one minute of taking effect', async () => {
    const planId = await newPlan('premium_monthly');
    const soon = await planVersion(planId, 1, 1000);
    await publish('economy_plan_versions', soon, await inFuture('30 seconds'));
    await expect(cancel('economy_plan_versions', soon)).rejects.toThrow(/can no longer be cancelled/);

    const plan2 = await newPlan('premium_annual');
    const later = await planVersion(plan2, 1, 1000);
    await publish('economy_plan_versions', later, await inFuture('2 minutes'));
    await expect(cancel('economy_plan_versions', later)).resolves.toBeDefined();
  });

  it('stamps publication with the real clock, not the transaction start', async () => {
    const planId = await newPlan('premium_monthly');
    const v1 = await planVersion(planId, 1, 1000);
    const client = await on.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_sleep(1)');
      const { rows } = await client.query<{ lag_ms: number }>(
        `UPDATE economy_plan_versions SET status = 'published', published_by = $2, publish_reason = 'r'
          WHERE id = $1
          RETURNING extract(epoch FROM (published_at - now())) * 1000 AS lag_ms`,
        [v1, ACTOR],
      );
      await client.query('COMMIT');
      expect(Number(rows[0]!.lag_ms)).toBeGreaterThan(900);
    } finally {
      client.release();
    }
  });

  it('makes plan and pack codes immutable, and still lets an empty parent be deleted', async () => {
    const planId = await newPlan('premium_monthly');
    await expect(q("UPDATE economy_plans SET code = 'renamed' WHERE id = $1", [planId])).rejects.toThrow(/stable identity/);
    const packId = await newPack('starter');
    await expect(q("UPDATE economy_packs SET code = 'renamed' WHERE id = $1", [packId])).rejects.toThrow(/stable identity/);
    await expect(q('DELETE FROM economy_packs WHERE id = $1', [packId])).resolves.toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * The boundary
 * ------------------------------------------------------------------ */

/**
 * ONE AUTHORITY, ENFORCED. No application module other than the resolver may
 * read the economy configuration tables and choose a version for itself. A
 * later phase that must WRITE them (P1.3's publishing service) is added here
 * deliberately, as a reviewed decision -- not discovered in production as a
 * second, subtly different notion of "the current price".
 */
describe('the resolver is the only reader of economy configuration', () => {
  // P1: the configuration writer (drafts, review, publish, cancel) is the one
  // reviewed addition -- it drives the P1.1 lifecycle, it does not choose a
  // live version for runtime.
  const ALLOWED = new Set(['db/schema.ts', 'services/economy-resolver.ts', 'services/economy-admin-service.ts']);
  const ECONOMY_TABLES = /\beconomy(Plans|PlanVersions|Packs|PackVersions|Rulesets|RulesetActionCosts|RulesetAllowances|RulesetRewards)\b|\beconomy_(plans|plan_versions|packs|pack_versions|rulesets|ruleset_action_costs|ruleset_allowances|ruleset_rewards)\b/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
    });
  }

  it('finds economy tables referenced only by the schema and the resolver', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const offenders = sourceFiles(src)
      .map((path) => relative(src, path).split('\\').join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => ECONOMY_TABLES.test(readFileSync(join(src, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

/* ================================================================== *
 * Recording a decision: the lock that makes the 0029 margin exact
 * ================================================================== */

/**
 * Migration 0029 refuses a cancellation inside the last minute before a version
 * takes effect. That is a TIME buffer measured on the database clock: it proves
 * the cancelling STATEMENT ran in time, and cannot stop that transaction
 * committing later still. `lockEconomyRefForRecording` is the hard guarantee at
 * the moment it matters -- a SHARE lock, taken in the transaction that records
 * the decision, which an in-flight cancel must wait for.
 */
describe('locking the configuration a decision is recorded against', () => {
  it('locks a live version and hands back the same ref', async () => {
    const planId = await newPlan('premium');
    const versionId = await planVersion(planId, 1, 999);
    await publish('economy_plan_versions', versionId);
    const asOf = await economyNow(on.db);
    const resolved = await resolvePlanVersion(on.db, 'premium', asOf);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const locked = await lockEconomyRefForRecording(on.db, resolved.value.ref);
    expect(locked).toEqual({ ok: true, ref: resolved.value.ref });
  });

  it('refuses a version that is gone, or that is not live', async () => {
    expect(await lockEconomyRefForRecording(on.db, { kind: 'plan_version', id: randomUUID(), code: 'x', version: 1 })).toEqual({
      ok: false,
      reason: 'version_gone',
    });

    const packId = await newPack('bundle');
    const draft = await packVersion(packId, 1, 100, 499);
    expect(await lockEconomyRefForRecording(on.db, { kind: 'pack_version', id: draft, code: 'bundle', version: 1 })).toMatchObject({
      ok: false,
      reason: 'not_live',
      status: 'draft',
    });

    // A separate pack: P1.1 allows only one draft per parent at a time.
    // Scheduled far enough ahead that 0029 still allows the cancellation.
    const otherPackId = await newPack('bundle_plus');
    const scheduled = await packVersion(otherPackId, 1, 200, 899);
    await publish('economy_pack_versions', scheduled, await inFuture('10 minutes'));
    await cancel('economy_pack_versions', scheduled);
    expect(await lockEconomyRefForRecording(on.db, { kind: 'pack_version', id: scheduled, code: 'bundle_plus', version: 1 })).toMatchObject({
      ok: false,
      reason: 'not_live',
      status: 'cancelled',
    });
  });

  it('locks a ruleset too -- the third thing a decision can be recorded against', async () => {
    const rulesetId = await rulesetWith(1, async (id) => {
      await cost(id, 'image_generation', 'standard', null, 5);
    });
    await publish('economy_rulesets', rulesetId);
    const asOf = await economyNow(on.db);
    const resolved = await resolveRuleset(on.db, asOf);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(await lockEconomyRefForRecording(on.db, resolved.value.ref)).toEqual({
      ok: true,
      ref: resolved.value.ref,
    });
  });

  /**
   * THE RACE, DEMONSTRATED. An uncommitted cancellation holds the row; a
   * recording transaction that tries to lock it WAITS rather than reading it as
   * live. Proven with a short statement_timeout: the lock request blocks until
   * the timeout fires, which it could not do if the row were free.
   */
  it('waits for an in-flight cancellation instead of recording against it', async () => {
    const packId = await newPack('bundle');
    const versionId = await packVersion(packId, 1, 500, 1999);
    await publish('economy_pack_versions', versionId, await inFuture('10 minutes'));
    const ref = { kind: 'pack_version', id: versionId, code: 'bundle', version: 1 } as const;

    // A second connection, so the two transactions are genuinely concurrent.
    const canceller = await on.pool.connect();
    try {
      await canceller.query('BEGIN');
      await canceller.query(
        `UPDATE economy_pack_versions SET status = 'cancelled', cancelled_by = $2, cancel_reason = 'test' WHERE id = $1`,
        [versionId, ACTOR],
      );
      // NOT committed: the row is held.

      const blocked = await on.pool.connect();
      try {
        await blocked.query('BEGIN');
        await blocked.query("SET LOCAL statement_timeout = '400ms'");
        await expect(
          blocked.query('SELECT status FROM economy_pack_versions WHERE id = $1 FOR SHARE', [versionId]),
        ).rejects.toThrow(/statement timeout/i);
        await blocked.query('ROLLBACK');
      } finally {
        blocked.release();
      }

      await canceller.query('COMMIT');
    } finally {
      canceller.release();
    }

    // Once the cancellation lands, the lock answers truthfully rather than
    // letting a decision be recorded against a cancelled version.
    expect(await lockEconomyRefForRecording(on.db, ref)).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('holds the row while a recording transaction is open, so a cancel must wait for it', async () => {
    const packId = await newPack('bundle');
    const versionId = await packVersion(packId, 1, 500, 1999);
    await publish('economy_pack_versions', versionId, await inFuture('10 minutes'));

    const recorder = await on.pool.connect();
    try {
      await recorder.query('BEGIN');
      await recorder.query('SELECT status FROM economy_pack_versions WHERE id = $1 FOR SHARE', [versionId]);

      const canceller = await on.pool.connect();
      try {
        await canceller.query('BEGIN');
        await canceller.query("SET LOCAL statement_timeout = '400ms'");
        await expect(
          canceller.query(
            `UPDATE economy_pack_versions SET status = 'cancelled', cancelled_by = $2, cancel_reason = 'test' WHERE id = $1`,
            [versionId, ACTOR],
          ),
        ).rejects.toThrow(/statement timeout/i);
        await canceller.query('ROLLBACK');
      } finally {
        canceller.release();
      }

      await recorder.query('COMMIT');
    } finally {
      recorder.release();
    }

    // The version is still live: the cancellation never landed.
    const { rows } = await q<{ status: string }>('SELECT status FROM economy_pack_versions WHERE id = $1', [versionId]);
    expect(rows[0]!.status).toBe('published');
  });
});

/* ================================================================== *
 * P1.2 audit -- one boundary rule on every resolution path
 * ================================================================== */

/**
 * The plan tests above pin the boundary for `resolvePlanVersion`, and the
 * several-entities test pins it for rulesets. The two CATALOGS answer the same
 * question through a different query (DISTINCT ON), and packs had no
 * scheduling, boundary or cancellation coverage at all. One scenario, all five
 * entry points, one rule: the published version with the greatest
 * effective_from <= T, inclusive to the microsecond; a scheduled successor is
 * invisible until T reaches it; a cancelled version never appears.
 */
describe('every resolution path applies the same boundary', () => {
  type Reader = Parameters<typeof resolvePlanVersion>[0];

  /** v1 live; v2 scheduled at one shared instant; v3 scheduled later, then cancelled. */
  async function scheduleScenario(): Promise<string> {
    const switchAt = await inFuture('2 days');
    const cancelledAt = await inFuture('4 days');

    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    const at = await publish('economy_plan_versions', await planVersion(planId, 2, 2000), switchAt);
    const planV3 = await planVersion(planId, 3, 3000);
    await publish('economy_plan_versions', planV3, cancelledAt);
    await cancel('economy_plan_versions', planV3);

    const packId = await newPack('starter');
    await publish('economy_pack_versions', await packVersion(packId, 1, 100, 500));
    await publish('economy_pack_versions', await packVersion(packId, 2, 200, 900), switchAt);
    const packV3 = await packVersion(packId, 3, 300, 1300);
    await publish('economy_pack_versions', packV3, cancelledAt);
    await cancel('economy_pack_versions', packV3);

    await publish('economy_rulesets', await rulesetWith(1, async (id) => cost(id, 'image', 'standard', null, 10).then(() => undefined)));
    await publish('economy_rulesets', await rulesetWith(2, async (id) => cost(id, 'image', 'standard', null, 20).then(() => undefined)), switchAt);
    const rulesetV3 = await rulesetWith(3);
    await publish('economy_rulesets', rulesetV3, cancelledAt);
    await cancel('economy_rulesets', rulesetV3);
    return at;
  }

  async function versionsAt(reader: Reader, asOf: EconomyInstant) {
    const plan = await resolvePlanVersion(reader, 'premium_monthly', asOf);
    const pack = await resolvePackVersion(reader, 'starter', asOf);
    const ruleset = await resolveRuleset(reader, asOf);
    return {
      plan: plan.ok ? plan.value.ref.version : plan.reason,
      pack: pack.ok ? pack.value.ref.version : pack.reason,
      ruleset: ruleset.ok ? ruleset.value.ref.version : ruleset.reason,
      planCatalog: (await resolvePlanCatalog(reader, asOf)).plans.map((p) => p.ref.version),
      packCatalog: (await resolvePackCatalog(reader, asOf)).packs.map((p) => p.ref.version),
    };
  }
  const everywhere = (version: number) => ({
    plan: version,
    pack: version,
    ruleset: version,
    planCatalog: [version],
    packCatalog: [version],
  });

  it('now, a microsecond before the switch, exactly at it, just after, and long after', async () => {
    const at = await scheduleScenario();
    expect(await versionsAt(on.db, await economyNow(on.db))).toEqual(everywhere(1));
    expect(await versionsAt(on.db, await shift(at, '-1 microsecond'))).toEqual(everywhere(1));
    expect(await versionsAt(on.db, economyInstantAt(at))).toEqual(everywhere(2));
    expect(await versionsAt(on.db, await shift(at, '1 microsecond'))).toEqual(everywhere(2));
    // Past the cancelled v3's instant: a cancelled version never surfaces anywhere.
    expect(await versionsAt(on.db, await shift(at, '10 days'))).toEqual(everywhere(2));
  });

  it('reports the empty state explicitly on every path before anything takes effect', async () => {
    const switchAt = await inFuture('1 day');
    await publish('economy_plan_versions', await planVersion(await newPlan('premium_monthly'), 1, 1000), switchAt);
    await publish('economy_pack_versions', await packVersion(await newPack('starter'), 1, 100, 500), switchAt);
    await publish('economy_rulesets', await rulesetWith(1), switchAt);
    expect(await versionsAt(on.db, await economyNow(on.db))).toEqual({
      plan: 'no_effective_version',
      pack: 'no_effective_version',
      ruleset: 'no_effective_ruleset',
      planCatalog: [],
      packCatalog: [],
    });
  });

  /**
   * CRITERION 8. Instants travel as UTC ISO strings ending in Z, and effective
   * times are rendered AT TIME ZONE 'UTC', so no answer may depend on the
   * session's TimeZone setting. Pinned in the most distant zone there is.
   */
  it('gives identical answers whatever time zone the database session is in', async () => {
    const at = await scheduleScenario();
    const before = await shift(at, '-1 microsecond');
    const exactly = economyInstantAt(at);
    const inUtc = { before: await versionsAt(on.db, before), exactly: await versionsAt(on.db, exactly) };
    const utcNow = Date.parse((await economyNow(on.db)).iso);

    await on.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`); // UTC+14
      expect(await versionsAt(tx, before)).toEqual(inUtc.before);
      expect(await versionsAt(tx, exactly)).toEqual(inUtc.exactly);

      const plan = await resolvePlanVersion(tx, 'premium_monthly', exactly);
      expect(plan.ok && plan.value.effectiveFrom).toBe(at);

      const now = await economyNow(tx);
      expect(now.iso).toMatch(/Z$/);
      expect(Math.abs(Date.parse(now.iso) - utcNow)).toBeLessThan(60_000);
    });
  });
});

/* ================================================================== *
 * P1.2 audit -- recording only against a version that has taken effect
 * ================================================================== */

/**
 * THE GAP THIS CLOSES. A version resolved by the DATABASE clock has already
 * taken effect, so 0029 guarantees it can never afterwards be cancelled. A
 * version resolved at an explicit FUTURE instant -- a preview -- has not: it
 * comes back with a real EconomyRef, and it can still be withdrawn. Nothing
 * stopped a writer recording a decision against that ref, which would charge
 * next week's price today and name a version that might never take effect --
 * the very record 0029 exists to prevent.
 *
 * The recording lock is the one place every write passes through, so it is
 * where "has this version taken effect?" is asked, on the same database clock.
 */
describe('a decision cannot be recorded against a version that has not taken effect', () => {
  it('refuses a scheduled plan version handed out by a preview', async () => {
    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    const v2 = await planVersion(planId, 2, 2000);
    const at2 = await publish('economy_plan_versions', v2, await inFuture('10 minutes'));

    const preview = await resolvePlanVersion(on.db, 'premium_monthly', economyInstantAt(at2));
    if (!preview.ok) throw new Error('expected the scheduled version in a preview');
    expect(preview.value.ref.id).toBe(v2);

    expect(await lockEconomyRefForRecording(on.db, preview.value.ref)).toEqual({
      ok: false,
      reason: 'not_yet_effective',
      status: 'published',
    });

    // Why it matters: that version can still be withdrawn.
    await cancel('economy_plan_versions', v2);
    expect(await lockEconomyRefForRecording(on.db, preview.value.ref)).toMatchObject({
      ok: false,
      reason: 'not_live',
      status: 'cancelled',
    });
  });

  it('refuses scheduled pack versions and rulesets the same way', async () => {
    const packId = await newPack('starter');
    const pack = await packVersion(packId, 1, 100, 500);
    await publish('economy_pack_versions', pack, await inFuture('10 minutes'));
    expect(
      await lockEconomyRefForRecording(on.db, { kind: 'pack_version', id: pack, code: 'starter', version: 1 }),
    ).toMatchObject({ ok: false, reason: 'not_yet_effective' });

    const ruleset = await rulesetWith(1);
    await publish('economy_rulesets', ruleset, await inFuture('10 minutes'));
    expect(await lockEconomyRefForRecording(on.db, { kind: 'ruleset', id: ruleset, version: 1 })).toMatchObject({
      ok: false,
      reason: 'not_yet_effective',
    });
  });

  it('accepts the version the moment it takes effect, by the database clock', async () => {
    const planId = await newPlan('premium_monthly');
    const v1 = await planVersion(planId, 1, 1000);
    await publish('economy_plan_versions', v1, await inFuture('1200 milliseconds'));
    const ref = { kind: 'plan_version', id: v1, code: 'premium_monthly', version: 1 } as const;

    expect(await lockEconomyRefForRecording(on.db, ref)).toMatchObject({ ok: false, reason: 'not_yet_effective' });
    await sleep(1600);
    expect(await lockEconomyRefForRecording(on.db, ref)).toEqual({ ok: true, ref });
  });

  /**
   * CRITERION 6, UNWEAKENED. A slow operation that resolved v1 must still be
   * able to record against v1 after v2 takes over -- the exact version its
   * decision used. Refusing SUPERSEDED versions would force it to re-resolve,
   * which is what the EconomyRef exists to avoid.
   */
  it('still records against a superseded version -- the exact one a decision used', async () => {
    const planId = await newPlan('premium_monthly');
    await publish('economy_plan_versions', await planVersion(planId, 1, 1000));
    const resolved = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
    if (!resolved.ok) throw new Error('expected a live version');
    await publish('economy_plan_versions', await planVersion(planId, 2, 2000));

    const live = await resolvePlanVersion(on.db, 'premium_monthly', await economyNow(on.db));
    expect(live.ok && live.value.ref.version).toBe(2);
    expect(await lockEconomyRefForRecording(on.db, resolved.value.ref)).toEqual({ ok: true, ref: resolved.value.ref });
  });
});
