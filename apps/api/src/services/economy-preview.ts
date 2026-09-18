import type { Db } from '../db/client.js';
import {
  economyNow,
  loadEconomyDrafts,
  resolvePackCatalog,
  resolvePlanCatalog,
  resolveRuleset,
  type ActionCostView,
  type Draft,
  type EconomyInstant,
  type PackVersionView,
  type PlanVersionView,
  type RulesetSnapshot,
} from './economy-resolver.js';

/**
 * P1.3 -- THE ECONOMY PREVIEW AND MARGIN GUARD (PRD v1.2 §31, §8.1, Appendix B).
 *
 * A read-only calculation an admin runs BEFORE publishing: given the economy
 * as drafted, what does the monthly grant buy, what does each action cost in
 * cash at every pack rung, and -- where provider costs are supplied -- what
 * gross margin does each action carry. It writes nothing, publishes nothing,
 * and touches no wallet, payment or entitlement.
 *
 * ── SAME SEMANTICS AS RUNTIME ────────────────────────────────────────────────
 *
 * The live configuration comes from the P1.2 resolver itself, at the database
 * clock's "now"; drafts come from `loadEconomyDrafts`, through the resolver's
 * own column projections and mappers. A draft REPLACES the live version of the
 * same plan or pack, and a draft ruleset replaces the live ruleset whole --
 * exactly what publishing them would do. Nothing here restates a resolution
 * rule, so preview and runtime cannot drift.
 *
 * ── NOTHING INVENTED ─────────────────────────────────────────────────────────
 *
 * Provider costs and the margin threshold are INPUTS to the preview, never
 * constants here. P1.D2 has not yet decided which provider costs exist, their
 * sources, units or staleness rule, so nothing is stored either: a persistent
 * store belongs with that decision. A missing cost produces an explicit
 * "missing" entry, never a zero; no threshold means the guard says it is not
 * configured, never that everything passed.
 *
 * ── NO FALSE PRECISION ───────────────────────────────────────────────────────
 *
 * Every figure is computed exactly, in integers (money in millionths of the
 * currency unit), and rounded ONCE for display, to the precision Appendix B
 * itself uses. The guard compares the exact values, so rounding can never hide
 * a breach or invent one.
 */

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export type PreviewMode = 'drafted' | 'live';

export interface ProviderCostInput {
  actionType: string;
  qualityTier: string;
  /** Matches the action cost row's duration tier; null for untiered actions. */
  maxDurationSeconds: number | null;
  /** Must match the action cost row's unit, or the two cannot be compared. */
  unit: 'per_action' | 'per_minute';
  /** Millionths of the currency unit: US$0.04 is 40000. */
  amountMicros: number;
  currency: string;
  /** When this cost was observed (an invoice date, a price-list date). */
  observedAt: string | null;
  /** Who or what the figure comes from. Echoed back, never interpreted. */
  source: string | null;
}

export interface MarginGuardInput {
  /** The configured floor. Absent means the guard is not configured. */
  minGrossMarginPercent: number | null;
  /** Absent means staleness is not evaluated -- ages are still reported. */
  maxCostAgeDays: number | null;
}

export interface PreviewInputs {
  mode: PreviewMode;
  providerCosts: ProviderCostInput[];
  marginGuard: MarginGuardInput;
}

const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_PROVIDER_COSTS = 200;

