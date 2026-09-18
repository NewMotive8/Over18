import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AdminRoleName } from '@over18/shared';
import { adminRoleGrants, users } from '../db/schema.js';
import {
  economyNow,
  resolvePackCatalog,
  resolvePlanCatalog,
  resolvePlanVersion,
  resolveRuleset,
} from '../services/economy-resolver.js';
import type { EconomyPreview } from '../services/economy-preview.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * P1.3 -- the economy preview and margin guard (PRD v1.2 §31, §8.1, App. B).
 *
 * Every figure below that comes from Appendix B uses the PRD's own v1.1 values
 * (§8 action costs, §17 pack ladder, a US$0.04 image cost) as TEST FIXTURES,
 * inserted as drafts. They are not defaults anywhere in the application: the
 * preview has no numbers of its own, which is the point of several tests here.
 */

let dark: TestContext;
let enforced: TestContext;
let seq = 0;

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  enforced = await createTestContext({ adminPermissionsEnforced: true });
});
afterAll(async () => {
  await destroyTestContext(dark);
  await destroyTestContext(enforced);
});
beforeEach(async () => truncateAll(dark));

const q = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  dark.pool.query<T>(text, params);

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

type Cookies = Record<string, string>;
async function account(kind: 'admin' | 'user', roles: AdminRoleName[] = []): Promise<Cookies> {
  const email = `preview-${kind}-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'preview-pass-1' } });
  expect(res.statusCode).toBe(201);
  const cookie = extractSessionCookie(res)!;
  const [row] = await dark.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (kind === 'admin') await dark.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
  for (const role of roles) await dark.db.insert(adminRoleGrants).values({ userId: row!.id, role });
  return { [cookie.name]: cookie.value };
}

const preview = (cookies: Cookies | null, payload: unknown = {}, on: TestContext = dark) =>
  on.app.inject({ method: 'POST', url: '/admin/economy/preview', payload: payload as object, ...(cookies ? { cookies } : {}) });

async function run(cookies: Cookies, payload: unknown = {}): Promise<EconomyPreview> {
  const res = await preview(cookies, payload);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as EconomyPreview;
}

/* ------------------------------------------------------------------ *
 * Configuration fixtures, written straight to the tables (drafts by default)
 * ------------------------------------------------------------------ */

const ACTOR = '00000000-0000-4000-8000-000000000001';

async function plan(code: string, version: number, monthlyCredits: number, price = 1299) {
  const existing = await q<{ id: string }>('SELECT id FROM economy_plans WHERE code = $1', [code]);
  const planId =
    existing.rows[0]?.id ?? (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
  return (
    await q<{ id: string }>(
      `INSERT INTO economy_plan_versions
         (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits)
       VALUES ($1, $2, 'Premium', 1, $3, 'USD', $4) RETURNING id`,
      [planId, version, price, monthlyCredits],
    )
  ).rows[0]!.id;
}

async function pack(code: string, version: number, credits: number, priceMinor: number, sortOrder: number, currency = 'USD') {
  const existing = await q<{ id: string }>('SELECT id FROM economy_packs WHERE code = $1', [code]);
  const packId =
    existing.rows[0]?.id ?? (await q<{ id: string }>('INSERT INTO economy_packs (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
  return (
    await q<{ id: string }>(
      `INSERT INTO economy_pack_versions (pack_id, version, display_name, credits, price_minor, currency, sort_order)
       VALUES ($1, $2, 'Pack', $3, $4, $5, $6) RETURNING id`,
      [packId, version, credits, priceMinor, currency, sortOrder],
    )
  ).rows[0]!.id;
}

type CostRow = [action: string, tier: string, maxDuration: number | null, unit: 'per_action' | 'per_minute', credits: number, enabled?: boolean];
async function ruleset(version: number, costs: CostRow[]) {
  const id = (await q<{ id: string }>('INSERT INTO economy_rulesets (version) VALUES ($1) RETURNING id', [version])).rows[0]!.id;
  for (const [action, tier, maxDuration, unit, credits, enabled = true] of costs) {
    await q(
      `INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, quality_tier, max_duration_seconds, unit, credit_cost, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, action, tier, maxDuration, unit, credits, enabled],
    );
  }
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

