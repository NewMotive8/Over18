import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AdminRoleName, EconomyConfigurationView, EconomyPublishReview } from '@over18/shared';
import { buildApp } from '../app.js';
import { createDb } from '../db/client.js';
import { adminRoleGrants, users } from '../db/schema.js';
import { economyNow, resolvePackCatalog, resolvePlanCatalog, resolvePlanVersion, resolveRuleset } from '../services/economy-resolver.js';
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
 * P1 -- the economy configuration workflow: drafts, review, publish, cancel.
 *
 * Every price, cost, grant and allowance below is a TEST FIXTURE chosen by the
 * test; the application holds none. The catalogue (feature flags, action
 * types, tiers, allowance keys) is the only fixed vocabulary.
 */

let dark: TestContext; // production defaults: enforcement, audit hook and economy all off
let enforced: TestContext;
let economyOn: TestContext;
let seq = 0;

beforeAll(async () => {
  migrateTestDb();
  dark = await createTestContext();
  enforced = await createTestContext({ adminPermissionsEnforced: true });
  const { db, pool } = createDb(TEST_DATABASE_URL);
  economyOn = { app: await buildApp({ ...testEnv, commerce: { ...testEnv.commerce, enabled: true } }, db), db, pool };
});
afterAll(async () => {
  await destroyTestContext(dark);
  await destroyTestContext(enforced);
  await destroyTestContext(economyOn);
});
beforeEach(async () => truncateAll(dark));

const q = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  dark.pool.query<T>(text, params);

type Cookies = Record<string, string>;
async function account(kind: 'admin' | 'user', roles: AdminRoleName[] = []): Promise<Cookies> {
  const email = `economy-admin-${kind}-${process.pid}-${++seq}@example.com`;
  const res = await dark.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'economy-pass-1' } });
  expect(res.statusCode).toBe(201);
  const cookie = extractSessionCookie(res)!;
  const [row] = await dark.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (kind === 'admin') await dark.db.update(users).set({ role: 'admin' }).where(eq(users.id, row!.id));
  for (const role of roles) await dark.db.insert(adminRoleGrants).values({ userId: row!.id, role });
  return { [cookie.name]: cookie.value };
}

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';
const call = (cookies: Cookies | null, method: Method, url: string, payload?: unknown, on: TestContext = dark) =>
  on.app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }), ...(cookies ? { cookies } : {}) });

/* ------------------------------------------------------------------ *
 * Test fixtures -- values chosen by the test, never by the application
 * ------------------------------------------------------------------ */

const FEATURES = { unlimited_text: true, full_character_access: true, advanced_media_access: false, voice_access: false };
const PLAN = (over: Record<string, unknown> = {}) => ({
  displayName: 'Fixture plan',
  billingPeriodMonths: 1,
  priceMinor: 1000,
  currency: 'USD',
  monthlyIncludedCredits: 100,
  features: FEATURES,
  isPurchasable: true,
  ...over,
});
const PACK = (over: Record<string, unknown> = {}) => ({
  displayName: 'Fixture pack',
  credits: 100,
  priceMinor: 500,
  currency: 'USD',
  sortOrder: 0,
  isBestValue: false,
  isPurchasable: true,
  ...over,
});
const ALLOWANCES = {
  free_first_conversation_messages: 3,
  free_daily_messages: 2,
  signup_grant_credits: 4,
  grace_period_days: 5,
  reward_monthly_cap_credits: 6,
};
const cost = (actionType: string, unit: 'per_action' | 'per_minute', creditCost: number, maxDurationSeconds: number | null = null, qualityTier = 'standard') => ({
  actionType,
  qualityTier,
  maxDurationSeconds,
  unit,
  creditCost,
  enabled: true,
});
const RULESET = (over: Record<string, unknown> = {}) => ({
  actionCosts: [cost('image', 'per_action', 7), cost('voice_call', 'per_minute', 3), cost('video', 'per_action', 20, 5)],
  allowances: ALLOWANCES,
  rewards: [{ rewardKey: 'referral', credits: 2, perUserCap: null, enabled: true }],
  ...over,
});

