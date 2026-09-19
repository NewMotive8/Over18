import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  ECONOMY_ACTION_CATALOGUE,
  ECONOMY_ALLOWANCE_KEYS,
  ECONOMY_QUALITY_TIERS,
  PLAN_FEATURE_KEYS,
  type ActionCostInput,
  type AdminPackVersion,
  type AdminPlanVersion,
  type AdminRulesetVersion,
  type EconomyConfigurationView,
  type EconomyDraftDiff,
  type EconomyFieldChange,
  type EconomyPublishResult,
  type EconomyPublishReview,
  type EconomyVersionMeta,
  type EconomyVersionState,
  type PackDraftInput,
  type PlanDraftInput,
  type RewardInput,
  type RulesetDraftInput,
} from '@over18/shared';
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
import { recordAudit, type AuditActor } from './audit-service.js';
import { composeEconomy, computeEconomics, type PreviewInputs } from './economy-preview.js';
import { economyNow, resolvePackVersion, resolvePlanVersion, resolveRuleset } from './economy-resolver.js';

/**
 * THE ECONOMY CONFIGURATION WRITER (P1) -- drafts, review, publish, cancel.
 *
 * The one application module, besides the resolver, that touches the economy
 * configuration tables, and the only one that WRITES them. It adds no second
 * versioning system: it drives the P1.1 tables through the transitions their
 * triggers already enforce (0028, 0029) -- drafts only on insert, publication
 * as an explicit update stamped by the database clock, linear version order,
 * immutable published rows, cancellation at least a minute before effect.
 *
 *   draft    one open draft per plan, per pack, and for the global ruleset,
 *            created or replaced whole; discarding deletes it.
 *   review   every open draft against what is live now: an old -> new diff,
 *            blocking errors, non-blocking warnings, and a token naming the
 *            exact drafts reviewed.
 *   publish  ALL open drafts together, in one transaction, at one effective
 *            instant (now, or a scheduled future one), with one reason --
 *            refused if any draft changed after the review, or if the result
 *            would be incomplete or invalid.
 *   cancel   a published version that has not yet taken effect.
 *
 * Retiring a plan or pack is a version like any other: a draft with
 * `isPurchasable: false`, published forward-only. Existing subscribers are
 * unaffected -- the resolver still resolves the retired version.
 *
 * EVERY WRITE IS AUDITED inside its own transaction -- actor, before, after,
 * reason -- whether or not the generic admin audit hook is switched on.
 *
 * NO VALUE LIVES HERE. The catalogue (@over18/shared) fixes which keys a
 * configuration may use; every number is admin-entered.
 */

type Reader = Pick<Db, 'select' | 'selectDistinctOn' | 'execute'>;
export type EconomyKind = 'plan' | 'pack' | 'ruleset';

export class EconomyAdminError extends Error {
  constructor(
    public readonly code: 'invalid_configuration' | 'not_found' | 'economy_conflict' | 'drafts_changed' | 'not_publishable',
    message: string,
    public readonly messages: string[] = [message],
  ) {
    super(message);
    this.name = 'EconomyAdminError';
  }
}

export interface EconomyChangeContext {
  actor: AuditActor & { userId: string };
  reason?: string | null;
  requestId?: string | null;
}