/** PRD v1.1 §8 / §17 -- the values Appendix B is computed from. Drafts. */
async function appendixBDraft() {
  await plan('premium_monthly', 1, 300);
  for (const [code, credits, price, order] of [
    ['starter', 150, 999, 0],
    ['popular', 400, 2499, 1],
    ['value', 900, 4999, 2],
    ['pro', 2000, 8999, 3],
    ['max', 4500, 17999, 4],
  ] as const) {
    await pack(code, 1, credits, price, order);
  }
  await ruleset(1, [
    ['image', 'standard', null, 'per_action', 10],
    ['voice_call', 'standard', null, 'per_minute', 5],
    ['video', 'standard', 5, 'per_action', 40],
  ]);
}

const IMAGE = 'image/standard/any';
const VOICE = 'voice_call/standard/any';
const VIDEO = 'video/standard/5s';
const cost = (actionType: string, amountMicros: number, over: Record<string, unknown> = {}) => ({
  actionType,
  qualityTier: 'standard',
  maxDurationSeconds: null,
  unit: 'per_action',
  amountMicros,
  currency: 'USD',
  ...over,
});
const imageAt4c = cost('image', 40_000, { source: 'PRD Appendix B.4 (fixture)' });

const action = (r: EconomyPreview, key: string) => r.actions.find((a) => a.action === key)!;
const priceAt = (r: EconomyPreview, key: string, packCode: string) =>
  action(r, key).cashPrice.find((p) => p.pack === packCode)!.price.amount;

/* ================================================================== *
 * 1. Appendix B, reproduced from a draft
 * ================================================================== */

describe('the preview reproduces Appendix B from the PRD values, drafted', () => {
  it('B.1 -- what the 300-Credit monthly grant buys', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'));
    const grant = r.grants.find((g) => g.plan === 'premium_monthly')!;
    expect(grant.source).toBe('draft');
    expect(Object.fromEntries(grant.buys.map((b) => [b.action, b.quantity]))).toEqual({
      [IMAGE]: 30,
      [VOICE]: 60,
      [VIDEO]: 7,
    });
  });

  it('B.2 -- the cash price of each action at the entry and best packs', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'));
    expect([priceAt(r, IMAGE, 'starter'), priceAt(r, IMAGE, 'max')]).toEqual(['0.67', '0.40']);
    expect([priceAt(r, VOICE, 'starter'), priceAt(r, VOICE, 'max')]).toEqual(['0.33', '0.20']);
    expect([priceAt(r, VIDEO, 'starter'), priceAt(r, VIDEO, 'max')]).toEqual(['2.66', '1.60']);
  });

  it('B.3 -- the per-Credit rate on every rung, and the 40% spread', async () => {
    await appendixBDraft();
    const [ladder] = (await run(await account('admin'))).ladders;
    expect(ladder!.currency).toBe('USD');
    expect(ladder!.rungs.map((g) => [g.code, g.perCredit.amount])).toEqual([
      ['starter', '0.067'],
      ['popular', '0.062'],
      ['value', '0.056'],
      ['pro', '0.045'],
      ['max', '0.040'],
    ]);
    expect(ladder!.spreadPercent).toBe('40');
    expect(ladder!.issues).toEqual([]);
  });

  it('B.4 -- a $0.04 image retails at ~17x cost at entry and ~10x at best; the grant costs $1.20 in images', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'), { providerCosts: [imageAt4c] });
    const image = action(r, IMAGE);
    const at = (packCode: string) => image.margins.find((m) => m.pack === packCode)!;
    expect(at('starter')).toEqual({ pack: 'starter', grossMarginPercent: '94', costMultiple: '16.7' });
    expect(at('max')).toEqual({ pack: 'max', grossMarginPercent: '90', costMultiple: '10.0' });
    expect(image.providerCost).toMatchObject({ amount: '0.0400', currency: 'USD', source: 'PRD Appendix B.4 (fixture)' });

    // Only the image cost is known, so the worst case is explicitly incomplete.
    const exposure = r.grants[0]!.worstCaseProviderCost;
    expect(exposure).toEqual({
      status: 'incomplete',
      knownWorst: { action: IMAGE, cost: { amount: '1.20', currency: 'USD' } },
      missingCosts: [VIDEO, VOICE],
    });
  });

  it('§8.1 -- the worst case is the dearest action to serve, and parity names it', async () => {
    await appendixBDraft();
    // Test-only costs for the two actions the PRD has no figure for.
    const r = await run(await account('admin'), {
      providerCosts: [imageAt4c, cost('voice_call', 20_000, { unit: 'per_minute' }), cost('video', 300_000, { maxDurationSeconds: 5 })],
    });
    expect(r.grants[0]!.worstCaseProviderCost).toEqual({
      status: 'complete',
      action: VIDEO,
      cost: { amount: '2.10', currency: 'USD' }, // 7 videos x $0.30
    });
    expect(r.parity).toEqual({
      thinnestAction: VIDEO,
      highestCostPerCredit: { amount: '0.0075', currency: 'USD' },
      lowestCostPerCredit: { amount: '0.0040', currency: 'USD' },
    });
    expect(r.inputs.missingProviderCosts).toEqual([]);
  });
});