export type ParsedInputs = { ok: true; value: PreviewInputs } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a request body. Every problem is reported, not just the first. */
export function parsePreviewInputs(body: unknown): ParsedInputs {
  const errors: string[] = [];
  const input = body === undefined || body === null ? {} : body;
  if (!isRecord(input)) return { ok: false, errors: ['The body must be a JSON object.'] };

  const mode = input.mode ?? 'drafted';
  if (mode !== 'drafted' && mode !== 'live') errors.push('mode must be "drafted" or "live".');

  const rawCosts = input.providerCosts ?? [];
  const providerCosts: ProviderCostInput[] = [];
  if (!Array.isArray(rawCosts)) {
    errors.push('providerCosts must be an array.');
  } else if (rawCosts.length > MAX_PROVIDER_COSTS) {
    errors.push(`providerCosts may hold at most ${MAX_PROVIDER_COSTS} entries.`);
  } else {
    const seen = new Set<string>();
    rawCosts.forEach((raw, i) => {
      const at = `providerCosts[${i}]`;
      if (!isRecord(raw)) return void errors.push(`${at} must be an object.`);
      const { actionType, qualityTier, unit, amountMicros, currency } = raw;
      const maxDurationSeconds = raw.maxDurationSeconds ?? null;
      const observedAt = raw.observedAt ?? null;
      const source = raw.source ?? null;
      const before = errors.length;
      if (typeof actionType !== 'string' || !KEY.test(actionType)) errors.push(`${at}.actionType is not a valid action key.`);
      if (typeof qualityTier !== 'string' || !KEY.test(qualityTier)) errors.push(`${at}.qualityTier is not a valid tier key.`);
      if (maxDurationSeconds !== null && !(Number.isSafeInteger(maxDurationSeconds) && (maxDurationSeconds as number) > 0)) {
        errors.push(`${at}.maxDurationSeconds must be a positive whole number of seconds, or null.`);
      }
      if (unit !== 'per_action' && unit !== 'per_minute') errors.push(`${at}.unit must be "per_action" or "per_minute".`);
      // Strictly positive: a missing cost is expressed by omitting it, never by
      // a zero that would make an action look free to serve.
      if (!(Number.isSafeInteger(amountMicros) && (amountMicros as number) > 0)) {
        errors.push(`${at}.amountMicros must be a positive whole number (millionths of the currency unit).`);
      }
      if (typeof currency !== 'string' || !CURRENCY.test(currency)) errors.push(`${at}.currency must be a 3-letter code.`);
      if (observedAt !== null && (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt)))) {
        errors.push(`${at}.observedAt must be an ISO 8601 date, or null.`);
      }
      if (source !== null && (typeof source !== 'string' || source.length > 200)) {
        errors.push(`${at}.source must be text of at most 200 characters, or null.`);
      }
      if (errors.length > before) return;
      const key = actionKey(actionType as string, qualityTier as string, maxDurationSeconds as number | null);
      if (seen.has(key)) return void errors.push(`${at} repeats the cost for ${key}.`);
      seen.add(key);
      providerCosts.push({
        actionType: actionType as string,
        qualityTier: qualityTier as string,
        maxDurationSeconds: maxDurationSeconds as number | null,
        unit: unit as ProviderCostInput['unit'],
        amountMicros: amountMicros as number,
        currency: currency as string,
        observedAt: observedAt as string | null,
        source: source as string | null,
      });
    });
  }

  const rawGuard = input.marginGuard ?? {};
  let marginGuard: MarginGuardInput = { minGrossMarginPercent: null, maxCostAgeDays: null };
  if (!isRecord(rawGuard)) {
    errors.push('marginGuard must be an object.');
  } else {
    const min = rawGuard.minGrossMarginPercent ?? null;
    const age = rawGuard.maxCostAgeDays ?? null;
    if (min !== null && !(typeof min === 'number' && min >= 0 && min < 100 && isHundredths(min))) {
      errors.push('marginGuard.minGrossMarginPercent must be at least 0 and below 100, to at most two decimal places.');
    }
    if (age !== null && !(Number.isSafeInteger(age) && (age as number) >= 1 && (age as number) <= 3650)) {
      errors.push('marginGuard.maxCostAgeDays must be a whole number of days from 1 to 3650.');
    }
    marginGuard = { minGrossMarginPercent: min as number | null, maxCostAgeDays: age as number | null };
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { mode: mode as PreviewMode, providerCosts, marginGuard } };
}

function isHundredths(n: number): boolean {
  return Number.isFinite(n) && Math.abs(Math.round(n * 100) - n * 100) < 1e-9;
}

/* ------------------------------------------------------------------ *
 * Exact arithmetic, rounded once
 * ------------------------------------------------------------------ */

const MICROS_PER_MINOR = 10_000n; // two-decimal currencies: 1 minor unit = 10^4 micros
const MICROS_PER_MAJOR = 1_000_000n;