const config = async (cookies: Cookies) => (await call(cookies, 'GET', '/admin/economy/configuration')).json() as EconomyConfigurationView;
const review = async (cookies: Cookies) => {
  const res = await call(cookies, 'GET', '/admin/economy/publish/review');
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as EconomyPublishReview;
};
const publish = async (cookies: Cookies, body: Record<string, unknown> = {}) => {
  const token = (await review(cookies)).draftSetToken;
  return call(cookies, 'POST', '/admin/economy/publish', { reason: 'Fixture publish', draftSetToken: token, ...body });
};
const inFuture = async (interval: string) =>
  new Date((await q<{ t: Date }>(`SELECT clock_timestamp() + interval '${interval}' AS t`)).rows[0]!.t).toISOString();
const auditRows = async (action?: string) =>
  (
    await q<{ action: string; object_id: string | null; before: unknown; after: unknown; reason: string | null; actor_email: string | null }>(
      `SELECT action, object_id, before, after, reason, actor_email FROM audit_log ${action ? 'WHERE action = $1' : ''} ORDER BY id`,
      action ? [action] : [],
    )
  ).rows;

/** A complete, published baseline: one plan, one pack, one ruleset. */
async function liveBaseline(admin: Cookies) {
  expect((await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN())).statusCode).toBe(200);
  expect((await call(admin, 'PUT', '/admin/economy/packs/fixture_small/draft', PACK())).statusCode).toBe(200);
  expect((await call(admin, 'PUT', '/admin/economy/ruleset/draft', RULESET())).statusCode).toBe(200);
  const res = await publish(admin, { reason: 'Baseline' });
  expect(res.statusCode, res.body).toBe(200);
}

/* ================================================================== *
 * Access: economy.manage on every endpoint
 * ================================================================== */