/* ================================================================== *
 * 2. Same semantics as the resolver -- and a draft is never made active
 * ================================================================== */

describe('the preview composes the economy exactly as the resolver does', () => {
  async function liveEconomy() {
    const p = await plan('premium_monthly', 1, 300);
    await publish('economy_plan_versions', p);
    const k = await pack('starter', 1, 150, 999, 0);
    await publish('economy_pack_versions', k);
    const r = await ruleset(1, [
      ['image', 'standard', null, 'per_action', 10],
      ['voice_call', 'standard', null, 'per_minute', 5],
    ]);
    await publish('economy_rulesets', r);
  }

  it('live mode describes precisely what the resolver serves now', async () => {
    await liveEconomy();
    const r = await run(await account('admin'), { mode: 'live' });
    const asOf = await economyNow(dark.db);
    const plans = (await resolvePlanCatalog(dark.db, asOf)).plans;
    const packs = (await resolvePackCatalog(dark.db, asOf)).packs;
    const rules = await resolveRuleset(dark.db, asOf);
    if (!rules.ok) throw new Error('expected a live ruleset');

    expect(r.configuration.plans).toEqual(plans.map((p) => ({ code: p.ref.code, version: p.ref.version, source: 'live', isPurchasable: p.isPurchasable })));
    expect(r.configuration.packs).toEqual(packs.map((p) => ({ code: p.ref.code, version: p.ref.version, source: 'live', isPurchasable: p.isPurchasable })));
    expect(r.configuration.ruleset).toEqual({ version: rules.value.ref.version, source: 'live' });
    expect(r.actions.map((a) => [a.action, a.creditCost])).toEqual(
      rules.value.actionCosts.filter((c) => c.enabled).map((c) => [`${c.actionType}/${c.qualityTier}/any`, c.creditCost]),
    );
  });

  it('drafted mode overlays a draft on its live version, as publishing would -- and leaves it a draft', async () => {
    await liveEconomy();
    await pack('starter', 2, 200, 999, 0); // a better deal, drafted
    const admin = await account('admin');

    const live = await run(admin, { mode: 'live' });
    const drafted = await run(admin, { mode: 'drafted' });
    expect(live.configuration.packs).toEqual([{ code: 'starter', version: 1, source: 'live', isPurchasable: true }]);
    expect(drafted.configuration.packs).toEqual([{ code: 'starter', version: 2, source: 'draft', isPurchasable: true }]);
    expect(live.ladders[0]!.rungs[0]!.perCredit.amount).toBe('0.067');
    expect(drafted.ladders[0]!.rungs[0]!.perCredit.amount).toBe('0.050');

    // The draft was only previewed: the resolver still serves version 1.
    const resolved = await resolvePackCatalog(dark.db, await economyNow(dark.db));
    expect(resolved.packs.map((p) => p.ref.version)).toEqual([1]);
  });

  it('a drafted ruleset replaces the live one whole, never merged row by row', async () => {
    await liveEconomy();
    await ruleset(2, [['image', 'standard', null, 'per_action', 12]]);
    const r = await run(await account('admin'));
    expect(r.configuration.ruleset).toEqual({ version: 2, source: 'draft' });
    expect(r.actions.map((a) => [a.action, a.creditCost])).toEqual([[IMAGE, 12]]);
  });

  it('a published version scheduled for the future is not in the preview until it takes effect', async () => {
    await liveEconomy();
    const scheduled = await pack('starter', 2, 300, 999, 0);
    await publish('economy_pack_versions', scheduled, await inFuture('7 days'));
    const r = await run(await account('admin'));
    expect(r.configuration.packs).toEqual([{ code: 'starter', version: 1, source: 'live', isPurchasable: true }]);
  });

  /**
   * The preview lists every row, but runtime prices through `actionCostFor`,
   * which REFUSES an action whose tier set is ambiguous (both duration-tiered
   * and untiered rows). The preview must say so rather than show prices the
   * runtime would never charge.
   */
  it('flags any row the runtime would refuse to price, using the runtime lookup itself', async () => {
    await plan('premium_monthly', 1, 300);
    await pack('starter', 1, 150, 999, 0);
    await ruleset(1, [
      ['image', 'standard', null, 'per_action', 10],
      ['video', 'standard', 5, 'per_action', 40],
      ['video', 'standard', null, 'per_action', 60], // ambiguous with the tiered row
    ]);
    const r = await run(await account('admin'));
    expect(action(r, IMAGE).runtime).toBe('priced');
    expect(r.configurationIssues).toEqual([
      { action: VIDEO, reason: 'ambiguous_configuration' },
      { action: 'video/standard/any', reason: 'ambiguous_configuration' },
    ]);
  });

  it('a sound ruleset has no configuration issues, and every row is priced as runtime would', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'));
    expect(r.configurationIssues).toEqual([]);
    expect(r.actions.map((a) => a.runtime)).toEqual(['priced', 'priced', 'priced']);
  });

  it('previewing never activates anything', async () => {
    await appendixBDraft();
    await run(await account('admin'), { providerCosts: [imageAt4c], marginGuard: { minGrossMarginPercent: 50 } });
    const asOf = await economyNow(dark.db);
    expect(await resolvePlanVersion(dark.db, 'premium_monthly', asOf)).toMatchObject({ ok: false, reason: 'no_effective_version' });
    expect(await resolveRuleset(dark.db, asOf)).toMatchObject({ ok: false, reason: 'no_effective_ruleset' });
    expect((await resolvePackCatalog(dark.db, asOf)).packs).toEqual([]);
  });
});

