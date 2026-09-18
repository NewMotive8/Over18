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
 * Every figure below that comes from Appendix B uses the PRD's own values (§8
 * action costs, §17 pack ladder, a US$0.04 image cost) as ARITHMETIC FIXTURES,
 * inserted as drafts. They are not authoritative prices and not defaults
 * anywhere in the application: the preview has no numbers of its own, which
 * is the point of several tests here.
 *
 * The only real business figures in this file are the agreed MVP AI cost
 * basis (xAI's Grok 4.6 and Grok Voice prices, section 5). Every usage
 * quantity, deduction and infrastructure amount is a test assumption chosen
 * to make the arithmetic checkable.
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

type Flat = {
  action: string;
  micros: number;
  maxDurationSeconds?: number | null;
  unit?: 'per_action' | 'per_minute';
  currency?: string;
  observedAt?: string | null;
  source?: string | null;
};
const meterFor = (c: Flat) => `${c.action}_${c.maxDurationSeconds ?? 'any'}`;
/**
 * Flat per-generation costs, expressed as a rate card: one fixture provider on
 * its global endpoint, one meter per action, used once per action.
 */
const flat = (...costs: Flat[]) => ({
  providers: [{ provider: 'fixture', endpoint: 'global' }],
  rates: costs.map((c) => ({
    provider: 'fixture',
    meter: meterFor(c),
    kind: 'other',
    amountMicros: c.micros,
    perQuantity: 1,
    currency: c.currency ?? 'USD',
    observedAt: c.observedAt ?? null,
    source: c.source ?? null,
  })),
  usage: {
    actions: costs.map((c) => ({
      actionType: c.action,
      qualityTier: 'standard',
      maxDurationSeconds: c.maxDurationSeconds ?? null,
      unit: c.unit ?? 'per_action',
      meters: [{ provider: 'fixture', meter: meterFor(c), quantity: 1 }],
    })),
  },
});
const IMAGE_4C: Flat = { action: 'image', micros: 40_000, source: 'PRD Appendix B.4 (arithmetic fixture)' };

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
    const r = await run(await account('admin'), flat(IMAGE_4C));
    const image = action(r, IMAGE);
    const at = (packCode: string) => image.grossMargins.find((m) => m.pack === packCode)!;
    expect(at('starter')).toEqual({ pack: 'starter', grossMarginPercent: '94', costMultiple: '16.7' });
    expect(at('max')).toEqual({ pack: 'max', grossMarginPercent: '90', costMultiple: '10.0' });
    expect(image.aiProviderCost).toMatchObject({
      status: 'complete',
      total: { amount: '0.0400', currency: 'USD' },
      regionalPremium: null,
      lines: [{ provider: 'fixture', meter: 'image_any', quantity: '1', source: 'PRD Appendix B.4 (arithmetic fixture)' }],
    });

    // Only the image cost is known, so the worst case is explicitly incomplete.
    const exposure = r.grants[0]!.worstCaseAiProviderCost;
    expect(exposure).toEqual({
      status: 'incomplete',
      knownWorst: { action: IMAGE, cost: { amount: '1.20', currency: 'USD' } },
      missingCosts: [VIDEO, VOICE],
    });
  });

  it('§8.1 -- the worst case is the dearest action to serve, and parity names it', async () => {
    await appendixBDraft();
    // Test-only costs for the two actions the PRD has no figure for.
    const r = await run(
      await account('admin'),
      flat(IMAGE_4C, { action: 'voice_call', micros: 20_000, unit: 'per_minute' }, { action: 'video', micros: 300_000, maxDurationSeconds: 5 }),
    );
    expect(r.grants[0]!.worstCaseAiProviderCost).toEqual({
      status: 'complete',
      action: VIDEO,
      cost: { amount: '2.10', currency: 'USD' }, // 7 videos x $0.30
    });
    expect(r.parity).toEqual({
      thinnestAction: VIDEO,
      highestCostPerCredit: { amount: '0.0075', currency: 'USD' },
      lowestCostPerCredit: { amount: '0.0040', currency: 'USD' },
    });
    expect(r.inputs.missingAiProviderCosts).toEqual([]);
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
    await run(await account('admin'), { ...flat(IMAGE_4C), marginGuard: { minGrossMarginPercent: 50 } });
    const asOf = await economyNow(dark.db);
    expect(await resolvePlanVersion(dark.db, 'premium_monthly', asOf)).toMatchObject({ ok: false, reason: 'no_effective_version' });
    expect(await resolveRuleset(dark.db, asOf)).toMatchObject({ ok: false, reason: 'no_effective_ruleset' });
    expect((await resolvePackCatalog(dark.db, asOf)).packs).toEqual([]);
  });
});