const UUID = '00000000-0000-4000-8000-000000000009';
const ENDPOINTS: Array<[Method, string, unknown?]> = [
  ['GET', '/admin/economy/configuration'],
  ['PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN()],
  ['DELETE', '/admin/economy/plans/fixture_monthly/draft'],
  ['PUT', '/admin/economy/packs/fixture_small/draft', PACK()],
  ['DELETE', '/admin/economy/packs/fixture_small/draft'],
  ['PUT', '/admin/economy/ruleset/draft', RULESET()],
  ['DELETE', '/admin/economy/ruleset/draft'],
  ['GET', '/admin/economy/publish/review'],
  ['POST', '/admin/economy/publish', { reason: 'x', draftSetToken: 'a'.repeat(64) }],
  ['POST', `/admin/economy/versions/plan/${UUID}/cancel`, { reason: 'x' }],
  ['POST', '/admin/economy/preview', {}],
];

describe('every economy admin endpoint requires economy.manage', () => {
  it('refuses an anonymous caller and an ordinary user', async () => {
    const user = await account('user');
    for (const [method, url, payload] of ENDPOINTS) {
      expect((await call(null, method, url, payload)).statusCode, `${method} ${url}`).toBe(401);
      expect((await call(user, method, url, payload)).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('with permissions enforced, admits economy_editor and refuses other roles', async () => {
    const editor = await account('admin', ['economy_editor']);
    const content = await account('admin', ['content_editor']);
    for (const [method, url, payload] of ENDPOINTS) {
      const refused = await call(content, method, url, payload, enforced);
      expect(refused.statusCode, `${method} ${url}`).toBe(403);
      expect(refused.body).toContain('economy.manage');
      expect([401, 403], `${method} ${url}`).not.toContain((await call(editor, method, url, payload, enforced)).statusCode);
    }
  });
});

/* ================================================================== *
 * Drafts
 * ================================================================== */

describe('drafts', () => {
  it('saving a plan draft creates the plan at version 1; saving again replaces the same draft', async () => {
    const admin = await account('admin');
    const first = await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN());
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ version: 1, state: 'draft', priceMinor: 1000, effectiveFrom: null, publishedAt: null });
    const second = await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ priceMinor: 1200 }));
    expect(second.json()).toMatchObject({ id: first.json().id, version: 1, priceMinor: 1200 });
    const view = await config(admin);
    expect(view.plans.map((p) => [p.code, p.versions.map((v) => [v.version, v.state])])).toEqual([['fixture_monthly', [[1, 'draft']]]]);
  });

  it('refuses an invalid draft with every reason, and writes nothing', async () => {
    const admin = await account('admin');
    const res = await call(
      admin,
      'PUT',
      '/admin/economy/plans/fixture_monthly/draft',
      PLAN({ priceMinor: 0, currency: 'usd', billingPeriodMonths: 40, features: { ...FEATURES, teleport: true } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_configuration' });
    expect(res.json().messages).toEqual(
      expect.arrayContaining([
        'priceMinor must be a positive whole number of minor units.',
        'currency must be a 3-letter code.',
        'billingPeriodMonths must be a whole number from 1 to 36.',
        expect.stringContaining('features.teleport is not a catalogue feature'),
      ]),
    );
    expect((await q('SELECT 1 FROM economy_plans')).rowCount).toBe(0);
    expect(await auditRows()).toEqual([]);
    expect((await call(admin, 'PUT', '/admin/economy/plans/Not-A-Code/draft', PLAN())).statusCode).toBe(400);
  });

  it('discarding deletes the draft, and a plan left with no version at all', async () => {
    const admin = await account('admin');
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN());
    expect((await call(admin, 'DELETE', '/admin/economy/plans/fixture_monthly/draft')).statusCode).toBe(204);
    expect((await config(admin)).plans).toEqual([]);
    expect((await call(admin, 'DELETE', '/admin/economy/plans/fixture_monthly/draft')).statusCode).toBe(404);
  });

  it('pack drafts work the same way', async () => {
    const admin = await account('admin');
    expect((await call(admin, 'PUT', '/admin/economy/packs/fixture_small/draft', PACK())).json()).toMatchObject({ version: 1, state: 'draft', credits: 100 });
    expect((await call(admin, 'PUT', '/admin/economy/packs/fixture_small/draft', PACK({ credits: 0 }))).statusCode).toBe(400);
    expect((await call(admin, 'DELETE', '/admin/economy/packs/fixture_small/draft')).statusCode).toBe(204);
  });

  it('holds a ruleset to the key catalogue', async () => {
    const admin = await account('admin');
    const res = await call(
      admin,
      'PUT',
      '/admin/economy/ruleset/draft',
      RULESET({
        actionCosts: [
          cost('teleport', 'per_action', 1),
          cost('voice_call', 'per_action', 1),
          cost('video', 'per_action', 1),
          cost('image', 'per_action', 1, 5),
          cost('voice_message', 'per_action', 1, null, 'ultra'),
          cost('image', 'per_action', 0),
        ],
        allowances: { ...ALLOWANCES, bonus_credits: 1 },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('actionCosts[0].actionType "teleport" is not in the catalogue'),
        'actionCosts[1].unit must be per_minute for voice_call.',
        'actionCosts[2].maxDurationSeconds is required for video: its costs are split by duration.',
        'actionCosts[3].maxDurationSeconds must be null for image: it has no duration tiers.',
        'actionCosts[4].qualityTier must be one of standard, high.',
        'actionCosts[5].creditCost must be a positive whole number; a free action is disabled, not priced at 0.',
        expect.stringContaining('allowances.bonus_credits is not a catalogue allowance'),
      ]),
    );
  });

  it('a ruleset draft is replaced whole, never merged row by row', async () => {
    const admin = await account('admin');
    await call(admin, 'PUT', '/admin/economy/ruleset/draft', RULESET());
    const res = await call(admin, 'PUT', '/admin/economy/ruleset/draft', RULESET({ actionCosts: [cost('image', 'per_action', 9)], rewards: [] }));
    expect(res.json()).toMatchObject({ version: 1, state: 'draft', rewards: [] });
    expect(res.json().actionCosts.map((c: { actionType: string; creditCost: number }) => [c.actionType, c.creditCost])).toEqual([['image', 9]]);
  });
});

/* ================================================================== *
 * Audit
 * ================================================================== */

describe('every change is audited -- actor, before, after, reason -- with the generic hook off', () => {
  it('records draft saves with the real before and after', async () => {
    const admin = await account('admin');
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', { ...PLAN(), reason: 'First draft' });
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', { ...PLAN({ priceMinor: 1200 }), reason: 'Price rethink' });
    const rows = await auditRows('economy.plan.draft.save');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ object_id: 'fixture_monthly', before: null, reason: 'First draft' });
    expect(rows[1]).toMatchObject({ reason: 'Price rethink', before: expect.objectContaining({ priceMinor: 1000 }), after: expect.objectContaining({ priceMinor: 1200 }) });
    expect(rows[1]!.actor_email).toContain('economy-admin-admin');
  });

  it('records each published version with what it superseded, and the publish reason', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ priceMinor: 1500 }));
    expect((await publish(admin, { reason: 'Price increase' })).statusCode).toBe(200);
    const rows = await auditRows('economy.plan.publish');
    expect(rows.map((r) => r.reason)).toEqual(['Baseline', 'Price increase']);
    expect(rows[0]!.before).toBeNull();
    expect(rows[1]).toMatchObject({ before: expect.objectContaining({ version: 1, priceMinor: 1000 }), after: expect.objectContaining({ version: 2, priceMinor: 1500 }) });
    expect((await auditRows('economy.ruleset.publish')).map((r) => r.reason)).toEqual(['Baseline']);
  });
});