/* ================================================================== *
 * 3. Missing, mismatched and stale provider costs are explicit
 * ================================================================== */

describe('provider-cost inputs are reported, never guessed', () => {
  it('a missing cost is listed and leaves margins empty -- it is never treated as zero', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'));
    expect(r.inputs.missingProviderCosts).toEqual([IMAGE, VIDEO, VOICE]);
    for (const a of r.actions) {
      expect(a.providerCost).toBeNull();
      expect(a.margins).toEqual([]);
    }
    expect(r.grants[0]!.worstCaseProviderCost).toEqual({ status: 'incomplete', knownWorst: null, missingCosts: [IMAGE, VIDEO, VOICE] });
  });

  it('flags a cost for no action, a unit mismatch and a currency mismatch -- and uses none of them', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'), {
      providerCosts: [
        cost('teleport', 10_000),
        cost('voice_call', 20_000), // per_action, but voice is priced per minute
        cost('image', 40_000, { currency: 'EUR' }),
      ],
    });
    expect(r.inputs.unmatchedProviderCosts).toEqual(['teleport/standard/any']);
    expect(r.inputs.unitMismatches).toEqual([`${VOICE}: action is per_minute, cost is per_action`]);
    expect(r.inputs.currencyMismatches).toEqual([`${IMAGE}: cost in EUR, no purchasable pack in EUR`]);
    expect(action(r, IMAGE).margins).toEqual([]);
    expect(r.inputs.missingProviderCosts).toEqual([VIDEO, VOICE]);
  });

  it('reports undated, stale and future-dated costs against the database clock', async () => {
    await appendixBDraft();
    const day = 86_400_000;
    const now = Date.parse((await economyNow(dark.db)).iso);
    const r = await run(await account('admin'), {
      providerCosts: [
        cost('image', 40_000, { observedAt: new Date(now - 40 * day).toISOString() }),
        cost('voice_call', 20_000, { unit: 'per_minute' }),
        cost('video', 300_000, { maxDurationSeconds: 5, observedAt: new Date(now + 5 * day).toISOString() }),
      ],
      marginGuard: { maxCostAgeDays: 30 },
    });
    expect(r.inputs.staleProviderCosts).toEqual([{ action: IMAGE, ageDays: 40 }]);
    expect(r.inputs.undatedProviderCosts).toEqual([VOICE]);
    expect(r.inputs.futureDatedProviderCosts).toEqual([VIDEO]);
    expect(action(r, IMAGE).providerCost!.ageDays).toBe(40);
  });

  it('without a maximum age, ages are still reported but nothing is judged stale', async () => {
    await appendixBDraft();
    const now = Date.parse((await economyNow(dark.db)).iso);
    const r = await run(await account('admin'), {
      providerCosts: [cost('image', 40_000, { observedAt: new Date(now - 400 * 86_400_000).toISOString() })],
    });
    expect(r.inputs.staleProviderCosts).toEqual([]);
    expect(action(r, IMAGE).providerCost!.ageDays).toBe(400);
  });

  it('a disabled action is listed, and neither priced nor asked for a cost', async () => {
    await plan('premium_monthly', 1, 300);
    await pack('starter', 1, 150, 999, 0);
    await ruleset(1, [
      ['image', 'standard', null, 'per_action', 10],
      ['video', 'standard', 5, 'per_action', 40, false],
    ]);
    const r = await run(await account('admin'));
    expect(r.disabledActions).toEqual([VIDEO]);
    expect(r.actions.map((a) => a.action)).toEqual([IMAGE]);
    expect(r.inputs.missingProviderCosts).toEqual([IMAGE]);
  });

  it('refuses malformed inputs with every reason, rather than guessing', async () => {
    const res = await preview(await account('admin'), {
      mode: 'bogus',
      providerCosts: [cost('image', 0), cost('Image!', 40_000, { currency: 'usd' }), imageAt4c, imageAt4c],
      marginGuard: { minGrossMarginPercent: 100, maxCostAgeDays: 0 },
    });
    expect(res.statusCode).toBe(400);
    const messages = (res.json() as { messages: string[] }).messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        'mode must be "drafted" or "live".',
        'providerCosts[0].amountMicros must be a positive whole number (millionths of the currency unit).',
        'providerCosts[1].actionType is not a valid action key.',
        'providerCosts[1].currency must be a 3-letter code.',
        `providerCosts[3] repeats the cost for ${IMAGE}.`,
        'marginGuard.minGrossMarginPercent must be at least 0 and below 100, to at most two decimal places.',
        'marginGuard.maxCostAgeDays must be a whole number of days from 1 to 3650.',
      ]),
    );
  });
});