/** num/den rounded half away from zero to `digits` decimals, as a string. */
function decimal(num: bigint, den: bigint, digits: number): string {
  const negative = num < 0n !== den < 0n && num !== 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const scale = 10n ** BigInt(digits);
  let q = (n * scale) / d;
  if ((n * scale) % d * 2n >= d) q += 1n;
  const whole = (q / scale).toString();
  const frac = digits > 0 ? '.' + (q % scale).toString().padStart(digits, '0') : '';
  return (negative && q !== 0n ? '-' : '') + whole + frac;
}

/**
 * num/den rounded DOWN (toward minus infinity) to `digits` decimals; den > 0.
 *
 * Used for one figure only: the margin quoted in a guard warning. Rounding
 * half-up there could display a margin that breached a 60% floor as "60.00",
 * which reads as a contradiction. Rounded down, a warning can never show a
 * value at or above the floor it breached.
 */
function decimalFloor(num: bigint, den: bigint, digits: number): string {
  const scale = 10n ** BigInt(digits);
  const scaled = num * scale;
  let q = scaled / den; // BigInt division truncates toward zero
  if (scaled % den !== 0n && scaled < 0n) q -= 1n;
  const negative = q < 0n;
  const abs = negative ? -q : q;
  const frac = digits > 0 ? '.' + (abs % scale).toString().padStart(digits, '0') : '';
  return (negative ? '-' : '') + (abs / scale).toString() + frac;
}

export interface Money {
  amount: string;
  currency: string;
}

const money = (micros: { num: bigint; den: bigint }, currency: string, digits = 2): Money => ({
  amount: decimal(micros.num, micros.den * MICROS_PER_MAJOR, digits),
  currency,
});

/* ------------------------------------------------------------------ *
 * Composition: the economy as drafted, through the resolver
 * ------------------------------------------------------------------ */

export type Source = 'live' | 'draft';
type Sourced<V> = { view: V; source: Source };
type PlanView = PlanVersionView | Draft<PlanVersionView>;
type PackView = PackVersionView | Draft<PackVersionView>;
type RulesetView = RulesetSnapshot | Draft<RulesetSnapshot>;

export interface ComposedEconomy {
  asOf: EconomyInstant;
  mode: PreviewMode;
  plans: Sourced<PlanView>[];
  packs: Sourced<PackView>[];
  ruleset: Sourced<RulesetView> | null;
}

/**
 * The economy a preview describes. `live` is exactly what the resolver serves
 * now; `drafted` overlays every open draft, as publishing them would.
 */