/* ================================================================== *
 * Review and publish
 * ================================================================== */

describe('review', () => {
  it('diffs a new plan against nothing live, and blocks an economy with no ruleset', async () => {
    const admin = await account('admin');
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN());
    const r = await review(admin);
    expect(r.draftSetToken).toMatch(/^[0-9a-f]{64}$/);
    expect(r.diff).toEqual([
      expect.objectContaining({ kind: 'plan', code: 'fixture_monthly', draftVersion: 1, liveVersion: null }),
    ]);
    expect(r.diff[0]!.changes).toContainEqual({ field: 'priceMinor', before: null, after: 1000 });
    expect(r.diff[0]!.changes).toContainEqual({ field: 'features.unlimited_text', before: null, after: true });
    expect(r.errors).toEqual(['A ruleset must be live or drafted: the economy cannot be published without action costs and allowances.']);
  });

  it('diffs old -> new against the live version, field by field', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ priceMinor: 1500, features: { ...FEATURES, voice_access: true } }));
    await call(admin, 'PUT', '/admin/economy/ruleset/draft', RULESET({ actionCosts: [cost('image', 'per_action', 8), cost('voice_call', 'per_minute', 3), cost('video', 'per_action', 20, 5)] }));
    const r = await review(admin);
    expect(r.errors).toEqual([]);
    const plan = r.diff.find((d) => d.kind === 'plan')!;
    expect(plan).toMatchObject({ draftVersion: 2, liveVersion: 1 });
    expect(plan.changes).toEqual([
      { field: 'priceMinor', before: 1000, after: 1500 },
      { field: 'features.voice_access', before: false, after: true },
    ]);
    expect(r.diff.find((d) => d.kind === 'ruleset')!.changes).toEqual([
      { field: 'actionCosts.image/standard/any', before: { unit: 'per_action', creditCost: 7, enabled: true }, after: { unit: 'per_action', creditCost: 8, enabled: true } },
    ]);
  });

  it('warns about an inverted ladder without blocking', async () => {
    const admin = await account('admin');
    await call(admin, 'PUT', '/admin/economy/packs/fixture_small/draft', PACK({ credits: 100, priceMinor: 500, sortOrder: 0 }));
    await call(admin, 'PUT', '/admin/economy/packs/fixture_large/draft', PACK({ credits: 200, priceMinor: 1200, sortOrder: 1 }));
    await call(admin, 'PUT', '/admin/economy/ruleset/draft', RULESET());
    const r = await review(admin);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContain('Pack fixture_large is dearer per Credit than fixture_small (USD).');
  });
});