/* ================================================================== *
 * 4. The margin guard, at its boundaries
 * ================================================================== */

/**
 * One pack of 100 Credits for $10.00 and a 10-Credit image, so the image
 * retails at exactly $1.00 and a $0.40 cost is exactly a 60% gross margin.
 */
describe('the margin guard compares exact values against the configured floor', () => {
  async function exactDraft() {
    await plan('premium_monthly', 1, 100);
    await pack('unit', 1, 100, 1000, 0);
    await ruleset(1, [['image', 'standard', null, 'per_action', 10]]);
  }
  const guardFor = async (costMicros: number, minGrossMarginPercent?: number) => {
    const r = await run(await account('admin'), {
      providerCosts: [cost('image', costMicros)],
      ...(minGrossMarginPercent === undefined ? {} : { marginGuard: { minGrossMarginPercent } }),
    });
    return { r, image: action(r, IMAGE) };
  };

  it('exactly at the floor is not below it', async () => {
    await exactDraft();
    const { r, image } = await guardFor(400_000, 60);
    expect(image.margins[0]!.grossMarginPercent).toBe('60');
    expect(image.guard).toBe('ok');
    expect(r.marginGuard).toMatchObject({ status: 'evaluated', warnings: [] });
  });

  it('one micro-dollar of cost over the floor warns -- and never displays as meeting it', async () => {
    await exactDraft();
    const { r, image } = await guardFor(400_001, 60);
    expect(image.guard).toBe('below_threshold');
    // The table rounds to a whole percent; the warning is rounded DOWN.
    expect(image.margins[0]!.grossMarginPercent).toBe('60');
    expect(r.marginGuard.warnings).toEqual([{ action: IMAGE, pack: 'unit', grossMarginPercent: '59.99' }]);
  });

  it('a floor set to hundredths is honoured to the hundredth', async () => {
    await exactDraft();
    const { r } = await guardFor(400_000, 60.01);
    expect(r.marginGuard.warnings).toEqual([{ action: IMAGE, pack: 'unit', grossMarginPercent: '60.00' }]);
  });

  it('a negative margin is reported as negative, below a zero floor', async () => {
    await exactDraft();
    const { r } = await guardFor(1_000_001, 0);
    expect(r.marginGuard.warnings).toEqual([{ action: IMAGE, pack: 'unit', grossMarginPercent: '-0.01' }]);
  });

  it('warns at the thinnest rung of the ladder', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'), { providerCosts: [imageAt4c], marginGuard: { minGrossMarginPercent: 92 } });
    // 94% at the entry pack, 90% at the best: only the best-rate rung breaches 92%.
    expect(r.marginGuard.warnings).toEqual([{ action: IMAGE, pack: 'max', grossMarginPercent: '89.99' }]);
  });

  it('with no floor configured, the guard says so and warns about nothing', async () => {
    await exactDraft();
    const { r, image } = await guardFor(900_000);
    expect(r.marginGuard).toEqual({
      status: 'not_configured',
      minGrossMarginPercent: null,
      maxCostAgeDays: null,
      warnings: [],
      notEvaluated: [],
    });
    expect(image.guard).toBe('not_evaluated');
    expect(r.caveats).toContain('No margin threshold is configured, so the guard cannot warn.');
  });

  it('an action it cannot evaluate is named, with the reason', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'), { providerCosts: [imageAt4c], marginGuard: { minGrossMarginPercent: 50 } });
    expect(r.marginGuard.notEvaluated).toEqual([
      { action: VIDEO, reason: 'missing_provider_cost' },
      { action: VOICE, reason: 'missing_provider_cost' },
    ]);
  });

  it('flags an inverted or flat ladder -- the error §31 says the preview exists to catch', async () => {
    await plan('premium_monthly', 1, 100);
    await pack('small', 1, 100, 999, 0);
    await pack('medium', 1, 200, 2100, 1); // dearer per Credit than small
    await pack('large', 1, 400, 4200, 2); // same rate as medium
    await ruleset(1, [['image', 'standard', null, 'per_action', 10]]);
    const r = await run(await account('admin'));
    expect(r.ladders[0]!.issues).toEqual([
      { kind: 'inverted', rung: 'medium', previous: 'small' },
      { kind: 'flat', rung: 'large', previous: 'medium' },
    ]);
  });
});

