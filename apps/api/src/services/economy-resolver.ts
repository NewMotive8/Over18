import { and, asc, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import {
  economyPacks,
  economyPackVersions,
  economyPlans,
  economyPlanVersions,
  economyRulesetActionCosts,
  economyRulesetAllowances,
  economyRulesetRewards,
  economyRulesets,
} from '../db/schema.js';

/**
 * THE economy resolver (PRD v1.2 §18, §20) -- P1.2.
 *
 * The single server-side authority on WHICH economy configuration applies. No
 * other code may select a plan version, a pack version or a ruleset for itself:
 * the moment two call sites pick "the current price" differently, one of them
 * is charging the wrong amount.
 *
 * THREE RULES EVERY CALLER INHERITS
 *
 * 1. ONE INSTANT, FROM THE DATABASE CLOCK. Resolution is always "as of" an
 *    `EconomyInstant`. `economyNow()` reads it from PostgreSQL -- the clock that
 *    stamped every `effective_from` -- never from the application host, whose
 *    clock can differ (the P1.1 review measured it resolving the PREVIOUS
 *    version for milliseconds after an immediate publish). A caller doing
 *    several resolutions for one operation reads the instant ONCE and passes it
 *    to all of them, so a plan and a ruleset can never come from two different
 *    moments.
 *
 * 2. THE LIVE VERSION IS DERIVED, NEVER STORED. For a parent at instant T it is
 *    the `published` version with the greatest `effective_from <= T`. Drafts
 *    and cancelled versions are never candidates; a future-scheduled version is
 *    not a candidate until T reaches it. The P1.1 triggers keep version numbers
 *    in the same order as effective instants, so this is also "the highest
 *    published version effective by T" -- there is exactly one answer.
 *
 * 3. RESOLVE ONCE, THEN RECORD THE IDENTITY. Every result carries an
 *    `EconomyRef` naming the exact version row. An operation that acts on a
 *    resolved configuration -- a charge, a grant, a subscription -- must persist
 *    that ref and later re-read it with `loadPlanVersion` / `loadPackVersion` /
 *    `loadRuleset`, never re-resolve by timestamp. Re-resolving "as of when it
 *    happened" is not repeatable: a version published a moment later can change
 *    the answer for that instant.
 *
 *    A resolved version cannot later become cancelled: the resolver only
 *    returns versions whose effective_from has passed, and migration 0029
 *    refuses any cancellation later than one minute before effective_from.
 *
 * NO HIDDEN DEFAULTS. When nothing valid is published the answer is an explicit
 * `{ ok: false, reason }`, never a fallback price, a zero cost or a default
 * allowance. A missing value must stop an entitlement or a charge, not guess it.
 *
 * READ-ONLY. This module never writes. Publishing is P1.3.
 */

type Reader = Pick<Db, 'select' | 'selectDistinctOn' | 'execute'>;

/* ------------------------------------------------------------------ *
 * Instants
 * ------------------------------------------------------------------ */

/**
 * A point in time for resolution, as a UTC ISO 8601 string with microsecond
 * precision -- the precision PostgreSQL stores. A JavaScript `Date` would
 * truncate to milliseconds and could make a version published in the same
 * millisecond look not-yet-effective.
 */
export interface EconomyInstant {
  readonly iso: string;
  /** `database` for the live clock; `explicit` for previews and audits of a chosen moment. */
  readonly source: 'database' | 'explicit';
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** Formats a timestamptz in SQL as ISO 8601 UTC with microseconds. */
function isoUs(value: AnyPgColumn | SQL): SQL<string> {
  return sql<string>`to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * "Now", from the database clock. `clock_timestamp()` rather than `now()`, so
 * a resolution inside a long transaction still sees the actual current moment
 * rather than when the transaction began.
 */
export async function economyNow(db: Pick<Db, 'execute'>): Promise<EconomyInstant> {
  const result = await db.execute<{ iso: string }>(
    sql`SELECT ${isoUs(sql`clock_timestamp()`)} AS iso`,
  );
  return { iso: result.rows[0]!.iso, source: 'database' };
}

/**
 * A caller-chosen instant: "what will be live next Tuesday", or an audit view
 * of a past moment. NOT a way to reconstruct what a past operation used -- that
 * is what its recorded `EconomyRef` is for.
 */
export function economyInstantAt(iso: string): EconomyInstant {
  if (!ISO_UTC.test(iso) || Number.isNaN(Date.parse(iso))) {
    throw new RangeError(`Not a UTC ISO 8601 instant: ${iso}`);
  }
  return { iso, source: 'explicit' };
}

const effectiveBy = (column: AnyPgColumn, asOf: EconomyInstant) =>
  sql`${column} <= ${asOf.iso}::timestamptz`;

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/** Exactly which configuration row was used. Persist this; never re-resolve. */
export type EconomyRef =
  | { kind: 'plan_version'; id: string; code: string; version: number }
  | { kind: 'pack_version'; id: string; code: string; version: number }
  | { kind: 'ruleset'; id: string; version: number };

export type Resolution<T, Reason extends string> =
  | { ok: true; value: T; asOf: EconomyInstant }
  | { ok: false; reason: Reason; asOf: EconomyInstant };

export type Loaded<T> = { ok: true; value: T } | { ok: false; reason: 'not_found' };

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

export interface PlanVersionView {
  ref: Extract<EconomyRef, { kind: 'plan_version' }>;
  planId: string;
  /** `cancelled` only via `loadPlanVersion`; the resolver never returns one. */
  status: 'published' | 'cancelled';
  displayName: string;
  billingPeriodMonths: number;
  priceMinor: number;
  currency: string;
  monthlyIncludedCredits: number;
  features: Record<string, unknown>;
  /** Resolved even when false: a retired plan is still what existing subscribers hold. */
  isPurchasable: boolean;
  effectiveFrom: string;
  publishedAt: string;
}

const planColumns = {
  versionId: economyPlanVersions.id,
  planId: economyPlanVersions.planId,
  code: economyPlans.code,
  version: economyPlanVersions.version,
  status: economyPlanVersions.status,
  displayName: economyPlanVersions.displayName,
  billingPeriodMonths: economyPlanVersions.billingPeriodMonths,
  priceMinor: economyPlanVersions.priceMinor,
  currency: economyPlanVersions.currency,
  monthlyIncludedCredits: economyPlanVersions.monthlyIncludedCredits,
  features: economyPlanVersions.features,
  isPurchasable: economyPlanVersions.isPurchasable,
  effectiveFrom: isoUs(economyPlanVersions.effectiveFrom),
  publishedAt: isoUs(economyPlanVersions.publishedAt),
};

type PlanRow = {
  versionId: string;
  planId: string;
  code: string;
  version: number;
  status: 'draft' | 'published' | 'cancelled';
  displayName: string;
  billingPeriodMonths: number;
  priceMinor: number;
  currency: string;
  monthlyIncludedCredits: number;
  features: Record<string, unknown>;
  isPurchasable: boolean;
  effectiveFrom: string;
  publishedAt: string;
};

function toPlanView(row: PlanRow): PlanVersionView {
  return {
    ref: { kind: 'plan_version', id: row.versionId, code: row.code, version: row.version },
    planId: row.planId,
    status: row.status as 'published' | 'cancelled',
    displayName: row.displayName,
    billingPeriodMonths: row.billingPeriodMonths,
    priceMinor: row.priceMinor,
    currency: row.currency,
    monthlyIncludedCredits: row.monthlyIncludedCredits,
    features: row.features,
    isPurchasable: row.isPurchasable,
    effectiveFrom: row.effectiveFrom,
    publishedAt: row.publishedAt,
  };
}

/** The plan version live at `asOf`, by plan code. */
export async function resolvePlanVersion(
  db: Reader,
  planCode: string,
  asOf: EconomyInstant,
): Promise<Resolution<PlanVersionView, 'unknown_plan' | 'no_effective_version'>> {
  const [plan] = await db
    .select({ id: economyPlans.id })
    .from(economyPlans)
    .where(eq(economyPlans.code, planCode))
    .limit(1);
  if (!plan) return { ok: false, reason: 'unknown_plan', asOf };

  const [row] = await db
    .select(planColumns)
    .from(economyPlanVersions)
    .innerJoin(economyPlans, eq(economyPlans.id, economyPlanVersions.planId))
    .where(
      and(
        eq(economyPlanVersions.planId, plan.id),
        eq(economyPlanVersions.status, 'published'),
        effectiveBy(economyPlanVersions.effectiveFrom, asOf),
      ),
    )
    .orderBy(desc(economyPlanVersions.effectiveFrom))
    .limit(1);
  if (!row) return { ok: false, reason: 'no_effective_version', asOf };
  return { ok: true, value: toPlanView(row), asOf };
}

/**
 * Every plan with a live version at `asOf`, by code. A plan with no effective
 * version is ABSENT, not listed with a placeholder. Retired versions
 * (`isPurchasable: false`) are included; offering only purchasable plans is the
 * caller's filter, stated where it is applied.
 */
export async function resolvePlanCatalog(
  db: Reader,
  asOf: EconomyInstant,
): Promise<{ plans: PlanVersionView[]; asOf: EconomyInstant }> {
  const rows = await db
    .selectDistinctOn([economyPlanVersions.planId], planColumns)
    .from(economyPlanVersions)
    .innerJoin(economyPlans, eq(economyPlans.id, economyPlanVersions.planId))
    .where(
      and(
        eq(economyPlanVersions.status, 'published'),
        effectiveBy(economyPlanVersions.effectiveFrom, asOf),
      ),
    )
    .orderBy(economyPlanVersions.planId, desc(economyPlanVersions.effectiveFrom));
  const plans = rows.map(toPlanView).sort((a, b) => a.ref.code.localeCompare(b.ref.code));
  return { plans, asOf };
}

/** The exact plan version a downstream record names. Drafts are never loadable. */
export async function loadPlanVersion(db: Reader, versionId: string): Promise<Loaded<PlanVersionView>> {
  const [row] = await db
    .select(planColumns)
    .from(economyPlanVersions)
    .innerJoin(economyPlans, eq(economyPlans.id, economyPlanVersions.planId))
    .where(and(eq(economyPlanVersions.id, versionId), ne(economyPlanVersions.status, 'draft')))
    .limit(1);
  return row ? { ok: true, value: toPlanView(row) } : { ok: false, reason: 'not_found' };
}

/* ------------------------------------------------------------------ *
 * Packs
 * ------------------------------------------------------------------ */

export interface PackVersionView {
  ref: Extract<EconomyRef, { kind: 'pack_version' }>;
  packId: string;
  status: 'published' | 'cancelled';
  displayName: string;
  credits: number;
  priceMinor: number;
  currency: string;
  sortOrder: number;
  isBestValue: boolean;
  isPurchasable: boolean;
  effectiveFrom: string;
  publishedAt: string;
}

const packColumns = {
  versionId: economyPackVersions.id,
  packId: economyPackVersions.packId,
  code: economyPacks.code,
  version: economyPackVersions.version,
  status: economyPackVersions.status,
  displayName: economyPackVersions.displayName,
  credits: economyPackVersions.credits,
  priceMinor: economyPackVersions.priceMinor,
  currency: economyPackVersions.currency,
  sortOrder: economyPackVersions.sortOrder,
  isBestValue: economyPackVersions.isBestValue,
  isPurchasable: economyPackVersions.isPurchasable,
  effectiveFrom: isoUs(economyPackVersions.effectiveFrom),
  publishedAt: isoUs(economyPackVersions.publishedAt),
};

type PackRow = {
  versionId: string;
  packId: string;
  code: string;
  version: number;
  status: 'draft' | 'published' | 'cancelled';
  displayName: string;
  credits: number;
  priceMinor: number;
  currency: string;
  sortOrder: number;
  isBestValue: boolean;
  isPurchasable: boolean;
  effectiveFrom: string;
  publishedAt: string;
};

function toPackView(row: PackRow): PackVersionView {
  return {
    ref: { kind: 'pack_version', id: row.versionId, code: row.code, version: row.version },
    packId: row.packId,
    status: row.status as 'published' | 'cancelled',
    displayName: row.displayName,
    credits: row.credits,
    priceMinor: row.priceMinor,
    currency: row.currency,
    sortOrder: row.sortOrder,
    isBestValue: row.isBestValue,
    isPurchasable: row.isPurchasable,
    effectiveFrom: row.effectiveFrom,
    publishedAt: row.publishedAt,
  };
}

export async function resolvePackVersion(
  db: Reader,
  packCode: string,
  asOf: EconomyInstant,
): Promise<Resolution<PackVersionView, 'unknown_pack' | 'no_effective_version'>> {
  const [pack] = await db
    .select({ id: economyPacks.id })
    .from(economyPacks)
    .where(eq(economyPacks.code, packCode))
    .limit(1);
  if (!pack) return { ok: false, reason: 'unknown_pack', asOf };

  const [row] = await db
    .select(packColumns)
    .from(economyPackVersions)
    .innerJoin(economyPacks, eq(economyPacks.id, economyPackVersions.packId))
    .where(
      and(
        eq(economyPackVersions.packId, pack.id),
        eq(economyPackVersions.status, 'published'),
        effectiveBy(economyPackVersions.effectiveFrom, asOf),
      ),
    )
    .orderBy(desc(economyPackVersions.effectiveFrom))
    .limit(1);
  if (!row) return { ok: false, reason: 'no_effective_version', asOf };
  return { ok: true, value: toPackView(row), asOf };
}

/** Every pack live at `asOf`, in ladder order (sort_order, then code). */
export async function resolvePackCatalog(
  db: Reader,
  asOf: EconomyInstant,
): Promise<{ packs: PackVersionView[]; asOf: EconomyInstant }> {
  const rows = await db
    .selectDistinctOn([economyPackVersions.packId], packColumns)
    .from(economyPackVersions)
    .innerJoin(economyPacks, eq(economyPacks.id, economyPackVersions.packId))
    .where(
      and(
        eq(economyPackVersions.status, 'published'),
        effectiveBy(economyPackVersions.effectiveFrom, asOf),
      ),
    )
    .orderBy(economyPackVersions.packId, desc(economyPackVersions.effectiveFrom));
  const packs = rows
    .map(toPackView)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.ref.code.localeCompare(b.ref.code));
  return { packs, asOf };
}

export async function loadPackVersion(db: Reader, versionId: string): Promise<Loaded<PackVersionView>> {
  const [row] = await db
    .select(packColumns)
    .from(economyPackVersions)
    .innerJoin(economyPacks, eq(economyPacks.id, economyPackVersions.packId))
    .where(and(eq(economyPackVersions.id, versionId), ne(economyPackVersions.status, 'draft')))
    .limit(1);
  return row ? { ok: true, value: toPackView(row) } : { ok: false, reason: 'not_found' };
}

/* ------------------------------------------------------------------ *
 * Rulesets
 * ------------------------------------------------------------------ */

export interface ActionCostView {
  actionType: string;
  qualityTier: string;
  maxDurationSeconds: number | null;
  unit: 'per_action' | 'per_minute';
  creditCost: number;
  enabled: boolean;
}

export interface RewardView {
  rewardKey: string;
  credits: number;
  perUserCap: number | null;
  enabled: boolean;
}

/**
 * One whole ruleset, loaded together. A published ruleset's rows are frozen by
 * the 0028 trigger and its row can never be deleted, so reading the parent and
 * its three child sets in separate statements cannot observe a torn snapshot.
 *
 * Callers look values up on the snapshot with `actionCostFor`, `allowanceFor`
 * and `rewardFor` rather than querying again, so one operation prices every
 * step from the same ruleset.
 */
export interface RulesetSnapshot {
  ref: Extract<EconomyRef, { kind: 'ruleset' }>;
  status: 'published' | 'cancelled';
  effectiveFrom: string;
  publishedAt: string;
  actionCosts: readonly ActionCostView[];
  allowances: ReadonlyMap<string, number>;
  rewards: readonly RewardView[];
}

const rulesetColumns = {
  id: economyRulesets.id,
  version: economyRulesets.version,
  status: economyRulesets.status,
  effectiveFrom: isoUs(economyRulesets.effectiveFrom),
  publishedAt: isoUs(economyRulesets.publishedAt),
};

async function snapshotFor(
  db: Reader,
  row: { id: string; version: number; status: string; effectiveFrom: string; publishedAt: string },
): Promise<RulesetSnapshot> {
  const [costs, allowances, rewards] = await Promise.all([
    db
      .select({
        actionType: economyRulesetActionCosts.actionType,
        qualityTier: economyRulesetActionCosts.qualityTier,
        maxDurationSeconds: economyRulesetActionCosts.maxDurationSeconds,
        unit: economyRulesetActionCosts.unit,
        creditCost: economyRulesetActionCosts.creditCost,
        enabled: economyRulesetActionCosts.enabled,
      })
      .from(economyRulesetActionCosts)
      .where(eq(economyRulesetActionCosts.rulesetId, row.id))
      .orderBy(
        asc(economyRulesetActionCosts.actionType),
        asc(economyRulesetActionCosts.qualityTier),
        asc(economyRulesetActionCosts.maxDurationSeconds),
      ),
    db
      .select({ key: economyRulesetAllowances.key, value: economyRulesetAllowances.value })
      .from(economyRulesetAllowances)
      .where(eq(economyRulesetAllowances.rulesetId, row.id)),
    db
      .select({
        rewardKey: economyRulesetRewards.rewardKey,
        credits: economyRulesetRewards.credits,
        perUserCap: economyRulesetRewards.perUserCap,
        enabled: economyRulesetRewards.enabled,
      })
      .from(economyRulesetRewards)
      .where(eq(economyRulesetRewards.rulesetId, row.id))
      .orderBy(asc(economyRulesetRewards.rewardKey)),
  ]);
  return {
    ref: { kind: 'ruleset', id: row.id, version: row.version },
    status: row.status as 'published' | 'cancelled',
    effectiveFrom: row.effectiveFrom,
    publishedAt: row.publishedAt,
    actionCosts: costs,
    allowances: new Map(allowances.map((a) => [a.key, a.value])),
    rewards,
  };
}

/** The ruleset live at `asOf`. There is one global ruleset stream. */
export async function resolveRuleset(
  db: Reader,
  asOf: EconomyInstant,
): Promise<Resolution<RulesetSnapshot, 'no_effective_ruleset'>> {
  const [row] = await db
    .select(rulesetColumns)
    .from(economyRulesets)
    .where(and(eq(economyRulesets.status, 'published'), effectiveBy(economyRulesets.effectiveFrom, asOf)))
    .orderBy(desc(economyRulesets.effectiveFrom))
    .limit(1);
  if (!row) return { ok: false, reason: 'no_effective_ruleset', asOf };
  return { ok: true, value: await snapshotFor(db, row), asOf };
}

/** The exact ruleset a downstream record names, with its frozen rows. */
export async function loadRuleset(db: Reader, rulesetId: string): Promise<Loaded<RulesetSnapshot>> {
  const [row] = await db
    .select(rulesetColumns)
    .from(economyRulesets)
    .where(and(eq(economyRulesets.id, rulesetId), ne(economyRulesets.status, 'draft')))
    .limit(1);
  return row ? { ok: true, value: await snapshotFor(db, row) } : { ok: false, reason: 'not_found' };
}

/* ------------------------------------------------------------------ *
 * Lookups on a resolved ruleset -- pure, no queries
 * ------------------------------------------------------------------ */

export type ActionCostLookup =
  | { ok: true; cost: ActionCostView; ruleset: RulesetSnapshot['ref'] }
  | {
      ok: false;
      reason:
        | 'unknown_action'
        | 'unknown_quality_tier'
        | 'invalid_duration'
        | 'duration_required'
        | 'duration_exceeds_tiers'
        | 'ambiguous_configuration'
        | 'action_disabled';
      ruleset: RulesetSnapshot['ref'];
    };

/**
 * The cost of one action on a resolved ruleset.
 *
 * DURATION TIERS. When an action has rows with `max_duration_seconds`, the cost
 * is the SMALLEST tier that covers the requested duration. A duration beyond
 * the largest tier is refused (`duration_exceeds_tiers`) -- it is never priced
 * at the largest tier, which would undercharge. An action with tiered rows
 * requires a duration.
 *
 * AMBIGUITY IS REFUSED. If one action and quality tier has BOTH duration-tiered
 * rows and a row without a duration, the configuration does not say which
 * applies; guessing either could misprice, so the lookup fails instead.
 *
 * A DISABLED ROW IS NOT A FREE ROW. A matching disabled row stops the action
 * (`action_disabled`) rather than falling back to another tier.
 */
export function actionCostFor(
  ruleset: RulesetSnapshot,
  actionType: string,
  options: { qualityTier?: string; durationSeconds?: number } = {},
): ActionCostLookup {
  const ref = ruleset.ref;
  const qualityTier = options.qualityTier ?? 'standard';
  const forAction = ruleset.actionCosts.filter((c) => c.actionType === actionType);
  if (forAction.length === 0) return { ok: false, reason: 'unknown_action', ruleset: ref };
  const rows = forAction.filter((c) => c.qualityTier === qualityTier);
  if (rows.length === 0) return { ok: false, reason: 'unknown_quality_tier', ruleset: ref };

  const tiered = rows
    .filter((c) => c.maxDurationSeconds !== null)
    .sort((a, b) => a.maxDurationSeconds! - b.maxDurationSeconds!);
  const untiered = rows.filter((c) => c.maxDurationSeconds === null);
  if (tiered.length > 0 && untiered.length > 0) {
    return { ok: false, reason: 'ambiguous_configuration', ruleset: ref };
  }

  const { durationSeconds } = options;
  if (durationSeconds !== undefined && !(Number.isFinite(durationSeconds) && durationSeconds > 0)) {
    return { ok: false, reason: 'invalid_duration', ruleset: ref };
  }

  let chosen: ActionCostView | undefined;
  if (tiered.length > 0) {
    if (durationSeconds === undefined) return { ok: false, reason: 'duration_required', ruleset: ref };
    chosen = tiered.find((c) => c.maxDurationSeconds! >= durationSeconds);
    if (!chosen) return { ok: false, reason: 'duration_exceeds_tiers', ruleset: ref };
  } else {
    // The unique index allows exactly one untiered row per action and tier.
    chosen = untiered[0]!;
  }

  if (!chosen.enabled) return { ok: false, reason: 'action_disabled', ruleset: ref };
  return { ok: true, cost: chosen, ruleset: ref };
}

/** An allowance value. Missing is an explicit failure -- there is no default. */
export function allowanceFor(
  ruleset: RulesetSnapshot,
  key: string,
): { ok: true; value: number; ruleset: RulesetSnapshot['ref'] } | { ok: false; reason: 'missing_allowance'; ruleset: RulesetSnapshot['ref'] } {
  const value = ruleset.allowances.get(key);
  return value === undefined
    ? { ok: false, reason: 'missing_allowance', ruleset: ruleset.ref }
    : { ok: true, value, ruleset: ruleset.ref };
}

export function rewardFor(
  ruleset: RulesetSnapshot,
  rewardKey: string,
):
  | { ok: true; reward: RewardView; ruleset: RulesetSnapshot['ref'] }
  | { ok: false; reason: 'unknown_reward' | 'reward_disabled'; ruleset: RulesetSnapshot['ref'] } {
  const reward = ruleset.rewards.find((r) => r.rewardKey === rewardKey);
  if (!reward) return { ok: false, reason: 'unknown_reward', ruleset: ruleset.ref };
  if (!reward.enabled) return { ok: false, reason: 'reward_disabled', ruleset: ruleset.ref };
  return { ok: true, reward, ruleset: ruleset.ref };
}