describe('publish', () => {
  it('refuses an incomplete configuration with every reason, and publishes nothing', async () => {
    const admin = await account('admin');
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ features: { unlimited_text: true } }));
    await call(admin, 'PUT', '/admin/economy/ruleset/draft', RULESET({ actionCosts: [{ ...cost('image', 'per_action', 7), enabled: false }], allowances: { free_daily_messages: 2 } }));
    const res = await publish(admin);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_publishable');
    expect(res.json().messages).toEqual(
      expect.arrayContaining([
        'Plan fixture_monthly: features.voice_access must be stated before publishing.',
        'Ruleset: At least one action cost must be enabled before publishing.',
        'Ruleset: allowances.grace_period_days must be set before publishing.',
      ]),
    );
    const view = await config(admin);
    expect(view.plans[0]!.versions.map((v) => v.state)).toEqual(['draft']);
    expect(view.rulesets.map((v) => v.state)).toEqual(['draft']);
  });

  it('publishes every draft together, now -- and the resolver serves exactly them', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    const asOf = await economyNow(dark.db);
    expect((await resolvePlanCatalog(dark.db, asOf)).plans.map((p) => [p.ref.code, p.ref.version, p.priceMinor])).toEqual([['fixture_monthly', 1, 1000]]);
    expect((await resolvePackCatalog(dark.db, asOf)).packs.map((p) => [p.ref.code, p.credits])).toEqual([['fixture_small', 100]]);
    const rules = await resolveRuleset(dark.db, asOf);
    expect(rules.ok && Object.fromEntries(rules.value.allowances)).toEqual(ALLOWANCES);
    const view = await config(admin);
    expect([...view.plans, ...view.packs].flatMap((p) => p.versions.map((v) => v.state))).toEqual(['active', 'active']);
    expect(view.rulesets[0]).toMatchObject({ state: 'active', publishReason: 'Baseline' });
  });

  it('refuses drafts that changed after they were reviewed', async () => {
    const admin = await account('admin');
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN());
    await call(admin, 'PUT', '/admin/economy/ruleset/draft', RULESET());
    const token = (await review(admin)).draftSetToken;
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ priceMinor: 999 }));
    const res = await call(admin, 'POST', '/admin/economy/publish', { reason: 'Stale', draftSetToken: token });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('drafts_changed');
    expect((await config(admin)).plans[0]!.versions.map((v) => v.state)).toEqual(['draft']);
  });

  it('with nothing drafted, there is nothing to publish', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    const r = await review(admin);
    expect(r.errors).toEqual(['There are no drafts to publish.']);
    expect((await call(admin, 'POST', '/admin/economy/publish', { reason: 'Empty', draftSetToken: r.draftSetToken })).statusCode).toBe(409);
  });

  it('is atomic: when one version cannot be published, none is', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    // Schedule pack v2 a week out: a later pack version can then only take effect after it.
    await call(admin, 'PUT', '/admin/economy/packs/fixture_small/draft', PACK({ credits: 120 }));
    expect((await publish(admin, { effectiveFrom: await inFuture('7 days') })).statusCode).toBe(200);
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ priceMinor: 1500 }));
    await call(admin, 'PUT', '/admin/economy/packs/fixture_small/draft', PACK({ credits: 150 }));
    const r = await review(admin);
    expect(r.warnings).toEqual([expect.stringContaining('Pack fixture_small v2 is scheduled for')]);
    const res = await call(admin, 'POST', '/admin/economy/publish', { reason: 'Too soon', draftSetToken: r.draftSetToken });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('economy_conflict');
    // The plan draft, published first inside the transaction, rolled back with the pack.
    const view = await config(admin);
    expect(view.plans[0]!.versions.map((v) => [v.version, v.state])).toEqual([[1, 'active'], [2, 'draft']]);
    expect((await auditRows('economy.plan.publish')).map((row) => row.reason)).toEqual(['Baseline']);
  });
});

/* ================================================================== *
 * Scheduling, cancellation and retirement
 * ================================================================== */