/* ================================================================== *
 * 5. Read-only, admin-only, and the economy stays dark
 * ================================================================== */

describe('the preview writes nothing', () => {
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
    await appendixBDraft();
    const admin = await account('admin');
    const before = await snapshot();
    for (const mode of ['drafted', 'live']) {
      await run(admin, { mode, providerCosts: [imageAt4c], marginGuard: { minGrossMarginPercent: 95, maxCostAgeDays: 30 } });
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('only an authorised admin can preview', () => {
  it('refuses an anonymous caller and an ordinary user', async () => {
    expect((await preview(null)).statusCode).toBe(401);
    expect((await preview(await account('user'))).statusCode).toBe(403);
  });

  it('with permissions enforced, requires economy.manage', async () => {
    const editor = await account('admin', ['economy_editor']);
    const contentOnly = await account('admin', ['content_editor']);
    const noRoles = await account('admin');
    expect((await preview(editor, {}, enforced)).statusCode).toBe(200);
    for (const cookies of [contentOnly, noRoles]) {
      const res = await preview(cookies, {}, enforced);
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('economy.manage');
    }
  });
});

describe('the economy stays dark', () => {
  it('adds no public economy route', async () => {
    for (const [method, url] of [
      ['GET', '/api/economy'],
      ['GET', '/api/economy/preview'],
      ['POST', '/api/economy/preview'],
      ['GET', '/api/plans'],
      ['GET', '/api/packs'],
      ['GET', '/api/wallet'],
    ] as const) {
      expect((await dark.app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('has no numbers of its own: an empty configuration previews as empty, with every gap stated', async () => {
    const r = await run(await account('admin'));
    expect(r.configuration).toEqual({ plans: [], packs: [], ruleset: null });
    expect(r.ladders).toEqual([]);
    expect(r.grants).toEqual([]);
    expect(r.actions).toEqual([]);
    expect(r.caveats).toEqual(
      expect.arrayContaining([
        'No ruleset is live or drafted, so no action can be priced.',
        'No purchasable pack exists, so no cash price or margin can be shown.',
      ]),
    );
  });
});