export async function composeEconomy(
  db: Parameters<typeof resolvePlanCatalog>[0],
  mode: PreviewMode,
): Promise<ComposedEconomy> {
  const asOf = await economyNow(db);
  const [{ plans }, { packs }, ruleset] = await Promise.all([
    resolvePlanCatalog(db, asOf),
    resolvePackCatalog(db, asOf),
    resolveRuleset(db, asOf),
  ]);

  const planById = new Map<string, Sourced<PlanView>>(plans.map((p) => [p.planId, { view: p, source: 'live' }]));
  const packById = new Map<string, Sourced<PackView>>(packs.map((p) => [p.packId, { view: p, source: 'live' }]));
  let rules: Sourced<RulesetView> | null = ruleset.ok ? { view: ruleset.value, source: 'live' } : null;

  if (mode === 'drafted') {
    const drafts = await loadEconomyDrafts(db);
    for (const p of drafts.plans) planById.set(p.planId, { view: p, source: 'draft' });
    for (const p of drafts.packs) packById.set(p.packId, { view: p, source: 'draft' });
    if (drafts.ruleset) rules = { view: drafts.ruleset, source: 'draft' };
  }

  return {
    asOf,
    mode,
    plans: [...planById.values()].sort((a, b) => a.view.ref.code.localeCompare(b.view.ref.code)),
    // The resolver's own ladder order: sort_order, then code.
    packs: [...packById.values()].sort(
      (a, b) => a.view.sortOrder - b.view.sortOrder || a.view.ref.code.localeCompare(b.view.ref.code),
    ),
    ruleset: rules,
  };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export function actionKey(actionType: string, qualityTier: string, maxDurationSeconds: number | null): string {
  return `${actionType}/${qualityTier}/${maxDurationSeconds === null ? 'any' : `${maxDurationSeconds}s`}`;
}
const keyOf = (c: ActionCostView) => actionKey(c.actionType, c.qualityTier, c.maxDurationSeconds);

export interface EconomyPreview {
  asOf: string;
  mode: PreviewMode;
  configuration: {
    plans: Array<{ code: string; version: number; source: Source; isPurchasable: boolean }>;
    packs: Array<{ code: string; version: number; source: Source; isPurchasable: boolean }>;
    ruleset: { version: number; source: Source } | null;
  };
  /** §31 / B.3: per-Credit rate at each rung, per currency, and its shape. */
  ladders: Array<{
    currency: string;
    rungs: Array<{ code: string; credits: number; price: Money; perCredit: Money; isBestValue: boolean }>;
    /** How much cheaper a Credit is at the lowest rate than at the entry rung. */
    spreadPercent: string | null;
    issues: Array<{ kind: 'inverted' | 'flat'; rung: string; previous: string }>;
  }>;
  /** §31 / B.1: what each plan's monthly grant buys. */
  grants: Array<{
    plan: string;
    version: number;
    source: Source;
    monthlyCredits: number;
    buys: Array<{ action: string; unit: ActionCostView['unit']; creditCost: number; quantity: number }>;
    /** §8.1 / B.4: provider cost if the whole grant goes on the dearest-to-serve action. */
    worstCaseProviderCost:
      | { status: 'complete'; action: string; cost: Money }
      | { status: 'incomplete'; knownWorst: { action: string; cost: Money } | null; missingCosts: string[] }
      | { status: 'no_actions' };
  }>;
  /** B.2 / B.4: each enabled action, priced at every rung, with margins where costs are known. */
  actions: Array<{
    action: string;
    actionType: string;
    qualityTier: string;
    maxDurationSeconds: number | null;
    unit: ActionCostView['unit'];
    creditCost: number;
    cashPrice: Array<{ pack: string; price: Money }>;
    providerCost: (Money & { observedAt: string | null; ageDays: number | null; source: string | null }) | null;
    margins: Array<{ pack: string; grossMarginPercent: string; costMultiple: string }>;
    /** Provider cost per Credit: the §8.1 parity quantity. Lower is safer. */
    providerCostPerCredit: Money | null;
    guard: 'ok' | 'below_threshold' | 'not_evaluated';
  }>;
  disabledActions: string[];
  inputs: {
    missingProviderCosts: string[];
    unmatchedProviderCosts: string[];
    unitMismatches: string[];
    currencyMismatches: string[];
    undatedProviderCosts: string[];
    staleProviderCosts: Array<{ action: string; ageDays: number }>;
    futureDatedProviderCosts: string[];
  };
  marginGuard: {
    status: 'not_configured' | 'evaluated';
    minGrossMarginPercent: number | null;
    maxCostAgeDays: number | null;
    /** `grossMarginPercent` here is to two decimals, rounded DOWN (see `decimalFloor`). */
    warnings: Array<{ action: string; pack: string; grossMarginPercent: string }>;
    notEvaluated: Array<{ action: string; reason: string }>;
  };
  /** §8.1 margin parity, as information: the guard does not quantify "materially". */
  parity: { thinnestAction: string; highestCostPerCredit: Money; lowestCostPerCredit: Money } | null;
  caveats: string[];
  precision: { price: 2; perCredit: 3; providerCostPerCredit: 4; percent: 0; costMultiple: 1 };
}

const DAY_MS = 86_400_000;

/** The report for a composed economy. Pure: no queries, no clock of its own. */
export function computeEconomics(economy: ComposedEconomy, inputs: PreviewInputs): EconomyPreview {
  const rules = economy.ruleset?.view ?? null;
  const all = rules ? [...rules.actionCosts] : [];
  const enabled = all.filter((c) => c.enabled);
  const purchasablePacks = economy.packs.filter((p) => p.view.isPurchasable);
  const thresholdBps =
    inputs.marginGuard.minGrossMarginPercent === null
      ? null
      : BigInt(Math.round(inputs.marginGuard.minGrossMarginPercent * 100));
  const asOfMs = Date.parse(economy.asOf.iso);

  /* ---- ladders (B.3) ---- */
  const currencies = [...new Set(purchasablePacks.map((p) => p.view.currency))].sort();
  const ladders = currencies.map((currency) => {
    const rungs = purchasablePacks.filter((p) => p.view.currency === currency).map((p) => p.view);
    const issues: EconomyPreview['ladders'][number]['issues'] = [];
    for (let i = 1; i < rungs.length; i += 1) {
      // Compare p_i/k_i with p_{i-1}/k_{i-1} exactly, by cross-multiplication.
      const here = BigInt(rungs[i]!.priceMinor) * BigInt(rungs[i - 1]!.credits);
      const before = BigInt(rungs[i - 1]!.priceMinor) * BigInt(rungs[i]!.credits);
      if (here > before) issues.push({ kind: 'inverted', rung: rungs[i]!.ref.code, previous: rungs[i - 1]!.ref.code });
      else if (here === before) issues.push({ kind: 'flat', rung: rungs[i]!.ref.code, previous: rungs[i - 1]!.ref.code });
    }
    const entry = rungs[0];
    const lowest = rungs.reduce<PackView | undefined>(
      (best, r) =>
        !best || BigInt(r.priceMinor) * BigInt(best.credits) < BigInt(best.priceMinor) * BigInt(r.credits) ? r : best,
      undefined,
    );
    const spreadPercent =
      entry && lowest && rungs.length > 1
        ? decimal(
            (BigInt(lowest.credits) * BigInt(entry.priceMinor) - BigInt(lowest.priceMinor) * BigInt(entry.credits)) * 100n,
            BigInt(lowest.credits) * BigInt(entry.priceMinor),
            0,
          )
        : null;
    return {
      currency,
      rungs: rungs.map((r) => ({
        code: r.ref.code,
        credits: r.credits,
        price: money({ num: BigInt(r.priceMinor) * MICROS_PER_MINOR, den: 1n }, currency),
        perCredit: money({ num: BigInt(r.priceMinor) * MICROS_PER_MINOR, den: BigInt(r.credits) }, currency, 3),
        isBestValue: r.isBestValue,
      })),
      spreadPercent,
      issues,
    };
  });

  /* ---- provider costs: match, and check every input ---- */
  const byKey = new Map(all.map((c) => [keyOf(c), c]));
  const inputsReport: EconomyPreview['inputs'] = {
    missingProviderCosts: [],
    unmatchedProviderCosts: [],
    unitMismatches: [],
    currencyMismatches: [],
    undatedProviderCosts: [],
    staleProviderCosts: [],
    futureDatedProviderCosts: [],
  };
  const usableCost = new Map<string, ProviderCostInput & { ageDays: number | null }>();
  for (const cost of inputs.providerCosts) {
    const key = actionKey(cost.actionType, cost.qualityTier, cost.maxDurationSeconds);
    const row = byKey.get(key);
    if (!row) {
      inputsReport.unmatchedProviderCosts.push(key);
      continue;
    }
    if (row.unit !== cost.unit) {
      inputsReport.unitMismatches.push(`${key}: action is ${row.unit}, cost is ${cost.unit}`);
      continue;
    }
    let ageDays: number | null = null;
    if (cost.observedAt === null) {
      inputsReport.undatedProviderCosts.push(key);
    } else {
      const observed = Date.parse(cost.observedAt);
      if (observed > asOfMs) {
        inputsReport.futureDatedProviderCosts.push(key);
      } else {
        ageDays = Math.floor((asOfMs - observed) / DAY_MS);
        const max = inputs.marginGuard.maxCostAgeDays;
        if (max !== null && ageDays > max) inputsReport.staleProviderCosts.push({ action: key, ageDays });
      }
    }
    usableCost.set(key, { ...cost, ageDays });
  }
  for (const c of enabled) if (!usableCost.has(keyOf(c))) inputsReport.missingProviderCosts.push(keyOf(c));

  /* ---- actions: cash prices (B.2), margins (B.4), guard ---- */
  const guardWarnings: EconomyPreview['marginGuard']['warnings'] = [];
  const guardNotEvaluated: EconomyPreview['marginGuard']['notEvaluated'] = [];
  const perCreditCosts: Array<{ action: string; num: bigint; den: bigint; currency: string }> = [];

  const actions: EconomyPreview['actions'] = enabled.map((c) => {
    const key = keyOf(c);
    const cost = usableCost.get(key) ?? null;
    const cashPrice = purchasablePacks.map((p) => ({
      pack: p.view.ref.code,
      // credit_cost x (price / credits), in micros: a / b.
      price: money(
        { num: BigInt(c.creditCost) * BigInt(p.view.priceMinor) * MICROS_PER_MINOR, den: BigInt(p.view.credits) },
        p.view.currency,
      ),
    }));

    const margins: EconomyPreview['actions'][number]['margins'] = [];
    let worst: { pack: string; num: bigint; den: bigint } | null = null;
    if (cost) {
      const sameCurrency = purchasablePacks.filter((p) => p.view.currency === cost.currency);
      if (purchasablePacks.length > 0 && sameCurrency.length === 0) {
        inputsReport.currencyMismatches.push(`${key}: cost in ${cost.currency}, no purchasable pack in ${cost.currency}`);
      }
      for (const p of sameCurrency) {
        const a = BigInt(c.creditCost) * BigInt(p.view.priceMinor) * MICROS_PER_MINOR; // retail = a / b
        const b = BigInt(p.view.credits);
        const costMicros = BigInt(cost.amountMicros);
        // gross margin = (a - cost*b) / a ; cost multiple = a / (b*cost)
        const marginNum = a - costMicros * b;
        margins.push({
          pack: p.view.ref.code,
          grossMarginPercent: decimal(marginNum * 100n, a, 0),
          costMultiple: decimal(a, b * costMicros, 1),
        });
        if (!worst || marginNum * worst.den < worst.num * a) worst = { pack: p.view.ref.code, num: marginNum, den: a };
      }
      perCreditCosts.push({ action: key, num: BigInt(cost.amountMicros), den: BigInt(c.creditCost), currency: cost.currency });
    }

    let guard: EconomyPreview['actions'][number]['guard'] = 'not_evaluated';
    if (thresholdBps === null) {
      // Reported once, at the guard level.
    } else if (!cost) {
      guardNotEvaluated.push({ action: key, reason: 'missing_provider_cost' });
    } else if (!worst) {
      guardNotEvaluated.push({
        action: key,
        reason: purchasablePacks.length === 0 ? 'no_purchasable_packs' : 'currency_mismatch',
      });
    } else if (worst.num * 10_000n < thresholdBps * worst.den) {
      // Exact comparison: margin < threshold  <=>  num/den < bps/10000.
      guard = 'below_threshold';
      // Two decimals, rounded down: the precision the threshold is set in, and
      // never a figure that appears to meet the floor it breached.
      guardWarnings.push({ action: key, pack: worst.pack, grossMarginPercent: decimalFloor(worst.num * 100n, worst.den, 2) });
    } else {
      guard = 'ok';
    }

    return {
      action: key,
      actionType: c.actionType,
      qualityTier: c.qualityTier,
      maxDurationSeconds: c.maxDurationSeconds,
      unit: c.unit,
      creditCost: c.creditCost,
      cashPrice,
      providerCost: cost
        ? {
            ...money({ num: BigInt(cost.amountMicros), den: 1n }, cost.currency, 4),
            observedAt: cost.observedAt,
            ageDays: cost.ageDays,
            source: cost.source,
          }
        : null,
      margins,
      providerCostPerCredit: cost
        ? money({ num: BigInt(cost.amountMicros), den: BigInt(c.creditCost) }, cost.currency, 4)
        : null,
      guard,
    };
  });

  /* ---- grants (B.1) and worst-case exposure (§8.1, B.4) ---- */
  const grants: EconomyPreview['grants'] = economy.plans.map(({ view: plan, source }) => {
    const buys = enabled.map((c) => ({
      action: keyOf(c),
      unit: c.unit,
      creditCost: c.creditCost,
      quantity: Math.floor(plan.monthlyIncludedCredits / c.creditCost),
    }));
    let knownWorst: { action: string; micros: bigint; currency: string } | null = null;
    const missingCosts: string[] = [];
    for (const buy of buys) {
      const cost = usableCost.get(buy.action);
      if (!cost) {
        missingCosts.push(buy.action);
        continue;
      }
      const micros = BigInt(buy.quantity) * BigInt(cost.amountMicros);
      if (!knownWorst || micros > knownWorst.micros) knownWorst = { action: buy.action, micros, currency: cost.currency };
    }
    const asMoney = (w: { action: string; micros: bigint; currency: string }) => ({
      action: w.action,
      cost: money({ num: w.micros, den: 1n }, w.currency),
    });
    return {
      plan: plan.ref.code,
      version: plan.ref.version,
      source,
      monthlyCredits: plan.monthlyIncludedCredits,
      buys,
      worstCaseProviderCost:
        buys.length === 0
          ? { status: 'no_actions' as const }
          : missingCosts.length === 0 && knownWorst
            ? { status: 'complete' as const, ...asMoney(knownWorst) }
            : { status: 'incomplete' as const, knownWorst: knownWorst ? asMoney(knownWorst) : null, missingCosts },
    };
  });

  /* ---- parity, as information ---- */
  let parity: EconomyPreview['parity'] = null;
  const parityCurrencies = new Set(perCreditCosts.map((p) => p.currency));
  if (perCreditCosts.length >= 2 && parityCurrencies.size === 1) {
    const cmp = (x: (typeof perCreditCosts)[number], y: (typeof perCreditCosts)[number]) =>
      x.num * y.den < y.num * x.den ? -1 : x.num * y.den > y.num * x.den ? 1 : 0;
    const sorted = [...perCreditCosts].sort(cmp);
    const high = sorted[sorted.length - 1]!;
    const low = sorted[0]!;
    parity = {
      thinnestAction: high.action,
      highestCostPerCredit: money({ num: high.num, den: high.den }, high.currency, 4),
      lowestCostPerCredit: money({ num: low.num, den: low.den }, low.currency, 4),
    };
  }

  /* ---- what the reader must know ---- */
  const caveats = [
    'Margins are gross: payment-processor fees, rolling reserves, refunds and taxes are not included (PRD §6, Appendix B.4).',
    'Cash prices and margins use pack rates only; subscription-grant Credits are not priced as a rung (Appendix B does the same).',
    'Amounts assume two-decimal currencies. Currencies are never converted: a cost is compared only with packs in its own currency.',
    'Provider costs and the margin threshold are the inputs supplied with this preview. Nothing is stored or published.',
  ];
  if (thresholdBps === null) caveats.push('No margin threshold is configured, so the guard cannot warn.');
  if (!rules) caveats.push('No ruleset is live or drafted, so no action can be priced.');
  if (purchasablePacks.length === 0) caveats.push('No purchasable pack exists, so no cash price or margin can be shown.');

  return {
    asOf: economy.asOf.iso,
    mode: economy.mode,
    configuration: {
      plans: economy.plans.map(({ view, source }) => ({
        code: view.ref.code,
        version: view.ref.version,
        source,
        isPurchasable: view.isPurchasable,
      })),
      packs: economy.packs.map(({ view, source }) => ({
        code: view.ref.code,
        version: view.ref.version,
        source,
        isPurchasable: view.isPurchasable,
      })),
      ruleset: economy.ruleset ? { version: economy.ruleset.view.ref.version, source: economy.ruleset.source } : null,
    },
    ladders,
    grants,
    actions,
    disabledActions: all.filter((c) => !c.enabled).map(keyOf),
    inputs: inputsReport,
    marginGuard: {
      status: thresholdBps === null ? 'not_configured' : 'evaluated',
      minGrossMarginPercent: inputs.marginGuard.minGrossMarginPercent,
      maxCostAgeDays: inputs.marginGuard.maxCostAgeDays,
      warnings: guardWarnings,
      notEvaluated: guardNotEvaluated,
    },
    parity,
    caveats,
    precision: { price: 2, perCredit: 3, providerCostPerCredit: 4, percent: 0, costMultiple: 1 },
  };
}

/** Compose and compute. Read-only from end to end. */
export async function previewEconomy(db: Db, inputs: PreviewInputs): Promise<EconomyPreview> {
  return computeEconomics(await composeEconomy(db, inputs.mode), inputs);
}