/* ================================================================== *
 * 3. Missing, mismatched and stale provider costs are explicit
 * ================================================================== */

describe('cost inputs are reported, never guessed', () => {
  it('a missing cost is listed and leaves margins empty -- it is never treated as zero', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'));
    expect(r.inputs.missingAiProviderCosts).toEqual([IMAGE, VIDEO, VOICE]);
    for (const a of r.actions) {
      expect(a.aiProviderCost).toEqual({ status: 'incomplete', gaps: [{ reason: 'usage_not_supplied', ref: a.action }] });
      expect(a.aiProviderCostPerCredit).toBeNull();
      expect(a.grossMargins).toEqual([]);
    }
    expect(r.grants[0]!.worstCaseAiProviderCost).toEqual({ status: 'incomplete', knownWorst: null, missingCosts: [IMAGE, VIDEO, VOICE] });
  });

  it('flags usage for no action, a unit mismatch and a currency mismatch -- and prices none of them', async () => {
    await appendixBDraft();
    const r = await run(
      await account('admin'),
      flat(
        { action: 'teleport', micros: 10_000 },
        { action: 'voice_call', micros: 20_000 }, // per_action, but voice is priced per minute
        { action: 'image', micros: 40_000, currency: 'EUR' },
      ),
    );
    expect(r.inputs.unmatched).toEqual(['usage teleport/standard/any']);
    expect(r.inputs.unitMismatches).toEqual([`usage ${VOICE}: action is per_minute, usage is per_action`]);
    expect(r.inputs.currencyMismatches).toEqual([
      `${IMAGE}: AI provider cost in EUR, no purchasable pack in EUR`,
      `${IMAGE}: AI provider cost in EUR, plan premium_monthly in USD`,
    ]);
    expect(action(r, IMAGE).grossMargins).toEqual([]);
    expect(action(r, VOICE).aiProviderCost).toEqual({ status: 'incomplete', gaps: [{ reason: 'unit_mismatch', ref: VOICE }] });
    expect(r.inputs.missingAiProviderCosts).toEqual([VIDEO, VOICE]);
  });

  it('reports undated, stale and future-dated inputs against the database clock', async () => {
    await appendixBDraft();
    const day = 86_400_000;
    const now = Date.parse((await economyNow(dark.db)).iso);
    const r = await run(await account('admin'), {
      ...flat(
        { action: 'image', micros: 40_000, observedAt: new Date(now - 40 * day).toISOString() },
        { action: 'voice_call', micros: 20_000, unit: 'per_minute' },
        { action: 'video', micros: 300_000, maxDurationSeconds: 5, observedAt: new Date(now + 5 * day).toISOString() },
      ),
      marginGuard: { maxCostAgeDays: 30 },
    });
    expect(r.inputs.stale).toEqual([{ input: 'rate fixture/image_any', ageDays: 40 }]);
    expect(r.inputs.undated).toEqual(['rate fixture/voice_call_any']);
    expect(r.inputs.futureDated).toEqual(['rate fixture/video_5']);
    expect(action(r, IMAGE).aiProviderCost).toMatchObject({ status: 'complete', ageDays: 40 });
    expect(action(r, VOICE).aiProviderCost).toMatchObject({ status: 'complete', observedAt: null, ageDays: null });
  });

  it('without a maximum age, ages are still reported but nothing is judged stale', async () => {
    await appendixBDraft();
    const now = Date.parse((await economyNow(dark.db)).iso);
    const r = await run(
      await account('admin'),
      flat({ action: 'image', micros: 40_000, observedAt: new Date(now - 400 * 86_400_000).toISOString() }),
    );
    expect(r.inputs.stale).toEqual([]);
    expect(action(r, IMAGE).aiProviderCost).toMatchObject({ status: 'complete', ageDays: 400 });
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
    expect(r.inputs.missingAiProviderCosts).toEqual([IMAGE]);
  });

  it('refuses malformed inputs with every reason, rather than guessing', async () => {
    const tokens = { provider: 'xai', meter: 'tokens', kind: 'text_generation', amountMicros: 2_000_000, perQuantity: 1_000_000, currency: 'USD' };
    const res = await preview(await account('admin'), {
      mode: 'bogus',
      providerCosts: [],
      providers: [
        { provider: 'xai', endpoint: 'us_regional' },
        { provider: 'fixture', endpoint: 'global', regionalPremiumPercent: 10 },
      ],
      rates: [
        { ...tokens, amountMicros: 0 },
        { provider: 'xai', meter: 'Bad!', kind: 'telepathy', amountMicros: 1, perQuantity: 0, currency: 'usd' },
        tokens,
        tokens,
      ],
      usage: {
        actions: [
          { actionType: 'image', qualityTier: 'standard', unit: 'per_action', meters: [] },
          { actionType: 'voice_call', qualityTier: 'standard', unit: 'per_minute', meters: [{ provider: 'xai', meter: 'tokens', quantity: 0.0000001 }] },
        ],
      },
      salesChannels: [
        {
          channel: 'web',
          deductions: [
            { kind: 'payment_processor' },
            { kind: 'refunds_chargebacks', percentOfPrice: 100 },
            { kind: 'other', fixedAmountMicros: 300_000 },
          ],
        },
        { channel: 'web', deductions: [] },
      ],
      otherCosts: { actions: [{ actionType: 'image', qualityTier: 'standard', unit: 'per_action', kind: 'magic', amountMicros: 5, currency: 'USD' }] },
      marginGuard: { minGrossMarginPercent: 100, minNetMarginPercent: -1, maxCostAgeDays: 0 },
    });
    expect(res.statusCode).toBe(400);
    const messages = (res.json() as { messages: string[] }).messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        'mode must be "drafted" or "live".',
        'providerCosts is no longer accepted: supply rates and usage instead.',
        'providers[0].regionalPremiumPercent must be above 0 and at most 100, to at most four decimal places.',
        'providers[1].regionalPremiumPercent must be null on the global endpoint.',
        'rates[0].amountMicros must be a positive whole number (millionths of the currency unit).',
        'rates[1].meter is not a valid meter key.',
        'rates[1].kind must be one of text_generation, speech_to_speech, speech_to_text, text_to_speech, image_generation, video_generation, other.',
        'rates[1].perQuantity must be a positive whole number of units.',
        'rates[1].currency must be a 3-letter code.',
        'rates[3] repeats the rate for xai/tokens.',
        'usage.actions[0].meters must be an array of 1 to 20 entries.',
        'usage.actions[1].meters[0].quantity must be above 0 and at most 1000000000000, to at most six decimal places.',
        'salesChannels[0].deductions[0] must set percentOfPrice, fixedAmountMicros or both.',
        'salesChannels[0].deductions[1].percentOfPrice must be above 0 and below 100, to at most four decimal places.',
        'salesChannels[0].deductions[2].currency must be a 3-letter code when fixedAmountMicros is set.',
        'salesChannels[1].deductions must be an array of 1 to 20 entries.',
        'salesChannels[1] repeats the sales channel for web.',
        'otherCosts.actions[0].kind must be one of infrastructure, telephony, other.',
        'marginGuard.minGrossMarginPercent must be at least 0 and below 100, to at most two decimal places.',
        'marginGuard.minNetMarginPercent must be at least 0 and below 100, to at most two decimal places.',
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
      ...flat({ action: 'image', micros: costMicros }),
      ...(minGrossMarginPercent === undefined ? {} : { marginGuard: { minGrossMarginPercent } }),
    });
    return { r, image: action(r, IMAGE) };
  };

  it('exactly at the floor is not below it', async () => {
    await exactDraft();
    const { r, image } = await guardFor(400_000, 60);
    expect(image.grossMargins[0]!.grossMarginPercent).toBe('60');
    expect(image.guard).toBe('ok');
    expect(r.marginGuard).toMatchObject({ status: 'evaluated', warnings: [] });
  });

  it('one micro-dollar of cost over the floor warns -- and never displays as meeting it', async () => {
    await exactDraft();
    const { r, image } = await guardFor(400_001, 60);
    expect(image.guard).toBe('below_threshold');
    // The table rounds to a whole percent; the warning is rounded DOWN.
    expect(image.grossMargins[0]!.grossMarginPercent).toBe('60');
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
    const r = await run(await account('admin'), { ...flat(IMAGE_4C), marginGuard: { minGrossMarginPercent: 92 } });
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
      net: { status: 'not_configured', minNetMarginPercent: null, warnings: [], notEvaluated: [] },
    });
    expect(image.guard).toBe('not_evaluated');
    expect(image.netGuard).toBe('not_evaluated');
    expect(r.caveats).toContain('No margin threshold is configured, so the guard cannot warn.');
  });

  it('an action it cannot evaluate is named, with the reason', async () => {
    await appendixBDraft();
    const r = await run(await account('admin'), { ...flat(IMAGE_4C), marginGuard: { minGrossMarginPercent: 50 } });
    expect(r.marginGuard.notEvaluated).toEqual([
      { action: VIDEO, reason: 'ai_provider_cost_incomplete' },
      { action: VOICE, reason: 'ai_provider_cost_incomplete' },
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
 * 5. The agreed MVP cost model: Grok 4.6 text, Grok Voice speech-to-speech,
 *    channel deductions and other costs, kept apart
 * ================================================================== */

/**
 * The agreed MVP AI cost basis: xAI's published prices. These are the only
 * real figures in this file. Everything else in this section -- usage per
 * call minute, a subscriber's month of text, deductions, infrastructure -- is
 * a TEST ASSUMPTION chosen so the arithmetic is checkable by hand.
 */
const MVP_SOURCE = 'Agreed MVP cost basis (xAI price list)';
const xaiRate = (meter: string, kind: string, amountMicros: number, perQuantity: number) => ({
  provider: 'xai',
  meter,
  kind,
  amountMicros,
  perQuantity,
  currency: 'USD',
  source: MVP_SOURCE,
});
const MVP_RATES = [
  xaiRate('grok_4_6_input_tokens', 'text_generation', 2_000_000, 1_000_000), // $2.00 / 1M
  xaiRate('grok_4_6_cached_input_tokens', 'text_generation', 500_000, 1_000_000), // $0.50 / 1M
  xaiRate('grok_4_6_output_tokens', 'text_generation', 6_000_000, 1_000_000), // $6.00 / 1M
  xaiRate('grok_voice_audio_minutes', 'speech_to_speech', 80_000, 1), // $0.08 / audio minute sent or received
  xaiRate('grok_voice_text_input_events', 'speech_to_speech', 4_000, 1), // $0.004 / billable text input event
];
const XAI_GLOBAL = { providers: [{ provider: 'xai', endpoint: 'global' }] };
const XAI_US = { providers: [{ provider: 'xai', endpoint: 'us_regional', regionalPremiumPercent: 10 }] };

const VOICE_TARGET = { actionType: 'voice_call', qualityTier: 'standard', maxDurationSeconds: null, unit: 'per_minute' };
/** Assumption: a call minute sends one audio minute, receives one, and bills one text event. */
const VOICE_STS_METERS = [
  { provider: 'xai', meter: 'grok_voice_audio_minutes', quantity: 2 },
  { provider: 'xai', meter: 'grok_voice_text_input_events', quantity: 1 },
];
/** Assumption: one subscriber's month of unlimited text. */
const CHAT_MONTH_METERS = [
  { provider: 'xai', meter: 'grok_4_6_input_tokens', quantity: 1_000_000 },
  { provider: 'xai', meter: 'grok_4_6_cached_input_tokens', quantity: 3_000_000 },
  { provider: 'xai', meter: 'grok_4_6_output_tokens', quantity: 250_000 },
];
/** Assumptions: a web processor at 10% + $0.30 with 2% refunds; a 30% store commission. */
const WEB = {
  channel: 'web',
  deductions: [
    { kind: 'payment_processor', percentOfPrice: 10, fixedAmountMicros: 300_000, currency: 'USD' },
    { kind: 'refunds_chargebacks', percentOfPrice: 2 },
  ],
};
const APPLE = { channel: 'apple_app_store', deductions: [{ kind: 'apple_app_store', percentOfPrice: 30 }] };
const VOICE_INFRA = { ...VOICE_TARGET, kind: 'infrastructure', amountMicros: 6_000, currency: 'USD' };
const PLAN_INFRA = { plan: 'premium_monthly', kind: 'infrastructure', amountMicros: 500_000, currency: 'USD' };

/** 100 Credits for $10.00; a 5-Credit call minute (so $0.50 retail); a $20.00 month with 100 Credits. */
async function voiceDraft() {
  await plan('premium_monthly', 1, 100, 2000);
  await pack('unit', 1, 100, 1000, 0);
  await ruleset(1, [['voice_call', 'standard', null, 'per_minute', 5]]);
}

/** Every input the model has, so each test removes or changes exactly one thing. */
const mvp = (over: Record<string, unknown> = {}) => ({
  ...XAI_GLOBAL,
  rates: MVP_RATES,
  usage: {
    actions: [{ ...VOICE_TARGET, meters: VOICE_STS_METERS }],
    plans: [{ plan: 'premium_monthly', meters: CHAT_MONTH_METERS }],
  },
  salesChannels: [WEB, APPLE],
  otherCosts: { actions: [VOICE_INFRA], plans: [PLAN_INFRA] },
  ...over,
});

const usd = (amount: string) => ({ amount, currency: 'USD' });

describe('the agreed MVP cost model', () => {
  it('prices a call minute from the Grok Voice speech-to-speech rates, with no separate STT or TTS', async () => {
    await voiceDraft();
    const r = await run(await account('admin'), mvp());
    const voice = action(r, VOICE);
    expect(voice.aiProviderCost).toEqual({
      status: 'complete',
      total: usd('0.1640'),
      base: usd('0.1640'),
      regionalPremium: null,
      lines: [
        { provider: 'xai', meter: 'grok_voice_audio_minutes', kind: 'speech_to_speech', quantity: '2', cost: usd('0.160000'), source: MVP_SOURCE },
        { provider: 'xai', meter: 'grok_voice_text_input_events', kind: 'speech_to_speech', quantity: '1', cost: usd('0.004000'), source: MVP_SOURCE },
      ],
      observedAt: null,
      ageDays: null,
    });
    // Gross is price less the AI provider cost only: $0.50 against $0.164.
    expect(voice.grossMargins).toEqual([{ pack: 'unit', grossMarginPercent: '67', costMultiple: '3.0' }]);
    expect(r.inputs.unusedRates).toEqual([]);
  });

  it("prices a subscriber's month of text from the Grok 4.6 token rates, cached input at its own rate", async () => {
    await voiceDraft();
    const r = await run(await account('admin'), mvp());
    expect(r.subscriptions[0]!.includedUsage).toMatchObject({
      status: 'complete',
      total: usd('5.0000'),
      lines: [
        { meter: 'grok_4_6_input_tokens', kind: 'text_generation', quantity: '1000000', cost: usd('2.000000') },
        { meter: 'grok_4_6_cached_input_tokens', kind: 'text_generation', quantity: '3000000', cost: usd('1.500000') },
        { meter: 'grok_4_6_output_tokens', kind: 'text_generation', quantity: '250000', cost: usd('1.500000') },
      ],
    });
  });

  it('adds the documented regional premium only when the provider is declared on its US regional endpoint', async () => {
    await voiceDraft();
    const admin = await account('admin');
    const regional = await run(admin, mvp(XAI_US));
    expect(action(regional, VOICE).aiProviderCost).toMatchObject({
      base: usd('0.1640'),
      regionalPremium: usd('0.0164'),
      total: usd('0.1804'),
    });
    expect(regional.subscriptions[0]!.includedUsage).toMatchObject({ base: usd('5.0000'), total: usd('5.5000') });

    const global = await run(admin, mvp());
    expect(action(global, VOICE).aiProviderCost).toMatchObject({ regionalPremium: null, total: usd('0.1640') });
  });

  it('an undeclared endpoint leaves the cost incomplete, rather than assuming either way', async () => {
    await voiceDraft();
    const r = await run(await account('admin'), mvp({ providers: [] }));
    const gap = { status: 'incomplete', gaps: [{ reason: 'endpoint_not_declared', ref: 'xai' }] };
    expect(action(r, VOICE).aiProviderCost).toEqual(gap);
    expect(r.subscriptions[0]!.includedUsage).toEqual(gap);
    expect(r.inputs.missingAiProviderCosts).toEqual([VOICE]);
  });

  it('a meter with no rate is a named gap, never a zero', async () => {
    await voiceDraft();
    const r = await run(await account('admin'), mvp({ rates: MVP_RATES.filter((x) => x.meter !== 'grok_voice_text_input_events') }));
    expect(action(r, VOICE).aiProviderCost).toEqual({
      status: 'incomplete',
      gaps: [{ reason: 'rate_not_supplied', ref: 'xai/grok_voice_text_input_events' }],
    });
    expect(action(r, VOICE).net).toEqual({ status: 'incomplete', gaps: [{ reason: 'ai_provider_cost_incomplete', ref: VOICE }] });
  });

  it('refuses speech-to-speech combined with separate STT or TTS meters, which would count them twice', async () => {
    await voiceDraft();
    const admin = await account('admin');
    const cascade = [
      { provider: 'stt_vendor', meter: 'transcription_minutes', kind: 'speech_to_text', amountMicros: 6_000, perQuantity: 1, currency: 'USD' },
      { provider: 'tts_vendor', meter: 'synthesis_minutes', kind: 'text_to_speech', amountMicros: 15_000, perQuantity: 1, currency: 'USD' },
    ];
    const res = await preview(admin, {
      ...XAI_GLOBAL,
      rates: [...MVP_RATES, ...cascade],
      usage: {
        actions: [{ ...VOICE_TARGET, meters: [...VOICE_STS_METERS, { provider: 'stt_vendor', meter: 'transcription_minutes', quantity: 1 }] }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { messages: string[] }).messages).toEqual([
      'usage.actions[0] combines speech-to-speech with a separate speech-to-text or text-to-speech meter, which would count recognition and synthesis twice.',
    ]);

    // A cascaded pipeline WITHOUT speech-to-speech is a different path, and is allowed.
    const cascaded = await run(admin, {
      providers: [...XAI_GLOBAL.providers, { provider: 'stt_vendor', endpoint: 'global' }, { provider: 'tts_vendor', endpoint: 'global' }],
      rates: [...MVP_RATES, ...cascade],
      usage: {
        actions: [
          {
            ...VOICE_TARGET,
            meters: [
              { provider: 'stt_vendor', meter: 'transcription_minutes', quantity: 1 },
              { provider: 'xai', meter: 'grok_4_6_input_tokens', quantity: 2_000 },
              { provider: 'xai', meter: 'grok_4_6_output_tokens', quantity: 500 },
              { provider: 'tts_vendor', meter: 'synthesis_minutes', quantity: 1 },
            ],
          },
        ],
      },
    });
    // $0.006 + $0.004 + $0.003 + $0.015
    expect(action(cascaded, VOICE).aiProviderCost).toMatchObject({ status: 'complete', total: usd('0.0280') });
  });

  it('deducts each sales channel on its own: a web sale pays the processor, an App Store sale pays Apple, never both', async () => {
    await voiceDraft();
    const r = await run(await account('admin'), mvp());
    const voice = action(r, VOICE);
    expect(voice.otherCosts).toEqual({
      lines: [{ kind: 'infrastructure', label: null, cost: usd('0.0060') }],
      infrastructure: 'supplied',
    });
    // Web: a $10.00 pack loses 10% + $0.30 + 2% = $1.50, so a 5-Credit minute
    // carries $0.075 of it. $0.50 - $0.075 - $0.164 - $0.006 = $0.255.
    // Apple: 30% of $10.00 = $3.00, $0.15 a minute. $0.50 - $0.15 - $0.164 - $0.006 = $0.18.
    expect(voice.net).toEqual({
      status: 'complete',
      channels: [
        { channel: 'web', rungs: [{ pack: 'unit', deductions: usd('0.0750'), contribution: usd('0.2550'), netMarginPercent: '51' }] },
        { channel: 'apple_app_store', rungs: [{ pack: 'unit', deductions: usd('0.1500'), contribution: usd('0.1800'), netMarginPercent: '36' }] },
      ],
    });
  });

  it('counts telephony when it is supplied, without requiring it', async () => {
    await voiceDraft();
    const telephony = { ...VOICE_TARGET, kind: 'telephony', label: 'pstn', amountMicros: 10_000, currency: 'USD' };
    const r = await run(await account('admin'), mvp({ otherCosts: { actions: [VOICE_INFRA, telephony], plans: [PLAN_INFRA] } }));
    const voice = action(r, VOICE);
    expect(voice.otherCosts.lines.map((l) => [l.kind, l.label, l.cost.amount])).toEqual([
      ['infrastructure', null, '0.0060'],
      ['telephony', 'pstn', '0.0100'],
    ]);
    expect(voice.net.status === 'complete' && voice.net.channels[0]!.rungs[0]!.contribution).toEqual(usd('0.2450'));
  });

  it("nets a subscriber's month: price less deductions, included text, the grant's worst case and infrastructure", async () => {
    await voiceDraft();
    const r = await run(await account('admin'), mvp());
    // The B.4 figure is AI provider cost only: 20 minutes x $0.164.
    expect(r.grants[0]!.worstCaseAiProviderCost).toEqual({ status: 'complete', action: VOICE, cost: usd('3.28') });
    // Web: $20.00 - ($2.40 + $0.30) - $5.00 text - 20 x ($0.164 + $0.006) - $0.50 = $8.40.
    // Apple: $20.00 - $6.00 - $5.00 - $3.40 - $0.50 = $5.10, 25.5% -> 26.
    expect(r.subscriptions[0]).toMatchObject({
      plan: 'premium_monthly',
      source: 'draft',
      pricePerMonth: usd('20.00'),
      grantWorstCase: { status: 'complete', action: VOICE, cost: usd('3.40') },
      otherCosts: { lines: [{ kind: 'infrastructure', label: null, cost: usd('0.50') }], infrastructure: 'supplied' },
      net: {
        status: 'complete',
        channels: [
          { channel: 'web', deductions: usd('2.70'), contribution: usd('8.40'), netMarginPercent: '42' },
          { channel: 'apple_app_store', deductions: usd('6.00'), contribution: usd('5.10'), netMarginPercent: '26' },
        ],
      },
    });
  });

  it('names every gap instead of producing a net figure from partial inputs', async () => {
    await voiceDraft();
    const r = await run(
      await account('admin'),
      mvp({ salesChannels: [], otherCosts: {}, usage: { actions: [{ ...VOICE_TARGET, meters: VOICE_STS_METERS }] } }),
    );
    const voice = action(r, VOICE);
    // Gross needs only the AI provider cost, so it is still shown.
    expect(voice.grossMargins).toHaveLength(1);
    expect(voice.otherCosts).toEqual({ lines: [], infrastructure: 'not_supplied' });
    expect(voice.net).toEqual({
      status: 'incomplete',
      gaps: [
        { reason: 'infrastructure_not_supplied', ref: VOICE },
        { reason: 'sales_channel_not_supplied', ref: 'sales_channels' },
      ],
    });
    const sub = r.subscriptions[0]!;
    expect(sub.includedUsage).toEqual({ status: 'incomplete', gaps: [{ reason: 'usage_not_supplied', ref: 'plan:premium_monthly' }] });
    expect(sub.grantWorstCase).toEqual({ status: 'incomplete', gaps: [{ reason: 'grant_cost_incomplete', ref: VOICE }] });
    expect(sub.net).toEqual({
      status: 'incomplete',
      gaps: [
        { reason: 'ai_provider_cost_incomplete', ref: 'plan:premium_monthly' },
        { reason: 'grant_cost_incomplete', ref: VOICE },
        { reason: 'infrastructure_not_supplied', ref: 'plan:premium_monthly' },
        { reason: 'sales_channel_not_supplied', ref: 'sales_channels' },
      ],
    });
    expect(r.inputs.unusedRates).toEqual(['xai/grok_4_6_input_tokens', 'xai/grok_4_6_cached_input_tokens', 'xai/grok_4_6_output_tokens']);
  });

  it('assumes nothing: the agreed rates alone price nothing, because usage is an input too', async () => {
    await voiceDraft();
    const r = await run(await account('admin'), { ...XAI_GLOBAL, rates: MVP_RATES });
    expect(action(r, VOICE).aiProviderCost).toEqual({ status: 'incomplete', gaps: [{ reason: 'usage_not_supplied', ref: VOICE }] });
    expect(action(r, VOICE).net.status).toBe('incomplete');
    expect(r.subscriptions[0]!.net.status).toBe('incomplete');
    expect(r.inputs.unusedRates).toHaveLength(MVP_RATES.length);
  });

  it('evaluates a net floor exactly, at the thinnest channel and rung', async () => {
    await voiceDraft();
    const admin = await account('admin');
    const at = async (minNetMarginPercent: number) => run(admin, mvp({ marginGuard: { minNetMarginPercent } }));

    const exact = await at(36); // Apple is exactly 36%
    expect(exact.marginGuard.net).toEqual({ status: 'evaluated', minNetMarginPercent: 36, warnings: [], notEvaluated: [] });
    expect(action(exact, VOICE).netGuard).toBe('ok');
    // The gross guard is a separate floor, and was not configured.
    expect(exact.marginGuard.status).toBe('not_configured');

    const above = await at(36.01);
    expect(above.marginGuard.net.warnings).toEqual([
      { action: VOICE, channel: 'apple_app_store', pack: 'unit', netMarginPercent: '36.00' },
    ]);
    expect(action(above, VOICE).netGuard).toBe('below_threshold');
  });

  it('a net floor cannot pass an action whose net is incomplete', async () => {
    await voiceDraft();
    const r = await run(await account('admin'), mvp({ salesChannels: [], marginGuard: { minNetMarginPercent: 10 } }));
    expect(r.marginGuard.net.notEvaluated).toEqual([{ action: VOICE, reason: 'net_incomplete' }]);
    expect(action(r, VOICE).netGuard).toBe('not_evaluated');
  });
});

/* ================================================================== *
 * 6. Read-only, admin-only, and the economy stays dark
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
    await voiceDraft();
    const admin = await account('admin');
    const before = await snapshot();
    for (const mode of ['drafted', 'live']) {
      await run(admin, mvp({ mode, marginGuard: { minGrossMarginPercent: 95, minNetMarginPercent: 95, maxCostAgeDays: 30 } }));
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
    expect(r.subscriptions).toEqual([]);
    expect(r.caveats).toEqual(
      expect.arrayContaining([
        'No ruleset is live or drafted, so no action can be priced.',
        'No purchasable pack exists, so no cash price or margin can be shown.',
      ]),
    );
  });
});
