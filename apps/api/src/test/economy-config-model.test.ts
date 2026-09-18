import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import {
  economyPlans,
  economyPlanVersions,
  economyRulesetActionCosts,
  economyRulesets,
} from '../db/schema.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * PRD v1.2 P1.1 -- the economy configuration DATA MODEL.
 *
 * Tests the database, not a service: no service exists yet (P1.2/P1.3). Almost
 * everything here goes through raw SQL on purpose, because what is under test
 * is that the TABLES refuse invalid states -- a later service must not be the
 * only thing standing between an operator's typo and a live price.
 */

let on: TestContext;
const ACTOR = randomUUID();
const DAY = 86_400_000;
const future = (days: number) => new Date(Date.now() + days * DAY);

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => truncateAll(on));

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  on.pool.query<T & import('pg').QueryResultRow>(text, params);

type Table = 'economy_plan_versions' | 'economy_pack_versions' | 'economy_rulesets';

async function newPlan(code = 'premium_monthly'): Promise<string> {
  return (await q<{ id: string }>('INSERT INTO economy_plans (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
}

async function planDraft(planId: string, version: number, over: Record<string, unknown> = {}) {
  const v = {
    display_name: 'Premium Monthly',
    billing_period_months: 1,
    price_minor: 1999,
    currency: 'USD',
    monthly_included_credits: 300,
    ...over,
  };
  return (
    await q<Record<string, unknown> & { id: string }>(
      `INSERT INTO economy_plan_versions
         (plan_id, version, display_name, billing_period_months, price_minor, currency, monthly_included_credits, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [planId, version, v.display_name, v.billing_period_months, v.price_minor, v.currency, v.monthly_included_credits, ACTOR],
    )
  ).rows[0]!;
}

async function newPack(code = 'starter'): Promise<string> {
  return (await q<{ id: string }>('INSERT INTO economy_packs (code) VALUES ($1) RETURNING id', [code])).rows[0]!.id;
}

async function packDraft(packId: string, version: number, over: Record<string, unknown> = {}) {
  const v = { display_name: 'Starter', credits: 150, price_minor: 999, currency: 'USD', sort_order: 0, ...over };
  return (
    await q<Record<string, unknown> & { id: string }>(
      `INSERT INTO economy_pack_versions (pack_id, version, display_name, credits, price_minor, currency, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [packId, version, v.display_name, v.credits, v.price_minor, v.currency, v.sort_order],
    )
  ).rows[0]!;
}

async function rulesetDraft(version: number) {
  return (await q<{ id: string }>('INSERT INTO economy_rulesets (version) VALUES ($1) RETURNING *', [version])).rows[0]!;
}

function publish(table: Table, id: string, effectiveFrom: Date | null = null, reason: string | null = 'Launch pricing') {
  return q<Record<string, unknown>>(
    `UPDATE ${table} SET status = 'published', effective_from = $2, published_by = $3, publish_reason = $4
      WHERE id = $1 RETURNING *`,
    [id, effectiveFrom, ACTOR, reason],
  );
}

function cancel(table: Table, id: string, reason: string | null = 'Change of plan') {
  return q<Record<string, unknown>>(
    `UPDATE ${table} SET status = 'cancelled', cancelled_by = $2, cancel_reason = $3 WHERE id = $1 RETURNING *`,
    [id, ACTOR, reason],
  );
}

/* ------------------------------------------------------------------ *
 * Valid records
 * ------------------------------------------------------------------ */

describe('plans and plan versions: valid records', () => {
  it('stores a draft plan version with integer minor-unit money and an explicit currency', async () => {
    const planId = await newPlan();
    const row = await planDraft(planId, 1);
    expect(row).toMatchObject({
      plan_id: planId,
      version: 1,
      price_minor: 1999,
      currency: 'USD',
      billing_period_months: 1,
      monthly_included_credits: 300,
      features: {},
      is_purchasable: true,
      status: 'draft',
      effective_from: null,
      published_at: null,
      created_by: ACTOR,
    });
    expect(Number.isInteger(row.price_minor)).toBe(true);
  });

  it('holds many plans, each with many versions, independently numbered', async () => {
    const monthly = await newPlan('premium_monthly');
    const annual = await newPlan('premium_annual');
    const v1 = await planDraft(monthly, 1);
    await publish('economy_plan_versions', v1.id);
    await planDraft(monthly, 2, { price_minor: 2499 });
    await planDraft(annual, 1, { billing_period_months: 12, price_minor: 17999 });

    const { rows } = await q<{ code: string; version: number; status: string }>(
      `SELECT p.code, v.version, v.status FROM economy_plan_versions v JOIN economy_plans p ON p.id = v.plan_id
        ORDER BY p.code, v.version`,
    );
    expect(rows).toEqual([
      { code: 'premium_annual', version: 1, status: 'draft' },
      { code: 'premium_monthly', version: 1, status: 'published' },
      { code: 'premium_monthly', version: 2, status: 'draft' },
    ]);
  });

  it('round-trips through the typed Drizzle schema exactly as through SQL', async () => {
    const [plan] = await on.db.insert(economyPlans).values({ code: 'premium_quarterly' }).returning();
    const [version] = await on.db
      .insert(economyPlanVersions)
      .values({
        planId: plan!.id,
        version: 1,
        displayName: 'Premium Quarterly',
        billingPeriodMonths: 3,
        priceMinor: 5397,
        currency: 'EUR',
        monthlyIncludedCredits: 300,
        features: { unlimited_text: true },
      })
      .returning();
    expect(version).toMatchObject({ status: 'draft', priceMinor: 5397, currency: 'EUR', effectiveFrom: null });
    expect(version!.features).toEqual({ unlimited_text: true });
  });

  it('accepts a zero monthly Credit grant -- a plan may include none', async () => {
    const row = await planDraft(await newPlan(), 1, { monthly_included_credits: 0 });
    expect(row.monthly_included_credits).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

describe('money is integer minor units', () => {
  it('refuses a fractional amount instead of rounding it', async () => {
    const planId = await newPlan();
    await expect(planDraft(planId, 1, { price_minor: 19.99 })).rejects.toThrow(/invalid input syntax for type integer/);
    const packId = await newPack();
    await expect(packDraft(packId, 1, { price_minor: 9.99 })).rejects.toThrow(/invalid input syntax for type integer/);
  });

  it('refuses a zero or negative price', async () => {
    const planId = await newPlan();
    for (const price of [0, -1]) {
      await expect(planDraft(planId, 1, { price_minor: price })).rejects.toThrow(/economy_plan_versions_price_positive/);
    }
    const packId = await newPack();
    await expect(packDraft(packId, 1, { price_minor: 0 })).rejects.toThrow(/economy_pack_versions_price_positive/);
  });

  it('refuses a negative Credit grant and a non-positive pack size', async () => {
    await expect(planDraft(await newPlan(), 1, { monthly_included_credits: -1 })).rejects.toThrow(
      /economy_plan_versions_credits/,
    );
    await expect(packDraft(await newPack(), 1, { credits: 0 })).rejects.toThrow(/economy_pack_versions_credits_positive/);
  });

  it('requires an upper-case three-letter ISO 4217 currency', async () => {
    const planId = await newPlan();
    for (const currency of ['usd', 'US', 'USDT', '']) {
      await expect(planDraft(planId, 1, { currency })).rejects.toThrow(/economy_plan_versions_currency/);
    }
    await expect(packDraft(await newPack(), 1, { currency: 'eur' })).rejects.toThrow(/economy_pack_versions_currency/);
  });

  it('refuses a billing period outside 1..36 months', async () => {
    const planId = await newPlan();
    for (const months of [0, 37]) {
      await expect(planDraft(planId, 1, { billing_period_months: months })).rejects.toThrow(
        /economy_plan_versions_billing_period/,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * Identity and relationships
 * ------------------------------------------------------------------ */

describe('version identity and parent relationships', () => {
  it('refuses a duplicate version number within one plan, whatever state the first is in', async () => {
    const planId = await newPlan();
    const v1 = await planDraft(planId, 1);
    await publish('economy_plan_versions', v1.id);
    await expect(planDraft(planId, 1)).rejects.toThrow(/economy_plan_versions_version_idx/);
  });

  it('allows the same version number on different plans', async () => {
    await planDraft(await newPlan('premium_monthly'), 1);
    await expect(planDraft(await newPlan('premium_annual'), 1)).resolves.toBeDefined();
  });

  it('refuses a version below 1', async () => {
    await expect(planDraft(await newPlan(), 0)).rejects.toThrow(/economy_plan_versions_version_positive/);
  });

  it('refuses an orphan version pointing at no plan', async () => {
    await expect(planDraft(randomUUID(), 1)).rejects.toThrow(/economy_plan_versions_plan_id_economy_plans_id_fk/);
    await expect(packDraft(randomUUID(), 1)).rejects.toThrow(/economy_pack_versions_pack_id_economy_packs_id_fk/);
  });

  it('refuses to delete a plan or pack that has any version -- history cannot be removed by its parent', async () => {
    const planId = await newPlan();
    await planDraft(planId, 1);
    await expect(q('DELETE FROM economy_plans WHERE id = $1', [planId])).rejects.toThrow(/economy_plan_versions_plan_id/);
    const packId = await newPack();
    await packDraft(packId, 1);
    await expect(q('DELETE FROM economy_packs WHERE id = $1', [packId])).rejects.toThrow(/economy_pack_versions_pack_id/);
  });

  it('requires a unique, well-formed code', async () => {
    await newPlan('premium_monthly');
    await expect(newPlan('premium_monthly')).rejects.toThrow(/economy_plans_code_unique/);
    for (const code of ['Premium', 'premium monthly', '1plan', 'p', 'premium-monthly']) {
      await expect(newPlan(code)).rejects.toThrow(/economy_plans_code_format/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Drafts
 * ------------------------------------------------------------------ */

describe('drafts', () => {
  it('can only be created as a draft -- publication is always an explicit transition', async () => {
    const planId = await newPlan();
    for (const status of ['published', 'cancelled']) {
      await expect(
        q(
          `INSERT INTO economy_plan_versions (plan_id, version, display_name, billing_period_months, price_minor, currency,
             monthly_included_credits, status, effective_from, published_at, published_by, publish_reason)
           VALUES ($1, 1, 'X', 1, 100, 'USD', 0, $2, now(), now(), $3, 'r')`,
          [planId, status, ACTOR],
        ),
      ).rejects.toThrow(/must be created as a draft/);
    }
  });

  it('allows ONE open draft per plan, and another once it is published', async () => {
    const planId = await newPlan();
    const v1 = await planDraft(planId, 1);
    await expect(planDraft(planId, 2)).rejects.toThrow(/economy_plan_versions_one_draft_idx/);
    await expect(planDraft(await newPlan('other_plan'), 1)).resolves.toBeDefined();
    await publish('economy_plan_versions', v1.id);
    await expect(planDraft(planId, 2)).resolves.toBeDefined();
  });

  it('is freely editable and deletable, and stamps updated_at from the database clock', async () => {
    const planId = await newPlan();
    const draft = await planDraft(planId, 1);
    const { rows } = await q<{ price_minor: number; updated_at: Date; created_at: Date }>(
      'UPDATE economy_plan_versions SET price_minor = 2999 WHERE id = $1 RETURNING price_minor, updated_at, created_at',
      [draft.id],
    );
    expect(rows[0]!.price_minor).toBe(2999);
    expect(rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(rows[0]!.created_at.getTime());
    await q('DELETE FROM economy_plan_versions WHERE id = $1', [draft.id]);
    expect((await q('SELECT 1 FROM economy_plan_versions')).rowCount).toBe(0);
  });

  it('is deleted, never cancelled', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await expect(cancel('economy_plan_versions', draft.id)).rejects.toThrow(/deleted, not cancelled/);
  });

  it('carries no publication facts', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await expect(
      q('UPDATE economy_plan_versions SET published_at = now(), published_by = $2 WHERE id = $1', [draft.id, ACTOR]),
    ).rejects.toThrow(/economy_plan_versions_draft_unpublished/);
  });

  it('may hold a proposed schedule without being resolvable', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await q('UPDATE economy_plan_versions SET effective_from = $2 WHERE id = $1', [draft.id, future(3)]);
    const live = await q(
      `SELECT 1 FROM economy_plan_versions WHERE status = 'published' AND effective_from <= $1`,
      [future(10)],
    );
    expect(live.rowCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Publication
 * ------------------------------------------------------------------ */

describe('publication', () => {
  it('requires a publisher and a reason', async () => {
    const draft = await planDraft(await newPlan(), 1);
    for (const reason of [null, '   ']) {
      await expect(publish('economy_plan_versions', draft.id, null, reason)).rejects.toThrow(
        /economy_plan_versions_published_complete/,
      );
    }
    await expect(
      q(`UPDATE economy_plan_versions SET status = 'published', publish_reason = 'r' WHERE id = $1`, [draft.id]),
    ).rejects.toThrow(/economy_plan_versions_published_complete/);
  });

  it('with no effective_from, takes effect immediately at the database publication instant', async () => {
    const draft = await planDraft(await newPlan(), 1);
    const [row] = (await publish('economy_plan_versions', draft.id)).rows;
    expect(row!.status).toBe('published');
    expect(row!.published_by).toBe(ACTOR);
    expect((row!.effective_from as Date).getTime()).toBe((row!.published_at as Date).getTime());
  });

  it('ignores a client-supplied published_at -- the database clock decides', async () => {
    const draft = await planDraft(await newPlan(), 1);
    const forged = new Date('2020-01-01T00:00:00Z');
    const { rows } = await q<{ published_at: Date }>(
      `UPDATE economy_plan_versions SET status = 'published', published_at = $2, published_by = $3, publish_reason = 'r'
        WHERE id = $1 RETURNING published_at`,
      [draft.id, forged, ACTOR],
    );
    expect(rows[0]!.published_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('may be scheduled for the future', async () => {
    const draft = await planDraft(await newPlan(), 1);
    const at = future(7);
    const [row] = (await publish('economy_plan_versions', draft.id, at)).rows;
    expect((row!.effective_from as Date).getTime()).toBe(at.getTime());
  });

  it('can never apply retroactively', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await expect(publish('economy_plan_versions', draft.id, new Date(Date.now() - DAY))).rejects.toThrow(
      /economy_plan_versions_published_complete/,
    );
  });

  it('keeps history linear: a later version cannot take effect before an earlier one', async () => {
    const planId = await newPlan();
    const v1 = await planDraft(planId, 1);
    await publish('economy_plan_versions', v1.id, future(2));

    const v2 = await planDraft(planId, 2);
    await expect(publish('economy_plan_versions', v2.id, future(1))).rejects.toThrow(/out of order/);
    // The same instant is equally ambiguous, and refused.
    const v1Effective = (await q<{ e: Date }>('SELECT effective_from e FROM economy_plan_versions WHERE id = $1', [v1.id]))
      .rows[0]!.e;
    await expect(publish('economy_plan_versions', v2.id, v1Effective)).rejects.toThrow(
      /out of order|economy_plan_versions_effective_idx/,
    );
    await expect(publish('economy_plan_versions', v2.id, future(3))).resolves.toBeDefined();
  });

  it('keeps history linear the other way: a lower version cannot take effect after a higher one', async () => {
    const planId = await newPlan();
    const v5 = await planDraft(planId, 5);
    await publish('economy_plan_versions', v5.id, future(5));
    const v3 = await planDraft(planId, 3);
    await expect(publish('economy_plan_versions', v3.id, future(6))).rejects.toThrow(/out of order/);
    await expect(publish('economy_plan_versions', v3.id, future(4))).resolves.toBeDefined();
  });

  it('lets DIFFERENT plans take effect at the same instant -- they are independent streams', async () => {
    const at = future(3);
    const a = await planDraft(await newPlan('plan_a'), 1);
    const b = await planDraft(await newPlan('plan_b'), 1);
    await publish('economy_plan_versions', a.id, at);
    await expect(publish('economy_plan_versions', b.id, at)).resolves.toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * Immutability and cancellation
 * ------------------------------------------------------------------ */

describe('published versions are immutable, and only a future one can be cancelled', () => {
  it('refuses any edit to a published version', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await publish('economy_plan_versions', draft.id, future(1));
    for (const change of ['price_minor = 1', "display_name = 'Renamed'", "features = '{\"x\":1}'", 'is_purchasable = false']) {
      await expect(q(`UPDATE economy_plan_versions SET ${change} WHERE id = $1`, [draft.id])).rejects.toThrow(/immutable/);
    }
    await expect(q(`UPDATE economy_plan_versions SET status = 'draft' WHERE id = $1`, [draft.id])).rejects.toThrow(
      /immutable/,
    );
  });

  it('refuses to delete a published version', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await publish('economy_plan_versions', draft.id);
    await expect(q('DELETE FROM economy_plan_versions WHERE id = $1', [draft.id])).rejects.toThrow(/only drafts can/);
  });

  it('cancels a scheduled version before it takes effect, stamping when, by whom and why', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await publish('economy_plan_versions', draft.id, future(2));
    await expect(cancel('economy_plan_versions', draft.id, null)).rejects.toThrow(
      /economy_plan_versions_cancellation_complete/,
    );
    const [row] = (await cancel('economy_plan_versions', draft.id, 'Pricing review')).rows;
    expect(row).toMatchObject({ status: 'cancelled', cancelled_by: ACTOR, cancel_reason: 'Pricing review' });
    expect((row!.cancelled_at as Date).getTime()).toBeLessThan((row!.effective_from as Date).getTime());
  });

  it('refuses to cancel a version that has already taken effect -- it must be superseded', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await publish('economy_plan_versions', draft.id);
    await expect(cancel('economy_plan_versions', draft.id)).rejects.toThrow(/already taken effect/);
  });

  it('refuses a cancellation that also edits the version', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await publish('economy_plan_versions', draft.id, future(2));
    await expect(
      q(
        `UPDATE economy_plan_versions SET status = 'cancelled', cancelled_by = $2, cancel_reason = 'r', price_minor = 1
          WHERE id = $1`,
        [draft.id, ACTOR],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('keeps a cancelled version immutable and undeletable', async () => {
    const draft = await planDraft(await newPlan(), 1);
    await publish('economy_plan_versions', draft.id, future(2));
    await cancel('economy_plan_versions', draft.id);
    await expect(q(`UPDATE economy_plan_versions SET status = 'published' WHERE id = $1`, [draft.id])).rejects.toThrow(
      /cancelled and immutable/,
    );
    await expect(q('DELETE FROM economy_plan_versions WHERE id = $1', [draft.id])).rejects.toThrow(/only drafts can/);
  });

  it('frees a cancelled instant for a later version, and never reuses its number', async () => {
    const planId = await newPlan();
    const at = future(2);
    const v1 = await planDraft(planId, 1);
    await publish('economy_plan_versions', v1.id, at);
    await cancel('economy_plan_versions', v1.id);
    await expect(planDraft(planId, 1)).rejects.toThrow(/economy_plan_versions_version_idx/);
    const v2 = await planDraft(planId, 2);
    await expect(publish('economy_plan_versions', v2.id, at)).resolves.toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

describe('history stays intact and queryable', () => {
  it('leaves a superseded version byte-for-byte unchanged and still readable', async () => {
    const planId = await newPlan();
    const v1 = await planDraft(planId, 1);
    await publish('economy_plan_versions', v1.id);
    const before = (await q('SELECT * FROM economy_plan_versions WHERE id = $1', [v1.id])).rows[0];

    const v2 = await planDraft(planId, 2, { price_minor: 2499 });
    await publish('economy_plan_versions', v2.id, future(30), 'Price rise');

    const after = (await q('SELECT * FROM economy_plan_versions WHERE id = $1', [v1.id])).rows[0];
    expect(after).toEqual(before);
    const all = await on.db
      .select({ version: economyPlanVersions.version, price: economyPlanVersions.priceMinor })
      .from(economyPlanVersions)
      .where(eq(economyPlanVersions.planId, planId))
      .orderBy(asc(economyPlanVersions.version));
    expect(all).toEqual([
      { version: 1, price: 1999 },
      { version: 2, price: 2499 },
    ]);
  });

  /**
   * NOT the P1.2 resolver -- a check that the data SUPPORTS its rule
   * unambiguously: at any instant, exactly one published version (or none).
   */
  it('supports an unambiguous "live version at time T" by effective instant alone', async () => {
    const planId = await newPlan();
    const v1 = await planDraft(planId, 1);
    await publish('economy_plan_versions', v1.id);
    const v2 = await planDraft(planId, 2, { price_minor: 2499 });
    await publish('economy_plan_versions', v2.id, future(10));
    const v3 = await planDraft(planId, 3, { price_minor: 2999 });
    await publish('economy_plan_versions', v3.id, future(20));
    await cancel('economy_plan_versions', v3.id);

    const liveAt = async (t: Date) =>
      (
        await q<{ version: number }>(
          `SELECT version FROM economy_plan_versions
            WHERE plan_id = $1 AND status = 'published' AND effective_from <= $2
            ORDER BY effective_from DESC LIMIT 1`,
          [planId, t],
        )
      ).rows[0]?.version ?? null;

    expect(await liveAt(new Date(Date.now() - DAY))).toBeNull();
    expect(await liveAt(future(1))).toBe(1);
    expect(await liveAt(future(15))).toBe(2);
    expect(await liveAt(future(25))).toBe(2); // v3 was cancelled
  });
});

/* ------------------------------------------------------------------ *
 * Packs share the lifecycle
 * ------------------------------------------------------------------ */

describe('pack versions', () => {
  it('store a ladder rung and share the plan lifecycle', async () => {
    const packId = await newPack('popular');
    const draft = await packDraft(packId, 1, { credits: 400, price_minor: 2499, sort_order: 1 });
    expect(draft).toMatchObject({ credits: 400, price_minor: 2499, currency: 'USD', is_best_value: false, status: 'draft' });
    await expect(packDraft(packId, 2)).rejects.toThrow(/economy_pack_versions_one_draft_idx/);
    await publish('economy_pack_versions', draft.id);
    await expect(q('UPDATE economy_pack_versions SET credits = 1 WHERE id = $1', [draft.id])).rejects.toThrow(/immutable/);
    await expect(packDraft(packId, 1)).rejects.toThrow(/economy_pack_versions_version_idx/);
  });

  it('refuses a negative sort order', async () => {
    await expect(packDraft(await newPack(), 1, { sort_order: -1 })).rejects.toThrow(/economy_pack_versions_sort_order/);
  });
});

/* ------------------------------------------------------------------ *
 * Rulesets
 * ------------------------------------------------------------------ */

describe('rulesets: action costs, allowances and rewards', () => {
  async function fullDraft(version = 1) {
    const rs = await rulesetDraft(version);
    await q(
      `INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, quality_tier, max_duration_seconds, unit, credit_cost)
       VALUES ($1, 'image', 'standard', NULL, 'per_action', 10),
              ($1, 'image', 'high', NULL, 'per_action', 15),
              ($1, 'video', 'standard', 5, 'per_action', 40),
              ($1, 'video', 'standard', 15, 'per_action', 100),
              ($1, 'voice_call', 'standard', NULL, 'per_minute', 5)`,
      [rs.id],
    );
    await q(
      `INSERT INTO economy_ruleset_allowances (ruleset_id, key, value)
       VALUES ($1, 'free_first_conversation_messages', 30), ($1, 'free_daily_messages', 10),
              ($1, 'signup_credit_grant', 20), ($1, 'grace_period_days', 0)`,
      [rs.id],
    );
    await q(
      `INSERT INTO economy_ruleset_rewards (ruleset_id, reward_key, credits, per_user_cap) VALUES ($1, 'first_chat', 5, NULL)`,
      [rs.id],
    );
    return rs;
  }

  it('store a complete draft ruleset, costs in integer Credits', async () => {
    const rs = await fullDraft();
    const costs = await on.db
      .select()
      .from(economyRulesetActionCosts)
      .where(eq(economyRulesetActionCosts.rulesetId, rs.id))
      .orderBy(asc(economyRulesetActionCosts.actionType), asc(economyRulesetActionCosts.creditCost));
    expect(costs.map((c) => [c.actionType, c.qualityTier, c.maxDurationSeconds, c.unit, c.creditCost])).toEqual([
      ['image', 'standard', null, 'per_action', 10],
      ['image', 'high', null, 'per_action', 15],
      ['video', 'standard', 5, 'per_action', 40],
      ['video', 'standard', 15, 'per_action', 100],
      ['voice_call', 'standard', null, 'per_minute', 5],
    ]);
    const [ruleset] = await on.db.select().from(economyRulesets).where(eq(economyRulesets.id, rs.id));
    expect(ruleset!.status).toBe('draft');
  });

  it('refuses a duplicate tier -- including two tiers with no duration', async () => {
    const rs = await fullDraft();
    await expect(
      q(`INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, quality_tier, credit_cost) VALUES ($1, 'image', 'standard', 12)`, [rs.id]),
    ).rejects.toThrow(/economy_ruleset_action_costs_tier_idx/);
    await expect(
      q(`INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, quality_tier, max_duration_seconds, credit_cost) VALUES ($1, 'video', 'standard', 5, 50)`, [rs.id]),
    ).rejects.toThrow(/economy_ruleset_action_costs_tier_idx/);
    await expect(
      q(`INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, quality_tier, max_duration_seconds, credit_cost) VALUES ($1, 'video', 'standard', 30, 200)`, [rs.id]),
    ).resolves.toBeDefined();
    await expect(
      q(`INSERT INTO economy_ruleset_allowances (ruleset_id, key, value) VALUES ($1, 'free_daily_messages', 5)`, [rs.id]),
    ).rejects.toThrow(/economy_ruleset_allowances_key_idx/);
  });

  it('refuses invalid values', async () => {
    const rs = await rulesetDraft(1);
    const cases: Array<[string, RegExp]> = [
      [`INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, credit_cost) VALUES ($1, 'image', 0)`, /cost_positive/],
      [`INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, credit_cost) VALUES ($1, 'image', -5)`, /cost_positive/],
      [`INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, credit_cost, max_duration_seconds) VALUES ($1, 'video', 5, 0)`, /action_costs_duration/],
      [`INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, credit_cost) VALUES ($1, 'Image Gen', 5)`, /action_costs_action_key/],
      [`INSERT INTO economy_ruleset_allowances (ruleset_id, key, value) VALUES ($1, 'free_daily_messages', -1)`, /allowances_value/],
      [`INSERT INTO economy_ruleset_allowances (ruleset_id, key, value) VALUES ($1, 'Free Daily', 1)`, /allowances_key_format/],
      [`INSERT INTO economy_ruleset_rewards (ruleset_id, reward_key, credits) VALUES ($1, 'milestone', 0)`, /rewards_credits_positive/],
      [`INSERT INTO economy_ruleset_rewards (ruleset_id, reward_key, credits, per_user_cap) VALUES ($1, 'milestone', 5, 0)`, /rewards_cap/],
    ];
    for (const [sql, error] of cases) {
      await expect(q(sql, [rs.id])).rejects.toThrow(error);
    }
    // A fractional cost is refused as the application sends it: a PARAMETER.
    // (A numeric LITERAL typed into hand-written SQL is rounded by Postgres
    // before any constraint sees it -- no integer column can prevent that, which
    // is one more reason economy rows are written only through services.)
    await expect(
      q(`INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, credit_cost) VALUES ($1, 'image', $2)`, [rs.id, 2.5]),
    ).rejects.toThrow(/invalid input syntax for type integer/);
    await expect(
      q(`INSERT INTO economy_ruleset_allowances (ruleset_id, key, value) VALUES ($1, 'grace_period_days', 0)`, [rs.id]),
    ).resolves.toBeDefined();
  });

  it('refuses an orphan cost row', async () => {
    await expect(
      q(`INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, credit_cost) VALUES ($1, 'image', 10)`, [randomUUID()]),
    ).rejects.toThrow(/economy_ruleset_action_costs_ruleset_id/);
  });

  it('numbers rulesets globally, with one open draft at a time', async () => {
    const rs1 = await rulesetDraft(1);
    await expect(rulesetDraft(2)).rejects.toThrow(/economy_rulesets_one_draft_idx/);
    await publish('economy_rulesets', rs1.id);
    await expect(rulesetDraft(1)).rejects.toThrow(/economy_rulesets_version_idx/);
    await expect(rulesetDraft(2)).resolves.toBeDefined();
  });

  it('freezes every cost, allowance and reward once the ruleset is published', async () => {
    const rs = await fullDraft();
    await publish('economy_rulesets', rs.id);
    const frozen: string[] = [
      `UPDATE economy_ruleset_action_costs SET credit_cost = 1 WHERE ruleset_id = $1`,
      `DELETE FROM economy_ruleset_action_costs WHERE ruleset_id = $1`,
      `INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, credit_cost) VALUES ($1, 'gif', 3)`,
      `UPDATE economy_ruleset_allowances SET value = 999 WHERE ruleset_id = $1`,
      `DELETE FROM economy_ruleset_allowances WHERE ruleset_id = $1`,
      `INSERT INTO economy_ruleset_allowances (ruleset_id, key, value) VALUES ($1, 'extra_key', 1)`,
      `UPDATE economy_ruleset_rewards SET credits = 999 WHERE ruleset_id = $1`,
      `DELETE FROM economy_ruleset_rewards WHERE ruleset_id = $1`,
    ];
    for (const sql of frozen) await expect(q(sql, [rs.id])).rejects.toThrow(/frozen/);
    await expect(q('DELETE FROM economy_rulesets WHERE id = $1', [rs.id])).rejects.toThrow(/only drafts can/);
    expect((await q('SELECT 1 FROM economy_ruleset_action_costs WHERE ruleset_id = $1', [rs.id])).rowCount).toBe(5);
  });

  it('refuses moving a row from a draft into a published ruleset', async () => {
    const published = await fullDraft(1);
    await publish('economy_rulesets', published.id);
    const draft = await rulesetDraft(2);
    await q(`INSERT INTO economy_ruleset_allowances (ruleset_id, key, value) VALUES ($1, 'movable', 1)`, [draft.id]);
    await expect(
      q(`UPDATE economy_ruleset_allowances SET ruleset_id = $1 WHERE ruleset_id = $2`, [published.id, draft.id]),
    ).rejects.toThrow(/frozen/);
  });

  it('deletes a draft ruleset together with its rows', async () => {
    const rs = await fullDraft();
    await q('DELETE FROM economy_rulesets WHERE id = $1', [rs.id]);
    for (const table of ['economy_ruleset_action_costs', 'economy_ruleset_allowances', 'economy_ruleset_rewards']) {
      expect((await q(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
    }
  });

  /**
   * THE RACE THAT MATTERS. A cost row inserted while the ruleset is being
   * published must not land in the published snapshot. The publish holds the
   * ruleset row; the insert's share lock waits for it and then sees
   * `published`.
   */
  it('cannot slip a row into a ruleset that is being published concurrently', async () => {
    const rs = await fullDraft();
    const publisher = await on.pool.connect();
    const writer = await on.pool.connect();
    try {
      await publisher.query('BEGIN');
      await publisher.query(
        `UPDATE economy_rulesets SET status = 'published', published_by = $2, publish_reason = 'r' WHERE id = $1`,
        [rs.id, ACTOR],
      );
      const insert = writer.query(
        `INSERT INTO economy_ruleset_action_costs (ruleset_id, action_type, credit_cost) VALUES ($1, 'late_row', 1)`,
        [rs.id],
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await publisher.query('COMMIT');
      await expect(insert).rejects.toThrow(/frozen/);
    } finally {
      publisher.release();
      writer.release();
    }
    expect(
      (await q(`SELECT 1 FROM economy_ruleset_action_costs WHERE action_type = 'late_row'`)).rowCount,
    ).toBe(0);
  });
});