describe('scheduling, cancellation and retirement', () => {
  it('a scheduled publish takes effect only at its instant', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ priceMinor: 1500 }));
    const at = await inFuture('7 days');
    const res = await publish(admin, { effectiveFrom: at });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().published).toEqual([expect.objectContaining({ kind: 'plan', version: 2 })]);
    expect((await config(admin)).plans[0]!.versions.map((v) => [v.version, v.state])).toEqual([[1, 'active'], [2, 'scheduled']]);
    const live = await resolvePlanVersion(dark.db, 'fixture_monthly', await economyNow(dark.db));
    expect(live.ok && live.value.ref.version).toBe(1);
  });

  it('refuses an effective instant in the past', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ priceMinor: 1500 }));
    const res = await publish(admin, { effectiveFrom: '2020-01-01T00:00:00Z' });
    expect(res.statusCode).toBe(400);
    expect(res.json().messages).toEqual(['effectiveFrom must be in the future; send null to publish now.']);
  });

  it('cancels a scheduled version, with a reason, audited -- and nothing that has taken effect', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ priceMinor: 1500 }));
    await publish(admin, { effectiveFrom: await inFuture('7 days') });
    const [v1, v2] = (await config(admin)).plans[0]!.versions;
    expect((await call(admin, 'POST', `/admin/economy/versions/plan/${v2!.id}/cancel`, { reason: 'Changed our mind' })).statusCode).toBe(204);
    expect((await config(admin)).plans[0]!.versions.map((v) => v.state)).toEqual(['active', 'cancelled']);
    expect(await auditRows('economy.plan.cancel')).toEqual([
      expect.objectContaining({ reason: 'Changed our mind', before: expect.objectContaining({ state: 'scheduled' }), after: expect.objectContaining({ state: 'cancelled' }) }),
    ]);
    const active = await call(admin, 'POST', `/admin/economy/versions/plan/${v1!.id}/cancel`, { reason: 'No' });
    expect(active.statusCode).toBe(409);
    expect((await call(admin, 'POST', `/admin/economy/versions/plan/${UUID}/cancel`, { reason: 'No' })).statusCode).toBe(404);
    expect((await call(admin, 'POST', `/admin/economy/versions/wallet/${UUID}/cancel`, { reason: 'No' })).statusCode).toBe(404);
  });

  it('cannot cancel inside the one-minute margin before a version takes effect', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ priceMinor: 1500 }));
    await publish(admin, { effectiveFrom: await inFuture('30 seconds') });
    const v2 = (await config(admin)).plans[0]!.versions[1]!;
    const res = await call(admin, 'POST', `/admin/economy/versions/plan/${v2.id}/cancel`, { reason: 'Too late' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('can no longer be cancelled');
  });

  it('retiring a plan is a published version that is no longer purchasable -- still resolvable', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN({ isPurchasable: false }));
    expect((await publish(admin, { reason: 'Retire' })).statusCode).toBe(200);
    const live = await resolvePlanVersion(dark.db, 'fixture_monthly', await economyNow(dark.db));
    expect(live.ok && [live.value.ref.version, live.value.isPurchasable]).toEqual([2, false]);
    expect((await config(admin)).plans[0]!.versions.map((v) => [v.version, v.state, v.isPurchasable])).toEqual([
      [1, 'superseded', true],
      [2, 'active', false],
    ]);
  });
});

/* ================================================================== *
 * Compatibility, and the economy stays dark
 * ================================================================== */

describe('compatibility with P1.3, and the economy stays dark', () => {
  it('the P1.3 preview sees the drafts this workflow writes, and live mode does not', async () => {
    const admin = await account('admin');
    await call(admin, 'PUT', '/admin/economy/plans/fixture_monthly/draft', PLAN());
    await call(admin, 'PUT', '/admin/economy/ruleset/draft', RULESET());
    const drafted = (await call(admin, 'POST', '/admin/economy/preview', { mode: 'drafted' })).json();
    expect(drafted.configuration.plans).toEqual([{ code: 'fixture_monthly', version: 1, source: 'draft', isPurchasable: true }]);
    expect(drafted.configuration.ruleset).toEqual({ version: 1, source: 'draft' });
    expect(drafted.configurationIssues).toEqual([]);
    const live = (await call(admin, 'POST', '/admin/economy/preview', { mode: 'live' })).json();
    expect(live.configuration).toEqual({ plans: [], packs: [], ruleset: null });
  });

  it('publishing does not switch the economy on; customers never see plan features', async () => {
    const admin = await account('admin');
    await liveBaseline(admin);
    const customer = await account('user');
    expect((await call(customer, 'GET', '/api/economy/catalog')).statusCode).toBe(503);
    const on = (await call(customer, 'GET', '/api/economy/catalog', undefined, economyOn)).json();
    expect(on.plans.map((p: { code: string }) => p.code)).toEqual(['fixture_monthly']);
    expect(on.plans[0]).not.toHaveProperty('features');
  });
});