const CODE = /^[a-z][a-z0-9_]{1,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;

/* ------------------------------------------------------------------ *
 * Validation -- the catalogue and the ranges, never a value
 * ------------------------------------------------------------------ */

const int = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const text = (v: unknown, max = 120): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

type StoredPlan = Omit<PlanDraftInput, 'features'> & { features: Record<string, unknown> };

/**
 * A plan draft. `forPublish` adds completeness: every catalogue feature flag
 * must be stated. Unknown flags and non-boolean values are refused always.
 */
export function validatePlan(plan: StoredPlan, forPublish: boolean): string[] {
  const errors: string[] = [];
  if (!text(plan.displayName)) errors.push('displayName must be 1 to 120 characters.');
  if (!int(plan.billingPeriodMonths, 1, 36)) errors.push('billingPeriodMonths must be a whole number from 1 to 36.');
  if (!int(plan.priceMinor, 1)) errors.push('priceMinor must be a positive whole number of minor units.');
  if (typeof plan.currency !== 'string' || !CURRENCY.test(plan.currency)) errors.push('currency must be a 3-letter code.');
  if (!int(plan.monthlyIncludedCredits, 0)) errors.push('monthlyIncludedCredits must be a whole number, 0 or more.');
  if (typeof plan.isPurchasable !== 'boolean') errors.push('isPurchasable must be true or false.');
  const features = plan.features && typeof plan.features === 'object' && !Array.isArray(plan.features) ? plan.features : null;
  if (!features) {
    errors.push('features must be an object of catalogue flags.');
  } else {
    for (const [key, value] of Object.entries(features)) {
      if (!(PLAN_FEATURE_KEYS as readonly string[]).includes(key)) errors.push(`features.${key} is not a catalogue feature (${PLAN_FEATURE_KEYS.join(', ')}).`);
      else if (typeof value !== 'boolean') errors.push(`features.${key} must be true or false.`);
    }
    if (forPublish) {
      for (const key of PLAN_FEATURE_KEYS) if (!(key in features)) errors.push(`features.${key} must be stated before publishing.`);
    }
  }
  return errors;
}

export function validatePack(pack: PackDraftInput): string[] {
  const errors: string[] = [];
  if (!text(pack.displayName)) errors.push('displayName must be 1 to 120 characters.');
  if (!int(pack.credits, 1)) errors.push('credits must be a positive whole number.');
  if (!int(pack.priceMinor, 1)) errors.push('priceMinor must be a positive whole number of minor units.');
  if (typeof pack.currency !== 'string' || !CURRENCY.test(pack.currency)) errors.push('currency must be a 3-letter code.');
  if (!int(pack.sortOrder, 0)) errors.push('sortOrder must be a whole number, 0 or more.');
  if (typeof pack.isBestValue !== 'boolean') errors.push('isBestValue must be true or false.');
  if (typeof pack.isPurchasable !== 'boolean') errors.push('isPurchasable must be true or false.');
  return errors;
}

const costKey = (c: Pick<ActionCostInput, 'actionType' | 'qualityTier' | 'maxDurationSeconds'>) =>
  `${c.actionType}/${c.qualityTier}/${c.maxDurationSeconds === null ? 'any' : `${c.maxDurationSeconds}s`}`;

/**
 * A ruleset draft, against the key catalogue: known action types and tiers,
 * each action in its catalogue unit, duration tiers where (and only where)
 * the catalogue requires them, and only catalogue allowances. `forPublish`
 * adds completeness: at least one enabled action cost, and every allowance.
 */
export function validateRuleset(ruleset: RulesetDraftInput, forPublish: boolean): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  ruleset.actionCosts.forEach((c, i) => {
    const at = `actionCosts[${i}]`;
    const entry = ECONOMY_ACTION_CATALOGUE[c.actionType as keyof typeof ECONOMY_ACTION_CATALOGUE] as
      | (typeof ECONOMY_ACTION_CATALOGUE)[keyof typeof ECONOMY_ACTION_CATALOGUE]
      | undefined;
    if (!entry) {
      errors.push(`${at}.actionType "${c.actionType}" is not in the catalogue (${Object.keys(ECONOMY_ACTION_CATALOGUE).join(', ')}).`);
    } else {
      if (c.unit !== entry.unit) errors.push(`${at}.unit must be ${entry.unit} for ${c.actionType}.`);
      if (entry.durationTiers === 'required' && !int(c.maxDurationSeconds, 1)) {
        errors.push(`${at}.maxDurationSeconds is required for ${c.actionType}: its costs are split by duration.`);
      }
      if (entry.durationTiers === 'forbidden' && c.maxDurationSeconds !== null) {
        errors.push(`${at}.maxDurationSeconds must be null for ${c.actionType}: it has no duration tiers.`);
      }
    }
    if (!(ECONOMY_QUALITY_TIERS as readonly string[]).includes(c.qualityTier)) {
      errors.push(`${at}.qualityTier must be one of ${ECONOMY_QUALITY_TIERS.join(', ')}.`);
    }
    if (!int(c.creditCost, 1)) errors.push(`${at}.creditCost must be a positive whole number; a free action is disabled, not priced at 0.`);
    if (typeof c.enabled !== 'boolean') errors.push(`${at}.enabled must be true or false.`);
    const key = costKey(c);
    if (seen.has(key)) errors.push(`${at} repeats the cost for ${key}.`);
    seen.add(key);
  });
  for (const [key, value] of Object.entries(ruleset.allowances)) {
    if (!(ECONOMY_ALLOWANCE_KEYS as readonly string[]).includes(key)) errors.push(`allowances.${key} is not a catalogue allowance (${ECONOMY_ALLOWANCE_KEYS.join(', ')}).`);
    else if (!int(value, 0)) errors.push(`allowances.${key} must be a whole number, 0 or more.`);
  }
  const rewardKeys = new Set<string>();
  ruleset.rewards.forEach((r, i) => {
    const at = `rewards[${i}]`;
    if (typeof r.rewardKey !== 'string' || !CODE.test(r.rewardKey)) errors.push(`${at}.rewardKey is not a valid key.`);
    if (!int(r.credits, 1)) errors.push(`${at}.credits must be a positive whole number.`);
    if (r.perUserCap !== null && !int(r.perUserCap, 1)) errors.push(`${at}.perUserCap must be a positive whole number, or null for once per user.`);
    if (typeof r.enabled !== 'boolean') errors.push(`${at}.enabled must be true or false.`);
    if (rewardKeys.has(r.rewardKey)) errors.push(`${at} repeats the reward ${r.rewardKey}.`);
    rewardKeys.add(r.rewardKey);
  });
  if (forPublish) {
    if (!ruleset.actionCosts.some((c) => c.enabled)) errors.push('At least one action cost must be enabled before publishing.');
    for (const key of ECONOMY_ALLOWANCE_KEYS) if (!(key in ruleset.allowances)) errors.push(`allowances.${key} must be set before publishing.`);
  }
  return errors;
}

function requireReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (!trimmed || trimmed.length > REASON_MAX) {
    throw new EconomyAdminError('invalid_configuration', `A reason of 1 to ${REASON_MAX} characters is required.`);
  }
  return trimmed;
}

function requireCode(code: string): string {
  if (!CODE.test(code)) throw new EconomyAdminError('invalid_configuration', `"${code}" is not a valid code (lowercase letters, digits and _).`);
  return code;
}

/** The Postgres error behind a Drizzle error, if any: its code lives on `cause`. */
function pgError(error: unknown): { code: string; message: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && typeof (current as { code?: unknown }).code === 'string' && /^\d{5}$/.test((current as { code: string }).code)) {
      return { code: (current as { code: string }).code, message: (current as { message?: string }).message ?? '' };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Lifecycle refusals from the P1.1 triggers (23514) and unique races (23505) become conflicts. */
async function lifecycle<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const pg = pgError(error);
    if (pg && (pg.code === '23514' || pg.code === '23505')) throw new EconomyAdminError('economy_conflict', pg.message);
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Reading versions, with their derived state
 * ------------------------------------------------------------------ */

const iso = (col: AnyPgColumn | SQL): SQL<string> => sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const metaColumns = <T extends typeof economyPlanVersions | typeof economyPackVersions | typeof economyRulesets>(t: T) => ({
  id: t.id,
  version: t.version,
  status: t.status,
  effectiveFrom: iso(t.effectiveFrom),
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
  createdBy: t.createdBy,
  publishedAt: iso(t.publishedAt),
  publishedBy: t.publishedBy,
  publishReason: t.publishReason,
  cancelledAt: iso(t.cancelledAt),
  cancelledBy: t.cancelledBy,
  cancelReason: t.cancelReason,
});

type MetaRow = Omit<EconomyVersionMeta, 'state'> & { status: 'draft' | 'published' | 'cancelled' };

const planColumns = {
  ...metaColumns(economyPlanVersions),
  code: economyPlans.code,
  displayName: economyPlanVersions.displayName,
  billingPeriodMonths: economyPlanVersions.billingPeriodMonths,
  priceMinor: economyPlanVersions.priceMinor,
  currency: economyPlanVersions.currency,
  monthlyIncludedCredits: economyPlanVersions.monthlyIncludedCredits,
  features: economyPlanVersions.features,
  isPurchasable: economyPlanVersions.isPurchasable,
};
const packColumns = {
  ...metaColumns(economyPackVersions),
  code: economyPacks.code,
  displayName: economyPackVersions.displayName,
  credits: economyPackVersions.credits,
  priceMinor: economyPackVersions.priceMinor,
  currency: economyPackVersions.currency,
  sortOrder: economyPackVersions.sortOrder,
  isBestValue: economyPackVersions.isBestValue,
  isPurchasable: economyPackVersions.isPurchasable,
};

/**
 * States within one version stream, at `now`: the published version with the
 * latest effective instant not after `now` is active, earlier ones are
 * superseded, later ones scheduled. Mirrors the resolver's rule exactly.
 */
function withStates<V extends MetaRow>(versions: V[], now: string): Array<Omit<V, 'status'> & { state: EconomyVersionState }> {
  const effective = versions.filter((v) => v.status === 'published' && v.effectiveFrom !== null && v.effectiveFrom <= now);
  const active = effective.reduce<V | null>((best, v) => (!best || v.effectiveFrom! > best.effectiveFrom! ? v : best), null);
  return versions.map(({ status, ...rest }) => {
    const state: EconomyVersionState =
      status === 'draft'
        ? 'draft'
        : status === 'cancelled'
          ? 'cancelled'
          : (rest.effectiveFrom as string) > now
            ? 'scheduled'
            : rest.id === active?.id
              ? 'active'
              : 'superseded';
    return { ...rest, state };
  });
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
}

async function rulesetChildren(reader: Reader, rulesetIds: string[]): Promise<Map<string, RulesetDraftInput>> {
  if (rulesetIds.length === 0) return new Map();
  const [costs, allowances, rewards] = await Promise.all([
    reader
      .select({
        rulesetId: economyRulesetActionCosts.rulesetId,
        actionType: economyRulesetActionCosts.actionType,
        qualityTier: economyRulesetActionCosts.qualityTier,
        maxDurationSeconds: economyRulesetActionCosts.maxDurationSeconds,
        unit: economyRulesetActionCosts.unit,
        creditCost: economyRulesetActionCosts.creditCost,
        enabled: economyRulesetActionCosts.enabled,
      })
      .from(economyRulesetActionCosts)
      .where(inArray(economyRulesetActionCosts.rulesetId, rulesetIds))
      .orderBy(asc(economyRulesetActionCosts.actionType), asc(economyRulesetActionCosts.qualityTier), asc(economyRulesetActionCosts.maxDurationSeconds)),
    reader
      .select({ rulesetId: economyRulesetAllowances.rulesetId, key: economyRulesetAllowances.key, value: economyRulesetAllowances.value })
      .from(economyRulesetAllowances)
      .where(inArray(economyRulesetAllowances.rulesetId, rulesetIds))
      .orderBy(asc(economyRulesetAllowances.key)),
    reader
      .select({
        rulesetId: economyRulesetRewards.rulesetId,
        rewardKey: economyRulesetRewards.rewardKey,
        credits: economyRulesetRewards.credits,
        perUserCap: economyRulesetRewards.perUserCap,
        enabled: economyRulesetRewards.enabled,
      })
      .from(economyRulesetRewards)
      .where(inArray(economyRulesetRewards.rulesetId, rulesetIds))
      .orderBy(asc(economyRulesetRewards.rewardKey)),
  ]);
  const out = new Map<string, RulesetDraftInput>();
  for (const id of rulesetIds) out.set(id, { actionCosts: [], allowances: {}, rewards: [] });
  for (const { rulesetId, ...c } of costs) out.get(rulesetId)!.actionCosts.push(c);
  for (const a of allowances) out.get(a.rulesetId)!.allowances[a.key] = a.value;
  for (const { rulesetId, ...r } of rewards) out.get(rulesetId)!.rewards.push(r);
  return out;
}

/** Every plan, pack and ruleset version, with its state at the database clock. */
export async function readEconomyConfiguration(db: Reader): Promise<EconomyConfigurationView> {
  const asOf = (await economyNow(db)).iso;
  const [plans, packs, rulesets] = await Promise.all([
    db
      .select(planColumns)
      .from(economyPlanVersions)
      .innerJoin(economyPlans, eq(economyPlans.id, economyPlanVersions.planId))
      .orderBy(asc(economyPlans.code), asc(economyPlanVersions.version)),
    db
      .select(packColumns)
      .from(economyPackVersions)
      .innerJoin(economyPacks, eq(economyPacks.id, economyPackVersions.packId))
      .orderBy(asc(economyPacks.code), asc(economyPackVersions.version)),
    db.select(metaColumns(economyRulesets)).from(economyRulesets).orderBy(asc(economyRulesets.version)),
  ]);
  const children = await rulesetChildren(db, rulesets.map((r) => r.id));
  const byCode = <R extends MetaRow & { code: string }>(rows: R[]) =>
    [...groupBy(rows, (r) => r.code)].map(([code, versions]) => ({
      code,
      versions: withStates(versions, asOf).map(({ code: _code, ...v }) => v),
    }));
  return {
    asOf,
    plans: byCode(plans) as EconomyConfigurationView['plans'],
    packs: byCode(packs) as EconomyConfigurationView['packs'],
    rulesets: withStates(rulesets, asOf).map((r) => ({ ...r, ...children.get(r.id)! })),
    catalogue: {
      planFeatures: PLAN_FEATURE_KEYS,
      qualityTiers: ECONOMY_QUALITY_TIERS,
      actions: ECONOMY_ACTION_CATALOGUE,
      allowances: ECONOMY_ALLOWANCE_KEYS,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Drafts
 * ------------------------------------------------------------------ */

const planFields = (p: StoredPlan) => ({
  displayName: p.displayName,
  billingPeriodMonths: p.billingPeriodMonths,
  priceMinor: p.priceMinor,
  currency: p.currency,
  monthlyIncludedCredits: p.monthlyIncludedCredits,
  features: Object.fromEntries(Object.entries(p.features ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  isPurchasable: p.isPurchasable,
});
const packFields = (p: PackDraftInput) => ({
  displayName: p.displayName,
  credits: p.credits,
  priceMinor: p.priceMinor,
  currency: p.currency,
  sortOrder: p.sortOrder,
  isBestValue: p.isBestValue,
  isPurchasable: p.isPurchasable,
});
const rulesetFields = (r: RulesetDraftInput): RulesetDraftInput => ({
  actionCosts: [...r.actionCosts]
    .map((c) => ({ actionType: c.actionType, qualityTier: c.qualityTier, maxDurationSeconds: c.maxDurationSeconds, unit: c.unit, creditCost: c.creditCost, enabled: c.enabled }))
    .sort((a, b) => costKey(a).localeCompare(costKey(b))),
  allowances: Object.fromEntries(Object.entries(r.allowances).sort(([a], [b]) => a.localeCompare(b))),
  rewards: [...r.rewards]
    .map((w) => ({ rewardKey: w.rewardKey, credits: w.credits, perUserCap: w.perUserCap, enabled: w.enabled }))
    .sort((a, b) => a.rewardKey.localeCompare(b.rewardKey)),
});

function invalid(errors: string[]): never {
  throw new EconomyAdminError('invalid_configuration', errors[0] ?? 'Invalid configuration.', errors);
}

/**
 * Creates or replaces a plan's open draft -- and the plan itself, the first
 * time its code is used. The draft carries no schedule: the effective instant
 * is chosen when the economy is published.
 */
export async function savePlanDraft(db: Db, code: string, input: PlanDraftInput, ctx: EconomyChangeContext): Promise<AdminPlanVersion> {
  requireCode(code);
  const errors = validatePlan(input, false);
  if (errors.length > 0) invalid(errors);
  const fields = planFields(input);
  return lifecycle(() =>
    db.transaction(async (tx) => {
      let [plan] = await tx.select({ id: economyPlans.id }).from(economyPlans).where(eq(economyPlans.code, code)).for('update');
      const created = !plan;
      if (!plan) [plan] = await tx.insert(economyPlans).values({ code }).returning({ id: economyPlans.id });
      const [draft] = await tx
        .select({ id: economyPlanVersions.id, version: economyPlanVersions.version, ...planFieldsColumns })
        .from(economyPlanVersions)
        .where(and(eq(economyPlanVersions.planId, plan!.id), eq(economyPlanVersions.status, 'draft')))
        .for('update');
      let id: string;
      let version: number;
      if (draft) {
        await tx.update(economyPlanVersions).set({ ...fields, effectiveFrom: null }).where(eq(economyPlanVersions.id, draft.id));
        ({ id, version } = draft);
      } else {
        version = await nextVersion(tx, sql`select coalesce(max(${economyPlanVersions.version}), 0) + 1 as next from ${economyPlanVersions} where ${economyPlanVersions.planId} = ${plan!.id}`);
        [{ id }] = (await tx
          .insert(economyPlanVersions)
          .values({ planId: plan!.id, version, ...fields, createdBy: ctx.actor.userId })
          .returning({ id: economyPlanVersions.id })) as [{ id: string }];
      }
      await recordAudit(tx, {
        actor: ctx.actor,
        action: 'economy.plan.draft.save',
        objectType: 'economy_plan',
        objectId: code,
        before: draft ? { version: draft.version, ...planFields(draft) } : null,
        after: { version, ...fields },
        reason: ctx.reason?.trim() || null,
        requestId: ctx.requestId ?? null,
        metadata: { planCreated: created, versionId: id },
      });
      return (await readPlanVersion(tx, id))!;
    }),
  );
}

const planFieldsColumns = {
  displayName: economyPlanVersions.displayName,
  billingPeriodMonths: economyPlanVersions.billingPeriodMonths,
  priceMinor: economyPlanVersions.priceMinor,
  currency: economyPlanVersions.currency,
  monthlyIncludedCredits: economyPlanVersions.monthlyIncludedCredits,
  features: economyPlanVersions.features,
  isPurchasable: economyPlanVersions.isPurchasable,
};
const packFieldsColumns = {
  displayName: economyPackVersions.displayName,
  credits: economyPackVersions.credits,
  priceMinor: economyPackVersions.priceMinor,
  currency: economyPackVersions.currency,
  sortOrder: economyPackVersions.sortOrder,
  isBestValue: economyPackVersions.isBestValue,
  isPurchasable: economyPackVersions.isPurchasable,
};

async function nextVersion(tx: Pick<Db, 'execute'>, query: SQL): Promise<number> {
  const result = await tx.execute<{ next: number | string }>(query);
  return Number(result.rows[0]!.next);
}

async function stateAt<V extends MetaRow>(reader: Reader, rows: V[], id: string) {
  const now = (await economyNow(reader)).iso;
  return withStates(rows, now).find((v) => v.id === id)!;
}

async function readPlanVersion(reader: Reader, id: string): Promise<AdminPlanVersion | null> {
  const [row] = await reader
    .select(planColumns)
    .from(economyPlanVersions)
    .innerJoin(economyPlans, eq(economyPlans.id, economyPlanVersions.planId))
    .where(eq(economyPlanVersions.id, id));
  if (!row) return null;
  const siblings = await reader
    .select(planColumns)
    .from(economyPlanVersions)
    .innerJoin(economyPlans, eq(economyPlans.id, economyPlanVersions.planId))
    .where(eq(economyPlans.code, row.code));
  const { code: _code, ...version } = await stateAt(reader, siblings, id);
  return version as AdminPlanVersion;
}

async function readPackVersion(reader: Reader, id: string): Promise<AdminPackVersion | null> {
  const [row] = await reader
    .select(packColumns)
    .from(economyPackVersions)
    .innerJoin(economyPacks, eq(economyPacks.id, economyPackVersions.packId))
    .where(eq(economyPackVersions.id, id));
  if (!row) return null;
  const siblings = await reader
    .select(packColumns)
    .from(economyPackVersions)
    .innerJoin(economyPacks, eq(economyPacks.id, economyPackVersions.packId))
    .where(eq(economyPacks.code, row.code));
  const { code: _code, ...version } = await stateAt(reader, siblings, id);
  return version as AdminPackVersion;
}

async function readRulesetVersion(reader: Reader, id: string): Promise<AdminRulesetVersion | null> {
  const all = await reader.select(metaColumns(economyRulesets)).from(economyRulesets);
  if (!all.some((r) => r.id === id)) return null;
  const meta = await stateAt(reader, all, id);
  return { ...meta, ...(await rulesetChildren(reader, [id])).get(id)! };
}

/** Discards a plan's open draft; a plan left with no version at all is removed too. */
export async function discardPlanDraft(db: Db, code: string, ctx: EconomyChangeContext): Promise<void> {
  requireCode(code);
  await lifecycle(() =>
    db.transaction(async (tx) => {
      const [plan] = await tx.select({ id: economyPlans.id }).from(economyPlans).where(eq(economyPlans.code, code)).for('update');
      const [draft] = plan
        ? await tx
            .select({ id: economyPlanVersions.id, version: economyPlanVersions.version, ...planFieldsColumns })
            .from(economyPlanVersions)
            .where(and(eq(economyPlanVersions.planId, plan.id), eq(economyPlanVersions.status, 'draft')))
            .for('update')
        : [];
      if (!plan || !draft) throw new EconomyAdminError('not_found', `Plan ${code} has no open draft.`);
      await tx.delete(economyPlanVersions).where(eq(economyPlanVersions.id, draft.id));
      const [remaining] = await tx.select({ id: economyPlanVersions.id }).from(economyPlanVersions).where(eq(economyPlanVersions.planId, plan.id)).limit(1);
      if (!remaining) await tx.delete(economyPlans).where(eq(economyPlans.id, plan.id));
      await recordAudit(tx, {
        actor: ctx.actor,
        action: 'economy.plan.draft.discard',
        objectType: 'economy_plan',
        objectId: code,
        before: { version: draft.version, ...planFields(draft) },
        after: null,
        reason: ctx.reason?.trim() || null,
        requestId: ctx.requestId ?? null,
        metadata: { planRemoved: !remaining, versionId: draft.id },
      });
    }),
  );
}

export async function savePackDraft(db: Db, code: string, input: PackDraftInput, ctx: EconomyChangeContext): Promise<AdminPackVersion> {
  requireCode(code);
  const errors = validatePack(input);
  if (errors.length > 0) invalid(errors);
  const fields = packFields(input);
  return lifecycle(() =>
    db.transaction(async (tx) => {
      let [pack] = await tx.select({ id: economyPacks.id }).from(economyPacks).where(eq(economyPacks.code, code)).for('update');
      const created = !pack;
      if (!pack) [pack] = await tx.insert(economyPacks).values({ code }).returning({ id: economyPacks.id });
      const [draft] = await tx
        .select({ id: economyPackVersions.id, version: economyPackVersions.version, ...packFieldsColumns })
        .from(economyPackVersions)
        .where(and(eq(economyPackVersions.packId, pack!.id), eq(economyPackVersions.status, 'draft')))
        .for('update');
      let id: string;
      let version: number;
      if (draft) {
        await tx.update(economyPackVersions).set({ ...fields, effectiveFrom: null }).where(eq(economyPackVersions.id, draft.id));
        ({ id, version } = draft);
      } else {
        version = await nextVersion(tx, sql`select coalesce(max(${economyPackVersions.version}), 0) + 1 as next from ${economyPackVersions} where ${economyPackVersions.packId} = ${pack!.id}`);
        [{ id }] = (await tx
          .insert(economyPackVersions)
          .values({ packId: pack!.id, version, ...fields, createdBy: ctx.actor.userId })
          .returning({ id: economyPackVersions.id })) as [{ id: string }];
      }
      await recordAudit(tx, {
        actor: ctx.actor,
        action: 'economy.pack.draft.save',
        objectType: 'economy_pack',
        objectId: code,
        before: draft ? { version: draft.version, ...packFields(draft) } : null,
        after: { version, ...fields },
        reason: ctx.reason?.trim() || null,
        requestId: ctx.requestId ?? null,
        metadata: { packCreated: created, versionId: id },
      });
      return (await readPackVersion(tx, id))!;
    }),
  );
}

export async function discardPackDraft(db: Db, code: string, ctx: EconomyChangeContext): Promise<void> {
  requireCode(code);
  await lifecycle(() =>
    db.transaction(async (tx) => {
      const [pack] = await tx.select({ id: economyPacks.id }).from(economyPacks).where(eq(economyPacks.code, code)).for('update');
      const [draft] = pack
        ? await tx
            .select({ id: economyPackVersions.id, version: economyPackVersions.version, ...packFieldsColumns })
            .from(economyPackVersions)
            .where(and(eq(economyPackVersions.packId, pack.id), eq(economyPackVersions.status, 'draft')))
            .for('update')
        : [];
      if (!pack || !draft) throw new EconomyAdminError('not_found', `Pack ${code} has no open draft.`);
      await tx.delete(economyPackVersions).where(eq(economyPackVersions.id, draft.id));
      const [remaining] = await tx.select({ id: economyPackVersions.id }).from(economyPackVersions).where(eq(economyPackVersions.packId, pack.id)).limit(1);
      if (!remaining) await tx.delete(economyPacks).where(eq(economyPacks.id, pack.id));
      await recordAudit(tx, {
        actor: ctx.actor,
        action: 'economy.pack.draft.discard',
        objectType: 'economy_pack',
        objectId: code,
        before: { version: draft.version, ...packFields(draft) },
        after: null,
        reason: ctx.reason?.trim() || null,
        requestId: ctx.requestId ?? null,
        metadata: { packRemoved: !remaining, versionId: draft.id },
      });
    }),
  );
}

/**
 * Creates or replaces THE ruleset draft -- action costs, allowances and
 * rewards change together, as one snapshot (P1.1), never row by row.
 */
export async function saveRulesetDraft(db: Db, input: RulesetDraftInput, ctx: EconomyChangeContext): Promise<AdminRulesetVersion> {
  const errors = validateRuleset(input, false);
  if (errors.length > 0) invalid(errors);
  const fields = rulesetFields(input);
  return lifecycle(() =>
    db.transaction(async (tx) => {
      const [draft] = await tx
        .select({ id: economyRulesets.id, version: economyRulesets.version })
        .from(economyRulesets)
        .where(eq(economyRulesets.status, 'draft'))
        .for('update');
      const before = draft ? { version: draft.version, ...(await rulesetChildren(tx, [draft.id])).get(draft.id)! } : null;
      let id: string;
      let version: number;
      if (draft) {
        ({ id, version } = draft);
        await Promise.all([
          tx.delete(economyRulesetActionCosts).where(eq(economyRulesetActionCosts.rulesetId, id)),
          tx.delete(economyRulesetAllowances).where(eq(economyRulesetAllowances.rulesetId, id)),
          tx.delete(economyRulesetRewards).where(eq(economyRulesetRewards.rulesetId, id)),
        ]);
        // Touches the row, so its updated_at (stamped by the trigger) moves with its contents.
        await tx.update(economyRulesets).set({ effectiveFrom: null }).where(eq(economyRulesets.id, id));
      } else {
        version = await nextVersion(tx, sql`select coalesce(max(${economyRulesets.version}), 0) + 1 as next from ${economyRulesets}`);
        [{ id }] = (await tx.insert(economyRulesets).values({ version, createdBy: ctx.actor.userId }).returning({ id: economyRulesets.id })) as [{ id: string }];
      }
      if (fields.actionCosts.length > 0) await tx.insert(economyRulesetActionCosts).values(fields.actionCosts.map((c) => ({ rulesetId: id, ...c })));
      const allowances = Object.entries(fields.allowances);
      if (allowances.length > 0) await tx.insert(economyRulesetAllowances).values(allowances.map(([key, value]) => ({ rulesetId: id, key, value })));
      if (fields.rewards.length > 0) await tx.insert(economyRulesetRewards).values(fields.rewards.map((r) => ({ rulesetId: id, ...r })));
      await recordAudit(tx, {
        actor: ctx.actor,
        action: 'economy.ruleset.draft.save',
        objectType: 'economy_ruleset',
        objectId: String(version),
        before,
        after: { version, ...fields },
        reason: ctx.reason?.trim() || null,
        requestId: ctx.requestId ?? null,
        metadata: { versionId: id },
      });
      return (await readRulesetVersion(tx, id))!;
    }),
  );
}

export async function discardRulesetDraft(db: Db, ctx: EconomyChangeContext): Promise<void> {
  await lifecycle(() =>
    db.transaction(async (tx) => {
      const [draft] = await tx
        .select({ id: economyRulesets.id, version: economyRulesets.version })
        .from(economyRulesets)
        .where(eq(economyRulesets.status, 'draft'))
        .for('update');
      if (!draft) throw new EconomyAdminError('not_found', 'There is no open ruleset draft.');
      const before = { version: draft.version, ...(await rulesetChildren(tx, [draft.id])).get(draft.id)! };
      await tx.delete(economyRulesets).where(eq(economyRulesets.id, draft.id));
      await recordAudit(tx, {
        actor: ctx.actor,
        action: 'economy.ruleset.draft.discard',
        objectType: 'economy_ruleset',
        objectId: String(draft.version),
        before,
        after: null,
        reason: ctx.reason?.trim() || null,
        requestId: ctx.requestId ?? null,
        metadata: { versionId: draft.id },
      });
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Review: the draft set, its diff, its errors and warnings
 * ------------------------------------------------------------------ */

interface DraftSet {
  plans: Array<{ id: string; code: string; version: number; fields: ReturnType<typeof planFields> }>;
  packs: Array<{ id: string; code: string; version: number; fields: ReturnType<typeof packFields> }>;
  ruleset: { id: string; version: number; fields: RulesetDraftInput } | null;
}

/** Every open draft, in a canonical order. With `lock`, each draft row is held FOR UPDATE. */
async function loadDraftSet(reader: Reader, lock: boolean): Promise<DraftSet> {
  const planQuery = reader
    .select({ id: economyPlanVersions.id, code: economyPlans.code, version: economyPlanVersions.version, ...planFieldsColumns })
    .from(economyPlanVersions)
    .innerJoin(economyPlans, eq(economyPlans.id, economyPlanVersions.planId))
    .where(eq(economyPlanVersions.status, 'draft'))
    .orderBy(asc(economyPlans.code));
  const packQuery = reader
    .select({ id: economyPackVersions.id, code: economyPacks.code, version: economyPackVersions.version, ...packFieldsColumns })
    .from(economyPackVersions)
    .innerJoin(economyPacks, eq(economyPacks.id, economyPackVersions.packId))
    .where(eq(economyPackVersions.status, 'draft'))
    .orderBy(asc(economyPacks.code));
  const rulesetQuery = reader
    .select({ id: economyRulesets.id, version: economyRulesets.version })
    .from(economyRulesets)
    .where(eq(economyRulesets.status, 'draft'));
  const [plans, packs, [ruleset]] = await Promise.all(
    lock ? [planQuery.for('update', { of: economyPlanVersions }), packQuery.for('update', { of: economyPackVersions }), rulesetQuery.for('update')] : [planQuery, packQuery, rulesetQuery],
  ) as [Array<{ id: string; code: string; version: number } & StoredPlan>, Array<{ id: string; code: string; version: number } & PackDraftInput>, Array<{ id: string; version: number }>];
  return {
    plans: plans.map(({ id, code, version, ...p }) => ({ id, code, version, fields: planFields(p) })),
    packs: packs.map(({ id, code, version, ...p }) => ({ id, code, version, fields: packFields(p) })),
    ruleset: ruleset ? { id: ruleset.id, version: ruleset.version, fields: rulesetFields((await rulesetChildren(reader, [ruleset.id])).get(ruleset.id)!) } : null,
  };
}

/** Names the exact drafts reviewed: any change to any draft changes the token. */
function draftSetToken(drafts: DraftSet): string {
  return createHash('sha256').update(JSON.stringify(drafts)).digest('hex');
}

function fieldChanges(prefix: string, before: Record<string, unknown> | null, after: Record<string, unknown>): EconomyFieldChange[] {
  const changes: EconomyFieldChange[] = [];
  for (const [field, value] of Object.entries(after)) {
    const old = before ? before[field] : null;
    if (field === 'features' && value && typeof value === 'object') {
      const oldFeatures = (old ?? {}) as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(oldFeatures), ...Object.keys(value)])].sort();
      for (const key of keys) {
        const a = oldFeatures[key] ?? null;
        const b = (value as Record<string, unknown>)[key] ?? null;
        if (!before || a !== b) changes.push({ field: `${prefix}features.${key}`, before: before ? a : null, after: b });
      }
    } else if (!before || JSON.stringify(old) !== JSON.stringify(value)) {
      changes.push({ field: `${prefix}${field}`, before: before ? old : null, after: value });
    }
  }
  return changes;
}

function rulesetChanges(before: RulesetDraftInput | null, after: RulesetDraftInput): EconomyFieldChange[] {
  const changes: EconomyFieldChange[] = [];
  const compare = (label: string, old: Map<string, unknown>, next: Map<string, unknown>) => {
    for (const key of [...new Set([...old.keys(), ...next.keys()])].sort()) {
      const a = old.get(key) ?? null;
      const b = next.get(key) ?? null;
      if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ field: `${label}.${key}`, before: a, after: b });
    }
  };
  const costs = (rows: ActionCostInput[]) =>
    new Map<string, unknown>(rows.map((c) => [costKey(c), { unit: c.unit, creditCost: c.creditCost, enabled: c.enabled }]));
  const rewards = (rows: RewardInput[]) =>
    new Map<string, unknown>(rows.map((r) => [r.rewardKey, { credits: r.credits, perUserCap: r.perUserCap, enabled: r.enabled }]));
  compare('actionCosts', costs(before?.actionCosts ?? []), costs(after.actionCosts));
  compare('allowances', new Map(Object.entries(before?.allowances ?? {})), new Map(Object.entries(after.allowances)));
  compare('rewards', rewards(before?.rewards ?? []), rewards(after.rewards));
  return changes;
}

const EMPTY_COST_INPUTS: PreviewInputs = {
  mode: 'drafted',
  providers: [],
  rates: [],
  usage: { actions: [], plans: [] },
  salesChannels: [],
  otherCosts: { actions: [], plans: [] },
  marginGuard: { minGrossMarginPercent: null, minNetMarginPercent: null, maxCostAgeDays: null },
};

/**
 * The drafts against what is live at the database clock. Errors block
 * publishing; warnings never do. Runtime refusals and ladder shape come from
 * the P1.3 preview itself, so review and runtime cannot disagree.
 */
async function assess(reader: Reader, drafts: DraftSet): Promise<Omit<EconomyPublishReview, 'draftSetToken'>> {
  const asOf = await economyNow(reader);
  const diff: EconomyDraftDiff[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  if (drafts.plans.length === 0 && drafts.packs.length === 0 && !drafts.ruleset) errors.push('There are no drafts to publish.');

  for (const draft of drafts.plans) {
    for (const e of validatePlan(draft.fields, true)) errors.push(`Plan ${draft.code}: ${e}`);
    const live = await resolvePlanVersion(reader, draft.code, asOf);
    const liveFields = live.ok ? planFields(live.value) : null;
    diff.push({ kind: 'plan', code: draft.code, draftVersion: draft.version, liveVersion: live.ok ? live.value.ref.version : null, changes: fieldChanges('', liveFields, draft.fields) });
  }
  for (const draft of drafts.packs) {
    for (const e of validatePack(draft.fields)) errors.push(`Pack ${draft.code}: ${e}`);
    const live = await resolvePackVersion(reader, draft.code, asOf);
    const liveFields = live.ok ? packFields(live.value) : null;
    diff.push({ kind: 'pack', code: draft.code, draftVersion: draft.version, liveVersion: live.ok ? live.value.ref.version : null, changes: fieldChanges('', liveFields, draft.fields) });
  }
  const liveRuleset = await resolveRuleset(reader, asOf);
  if (drafts.ruleset) {
    for (const e of validateRuleset(drafts.ruleset.fields, true)) errors.push(`Ruleset: ${e}`);
    const before = liveRuleset.ok
      ? rulesetFields({
          actionCosts: [...liveRuleset.value.actionCosts],
          allowances: Object.fromEntries(liveRuleset.value.allowances),
          rewards: [...liveRuleset.value.rewards],
        })
      : null;
    diff.push({
      kind: 'ruleset',
      code: null,
      draftVersion: drafts.ruleset.version,
      liveVersion: liveRuleset.ok ? liveRuleset.value.ref.version : null,
      changes: rulesetChanges(before, drafts.ruleset.fields),
    });
  } else if (!liveRuleset.ok) {
    errors.push('A ruleset must be live or drafted: the economy cannot be published without action costs and allowances.');
  }

  // The economy as it would be once published, through the P1.3 preview.
  const preview = computeEconomics(await composeEconomy(reader, 'drafted'), EMPTY_COST_INPUTS);
  for (const issue of preview.configurationIssues) errors.push(`Runtime would refuse to price ${issue.action}: ${issue.reason}.`);
  for (const ladder of preview.ladders) {
    for (const issue of ladder.issues) {
      warnings.push(
        issue.kind === 'inverted'
          ? `Pack ${issue.rung} is dearer per Credit than ${issue.previous} (${ladder.currency}).`
          : `Pack ${issue.rung} is no cheaper per Credit than ${issue.previous} (${ladder.currency}).`,
      );
    }
  }

  // A scheduled version already ahead of a draft fixes the earliest instant it can take effect.
  const scheduled = await reader.execute<{ kind: string; code: string | null; version: number; effective_from: string }>(sql`
    select 'plan' as kind, p.code, v.version, ${iso(sql`v.effective_from`)} as effective_from
      from ${economyPlanVersions} v join ${economyPlans} p on p.id = v.plan_id
     where v.status = 'published' and v.effective_from > clock_timestamp()
    union all
    select 'pack', p.code, v.version, ${iso(sql`v.effective_from`)}
      from ${economyPackVersions} v join ${economyPacks} p on p.id = v.pack_id
     where v.status = 'published' and v.effective_from > clock_timestamp()
    union all
    select 'ruleset', null, r.version, ${iso(sql`r.effective_from`)}
      from ${economyRulesets} r
     where r.status = 'published' and r.effective_from > clock_timestamp()`);
  for (const s of scheduled.rows) {
    const affected =
      s.kind === 'ruleset' ? !!drafts.ruleset : (s.kind === 'plan' ? drafts.plans : drafts.packs).some((d) => d.code === s.code);
    if (affected) {
      warnings.push(`${s.kind === 'ruleset' ? 'Ruleset' : `${s.kind === 'plan' ? 'Plan' : 'Pack'} ${s.code}`} v${s.version} is scheduled for ${s.effective_from}: its draft can only take effect after that.`);
    }
  }

  return { asOf: asOf.iso, diff, errors, warnings };
}

/** What publishing now would change, and whether it may. Read-only. */
export async function reviewPublish(db: Reader): Promise<EconomyPublishReview> {
  const drafts = await loadDraftSet(db, false);
  return { ...(await assess(db, drafts)), draftSetToken: draftSetToken(drafts) };
}

/* ------------------------------------------------------------------ *
 * Publish and cancel
 * ------------------------------------------------------------------ */

const snapshotOfLive = {
  plan: async (reader: Reader, code: string) => {
    const live = await resolvePlanVersion(reader, code, await economyNow(reader));
    return live.ok ? { version: live.value.ref.version, ...planFields(live.value) } : null;
  },
  pack: async (reader: Reader, code: string) => {
    const live = await resolvePackVersion(reader, code, await economyNow(reader));
    return live.ok ? { version: live.value.ref.version, ...packFields(live.value) } : null;
  },
  ruleset: async (reader: Reader) => {
    const live = await resolveRuleset(reader, await economyNow(reader));
    return live.ok
      ? {
          version: live.value.ref.version,
          ...rulesetFields({ actionCosts: [...live.value.actionCosts], allowances: Object.fromEntries(live.value.allowances), rewards: [...live.value.rewards] }),
        }
      : null;
  },
};

/**
 * Publishes EVERY open draft together: one transaction, one effective instant
 * (`null` = now; otherwise a future instant), one reason. Refused when a draft
 * changed after the review that produced `draftSetToken`, or when the result
 * would be incomplete or invalid. The P1.1 triggers stamp the publication and
 * enforce linear version order; their refusals come back as conflicts.
 */
export async function publishDrafts(
  db: Db,
  input: { reason: string; effectiveFrom: string | null; draftSetToken: string },
  ctx: EconomyChangeContext,
): Promise<EconomyPublishResult> {
  const reason = requireReason(input.reason);
  let effectiveFrom: string | null = null;
  if (input.effectiveFrom !== null) {
    if (Number.isNaN(Date.parse(input.effectiveFrom))) invalid(['effectiveFrom must be an ISO 8601 instant, or null to publish now.']);
    effectiveFrom = new Date(input.effectiveFrom).toISOString();
  }
  return lifecycle(() =>
    db.transaction(async (tx) => {
      const drafts = await loadDraftSet(tx, true);
      if (draftSetToken(drafts) !== input.draftSetToken) {
        throw new EconomyAdminError('drafts_changed', 'The drafts changed after they were reviewed. Review them again before publishing.');
      }
      if (effectiveFrom !== null) {
        const [{ future }] = (await tx.execute<{ future: boolean }>(sql`select ${effectiveFrom}::timestamptz > clock_timestamp() as future`)).rows as [{ future: boolean }];
        if (!future) invalid(['effectiveFrom must be in the future; send null to publish now.']);
      }
      const assessment = await assess(tx, drafts);
      if (assessment.errors.length > 0) {
        throw new EconomyAdminError('not_publishable', assessment.errors[0]!, assessment.errors);
      }

      const published: EconomyPublishResult['published'] = [];
      const publication = { status: 'published' as const, effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null, publishedBy: ctx.actor.userId, publishReason: reason };
      const audit = (kind: EconomyKind, objectId: string, before: unknown, after: unknown, id: string, version: number, effective: string) =>
        recordAudit(tx, {
          actor: ctx.actor,
          action: `economy.${kind}.publish`,
          objectType: `economy_${kind}`,
          objectId,
          before,
          after,
          reason,
          requestId: ctx.requestId ?? null,
          metadata: { versionId: id, version, effectiveFrom: effective, draftSetToken: input.draftSetToken },
        });

      if (drafts.ruleset) {
        const d = drafts.ruleset;
        const before = await snapshotOfLive.ruleset(tx);
        const [row] = await tx.update(economyRulesets).set(publication).where(eq(economyRulesets.id, d.id)).returning({ effectiveFrom: iso(economyRulesets.effectiveFrom) });
        await audit('ruleset', String(d.version), before, { version: d.version, ...d.fields }, d.id, d.version, row!.effectiveFrom);
        published.push({ kind: 'ruleset', code: null, id: d.id, version: d.version, effectiveFrom: row!.effectiveFrom });
      }
      for (const d of drafts.plans) {
        const before = await snapshotOfLive.plan(tx, d.code);
        const [row] = await tx.update(economyPlanVersions).set(publication).where(eq(economyPlanVersions.id, d.id)).returning({ effectiveFrom: iso(economyPlanVersions.effectiveFrom) });
        await audit('plan', d.code, before, { version: d.version, ...d.fields }, d.id, d.version, row!.effectiveFrom);
        published.push({ kind: 'plan', code: d.code, id: d.id, version: d.version, effectiveFrom: row!.effectiveFrom });
      }
      for (const d of drafts.packs) {
        const before = await snapshotOfLive.pack(tx, d.code);
        const [row] = await tx.update(economyPackVersions).set(publication).where(eq(economyPackVersions.id, d.id)).returning({ effectiveFrom: iso(economyPackVersions.effectiveFrom) });
        await audit('pack', d.code, before, { version: d.version, ...d.fields }, d.id, d.version, row!.effectiveFrom);
        published.push({ kind: 'pack', code: d.code, id: d.id, version: d.version, effectiveFrom: row!.effectiveFrom });
      }
      return { published };
    }),
  );
}

/**
 * Cancels a published version that has not yet taken effect. The 0029 trigger
 * refuses anything already effective, or due within its one-minute margin.
 */
export async function cancelScheduledVersion(
  db: Db,
  kind: EconomyKind,
  versionId: string,
  input: { reason: string },
  ctx: EconomyChangeContext,
): Promise<void> {
  const reason = requireReason(input.reason);
  if (!UUID.test(versionId)) throw new EconomyAdminError('not_found', 'Version not found.');
  await lifecycle(() =>
    db.transaction(async (tx) => {
      const cancellation = { status: 'cancelled' as const, cancelledBy: ctx.actor.userId, cancelReason: reason };
      let before: AdminPlanVersion | AdminPackVersion | AdminRulesetVersion | null;
      let objectId: string;
      if (kind === 'plan') {
        const [row] = await tx.select({ code: economyPlans.code }).from(economyPlanVersions).innerJoin(economyPlans, eq(economyPlans.id, economyPlanVersions.planId)).where(eq(economyPlanVersions.id, versionId)).for('update', { of: economyPlanVersions });
        before = row ? await readPlanVersion(tx, versionId) : null;
        objectId = row?.code ?? '';
      } else if (kind === 'pack') {
        const [row] = await tx.select({ code: economyPacks.code }).from(economyPackVersions).innerJoin(economyPacks, eq(economyPacks.id, economyPackVersions.packId)).where(eq(economyPackVersions.id, versionId)).for('update', { of: economyPackVersions });
        before = row ? await readPackVersion(tx, versionId) : null;
        objectId = row?.code ?? '';
      } else {
        await tx.select({ id: economyRulesets.id }).from(economyRulesets).where(eq(economyRulesets.id, versionId)).for('update');
        before = await readRulesetVersion(tx, versionId);
        objectId = before ? String(before.version) : '';
      }
      if (!before) throw new EconomyAdminError('not_found', 'Version not found.');
      if (before.state !== 'scheduled') {
        throw new EconomyAdminError('economy_conflict', `Only a scheduled version can be cancelled; this one is ${before.state}.`);
      }
      if (kind === 'plan') await tx.update(economyPlanVersions).set(cancellation).where(eq(economyPlanVersions.id, versionId));
      else if (kind === 'pack') await tx.update(economyPackVersions).set(cancellation).where(eq(economyPackVersions.id, versionId));
      else await tx.update(economyRulesets).set(cancellation).where(eq(economyRulesets.id, versionId));
      const after =
        kind === 'plan' ? await readPlanVersion(tx, versionId) : kind === 'pack' ? await readPackVersion(tx, versionId) : await readRulesetVersion(tx, versionId);
      await recordAudit(tx, {
        actor: ctx.actor,
        action: `economy.${kind}.cancel`,
        objectType: `economy_${kind}`,
        objectId,
        before,
        after,
        reason,
        requestId: ctx.requestId ?? null,
        metadata: { versionId },
      });
    }),
  );
}
