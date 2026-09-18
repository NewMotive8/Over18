import type { Db } from '../db/client.js';
import {
  actionCostFor,
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
 * cash at every pack rung, and -- where costs are supplied -- what margin does
 * each action and each subscription carry. It writes nothing, publishes
 * nothing, and touches no wallet, payment or entitlement.
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
 * ── FOUR THINGS KEPT APART ───────────────────────────────────────────────────
 *
 *   1. AI PROVIDER COST. What the model provider bills to serve an action, or
 *      a plan's included usage (a subscriber's unlimited text). A RATE CARD --
 *      a price per quantity of a meter, e.g. US$2.00 per 1M input tokens --
 *      times a USAGE PROFILE: how much of each meter one action uses. A
 *      provider's regional-endpoint premium is added when, and only when, that
 *      provider is declared to be on its regional endpoint.
 *   2. REVENUE DEDUCTIONS. What never reaches us from a sale: processor fees,
 *      store commission, refunds and chargebacks. Grouped by SALES CHANNEL,
 *      because channels are alternatives: a web sale pays the processor, an
 *      App Store sale pays Apple, and no sale pays both.
 *   3. OTHER COSTS. Measured infrastructure allocation, telephony, anything
 *      else -- per action, or per subscriber per month.
 *   4. GAPS. A figure that needs an input nobody supplied is not shown; the
 *      gap is named instead.
 *
 * Gross margin -- the §31 guard's basis, and Appendix B's -- deducts only (1).
 * Net margin deducts (1), (2) and (3), and exists only when all are complete.
 *
 * ── NOTHING INVENTED ─────────────────────────────────────────────────────────
 *
 * Rates, usage, deductions, other costs and thresholds are INPUTS to the
 * preview, never constants here, and nothing is stored. A missing input
 * produces a named gap, never a zero; no threshold means the guard says it is
 * not configured, never that everything passed. Speech-to-speech usage cannot
 * be combined with separate speech-to-text or text-to-speech meters: the
 * speech-to-speech price already covers recognition and synthesis.
 *
 * ── NO FALSE PRECISION ───────────────────────────────────────────────────────
 *
 * Every figure is computed exactly, as a ratio of integers (money in
 * millionths of the currency unit), and rounded ONCE for display. The guard
 * compares the exact values, so rounding can never hide a breach or invent
 * one.
 */

/* ------------------------------------------------------------------ *
 * Exact arithmetic, rounded once
 * ------------------------------------------------------------------ */

/** An exact rational. `den` is always positive. */
export interface Ratio {
  num: bigint;
  den: bigint;
}

const abs = (n: bigint) => (n < 0n ? -n : n);
function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [abs(a), abs(b)];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}
function ratio(num: bigint, den = 1n): Ratio {
  if (den < 0n) [num, den] = [-num, -den];
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g };
}
const ZERO = ratio(0n);
const add = (a: Ratio, b: Ratio) => ratio(a.num * b.den + b.num * a.den, a.den * b.den);
const sub = (a: Ratio, b: Ratio) => ratio(a.num * b.den - b.num * a.den, a.den * b.den);
const mul = (a: Ratio, b: Ratio) => ratio(a.num * b.num, a.den * b.den);
const div = (a: Ratio, b: Ratio) => ratio(a.num * b.den, a.den * b.num);
const cmp = (a: Ratio, b: Ratio) => {
  const d = a.num * b.den - b.num * a.den;
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};
const sum = (xs: Ratio[]) => xs.reduce(add, ZERO);

const MICROS_PER_MINOR = 10_000n; // two-decimal currencies: 1 minor unit = 10^4 micros
const MICROS_PER_MAJOR = 1_000_000n;

/** num/den rounded half away from zero to `digits` decimals, as a string. */
function decimal(num: bigint, den: bigint, digits: number): string {
  const negative = num < 0n !== den < 0n && num !== 0n;
  const n = abs(num);
  const d = abs(den);
  const scale = 10n ** BigInt(digits);
  let q = (n * scale) / d;
  if (((n * scale) % d) * 2n >= d) q += 1n;
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
  const a = negative ? -q : q;
  const frac = digits > 0 ? '.' + (a % scale).toString().padStart(digits, '0') : '';
  return (negative ? '-' : '') + (a / scale).toString() + frac;
}

/** An exact quantity, without trailing zeros (quantities are at most six decimals). */
const plain = (q: Ratio) => decimal(q.num, q.den, 6).replace(/\.?0+$/, '');
const percent0 = (m: Ratio) => decimal(m.num * 100n, m.den, 0);
const percentFloor2 = (m: Ratio) => decimalFloor(m.num * 100n, m.den, 2);

export interface Money {
  amount: string;
  currency: string;
}

/** An amount in micros, as a Money in major units. */
const money = (micros: Ratio, currency: string, digits = 2): Money => ({
  amount: decimal(micros.num, micros.den * MICROS_PER_MAJOR, digits),
  currency,
});
const micros = (n: number) => ratio(BigInt(n));

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export type PreviewMode = 'drafted' | 'live';

export const RATE_KINDS = [
  'text_generation',
  'speech_to_speech',
  'speech_to_text',
  'text_to_speech',
  'image_generation',
  'video_generation',
  'other',
] as const;
export type RateKind = (typeof RATE_KINDS)[number];

export const DEDUCTION_KINDS = [
  'payment_processor',
  'apple_app_store',
  'google_play',
  'refunds_chargebacks',
  'other',
] as const;
export type DeductionKind = (typeof DEDUCTION_KINDS)[number];

export const OTHER_COST_KINDS = ['infrastructure', 'telephony', 'other'] as const;
export type OtherCostKind = (typeof OTHER_COST_KINDS)[number];

/** Which endpoint a provider is used through. Required for every provider a usage names. */
export interface ProviderEndpointInput {
  provider: string;
  endpoint: 'global' | 'us_regional';
  /** The provider's documented premium, as a fraction, on its regional endpoint; null on global. */
  regionalPremium: Ratio | null;
}

/** One line of a provider's price list. */
export interface RateInput {
  provider: string;
  meter: string;
  kind: RateKind;
  /** What `perQuantity` units cost, in millionths: US$2.00 per 1M tokens is 2_000_000 per 1_000_000. */
  amountMicros: number;
  perQuantity: number;
  currency: string;
  observedAt: string | null;
  source: string | null;
}

export interface MeterUse {
  provider: string;
  meter: string;
  quantity: Ratio;
}

export interface ActionTarget {
  actionType: string;
  qualityTier: string;
  /** Matches the action cost row's duration tier; null for untiered actions. */
  maxDurationSeconds: number | null;
  /** Must match the action cost row's unit, or the two cannot be compared. */
  unit: 'per_action' | 'per_minute';
}

/** How much of each meter ONE action (or one minute of a per-minute action) uses. */
export interface ActionUsageInput extends ActionTarget {
  meters: MeterUse[];
  source: string | null;
}

/** A plan's included, non-Credit usage per subscriber per month (e.g. unlimited text). */
export interface PlanUsageInput {
  plan: string;
  /** May be empty: an explicit statement that the plan includes no metered usage. */
  meters: MeterUse[];
  source: string | null;
}

export interface DeductionInput {
  kind: DeductionKind;
  label: string | null;
  /** A fraction of the price (10.5% is 21/200); null when the deduction is fixed only. */
  percentOfPrice: Ratio | null;
  /** Per transaction -- per pack bought, per subscription payment. */
  fixedAmountMicros: number | null;
  /** The fixed amount's currency; null when there is none. */
  currency: string | null;
  observedAt: string | null;
  source: string | null;
}

export interface SalesChannelInput {
  channel: string;
  deductions: DeductionInput[];
}

/** Per action, or per minute of a per-minute action. */
export interface ActionOtherCostInput extends ActionTarget {
  kind: OtherCostKind;
  label: string | null;
  amountMicros: number;
  currency: string;
  observedAt: string | null;
  source: string | null;
}

/** Per subscriber per month. */
export interface PlanOtherCostInput {
  plan: string;
  kind: OtherCostKind;
  label: string | null;
  amountMicros: number;
  currency: string;
  observedAt: string | null;
  source: string | null;
}

export interface MarginGuardInput {
  /** The configured floor on gross margin (§31). Absent means not configured. */
  minGrossMarginPercent: number | null;
  /** The configured floor on net margin. Absent means not configured. */
  minNetMarginPercent: number | null;
  /** Absent means staleness is not evaluated -- ages are still reported. */
  maxCostAgeDays: number | null;
}

export interface PreviewInputs {
  mode: PreviewMode;
  providers: ProviderEndpointInput[];
  rates: RateInput[];
  usage: { actions: ActionUsageInput[]; plans: PlanUsageInput[] };
  salesChannels: SalesChannelInput[];
  otherCosts: { actions: ActionOtherCostInput[]; plans: PlanOtherCostInput[] };
  marginGuard: MarginGuardInput;
}

const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_ENTRIES = 200;
const MAX_METERS = 20;
const MAX_DEDUCTIONS = 20;
const MAX_QUANTITY = 1_000_000_000_000n;

export type ParsedInputs = { ok: true; value: PreviewInputs } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const rateKey = (provider: string, meter: string) => `${provider}/${meter}`;

/**
 * A non-negative number with at most `digits` decimals, scaled to an integer
 * by 10^digits -- read from its JSON spelling, so 0.1 is exactly 1/10. Null if
 * it is not one.
 */
function exactDecimal(v: unknown, digits: number): bigint | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v));
  if (!m || (m[2]?.length ?? 0) > digits) return null;
  return BigInt(m[1]! + (m[2] ?? '').padEnd(digits, '0'));
}

/** Field readers. Each records its own error and returns a placeholder on failure. */
function readers(errors: string[]) {
  const fail = <T>(message: string, placeholder: T): T => {
    errors.push(message);
    return placeholder;
  };
  const r = {
    key: (v: unknown, at: string, what: string) =>
      typeof v === 'string' && KEY.test(v) ? v : fail(`${at} is not a valid ${what}.`, ''),
    oneOf: <T extends string>(v: unknown, at: string, allowed: readonly T[]) =>
      allowed.includes(v as T) ? (v as T) : fail(`${at} must be one of ${allowed.join(', ')}.`, allowed[0]!),
    text: (v: unknown, at: string) =>
      v === undefined || v === null
        ? null
        : typeof v === 'string' && v.length <= 200
          ? v
          : fail(`${at} must be text of at most 200 characters, or null.`, null),
    date: (v: unknown, at: string) =>
      v === undefined || v === null
        ? null
        : typeof v === 'string' && !Number.isNaN(Date.parse(v))
          ? v
          : fail(`${at} must be an ISO 8601 date, or null.`, null),
    currency: (v: unknown, at: string) =>
      typeof v === 'string' && CURRENCY.test(v) ? v : fail(`${at} must be a 3-letter code.`, ''),
    micros: (v: unknown, at: string) =>
      Number.isSafeInteger(v) && (v as number) > 0
        ? (v as number)
        : fail(`${at} must be a positive whole number (millionths of the currency unit).`, 0),
    /** Above 0 and below (or up to) 100, to four decimals, as a fraction of 1. */
    percent: (v: unknown, at: string, upTo100: boolean) => {
      const s = exactDecimal(v, 4);
      const max = 100n * 10_000n;
      return s !== null && s > 0n && (upTo100 ? s <= max : s < max)
        ? ratio(s, max)
        : fail(`${at} must be above 0 and ${upTo100 ? 'at most' : 'below'} 100, to at most four decimal places.`, ZERO);
    },
    quantity: (v: unknown, at: string) => {
      const s = exactDecimal(v, 6);
      return s !== null && s > 0n && s <= MAX_QUANTITY * 1_000_000n
        ? ratio(s, 1_000_000n)
        : fail(`${at} must be above 0 and at most ${MAX_QUANTITY}, to at most six decimal places.`, ZERO);
    },
    /** A list of objects; each is read by `each`, and kept only if it raised no error. */
    list: <T>(
      raw: unknown,
      at: string,
      bounds: { min: number; max: number },
      each: (item: Record<string, unknown>, at: string) => T,
    ): T[] => {
      if (raw === undefined || raw === null) raw = [];
      if (!Array.isArray(raw) || raw.length < bounds.min || raw.length > bounds.max) {
        const count = bounds.min > 0 ? `${bounds.min} to ${bounds.max}` : `at most ${bounds.max}`;
        return fail(`${at} must be an array of ${count} entries.`, []);
      }
      const out: T[] = [];
      raw.forEach((item, i) => {
        const here = `${at}[${i}]`;
        if (!isRecord(item)) return void errors.push(`${here} must be an object.`);
        const before = errors.length;
        const value = each(item, here);
        if (errors.length === before) out.push(value);
      });
      return out;
    },
    /** Refuses the second entry with the same identity. */
    unique: (seen: Set<string>, id: string, at: string, what: string) => {
      if (seen.has(id)) errors.push(`${at} repeats the ${what} for ${id}.`);
      seen.add(id);
    },
  };
  return r;
}

/** Validates a request body. Every problem is reported, not just the first. */
export function parsePreviewInputs(body: unknown): ParsedInputs {
  const errors: string[] = [];
  const input = body === undefined || body === null ? {} : body;
  if (!isRecord(input)) return { ok: false, errors: ['The body must be a JSON object.'] };
  const read = readers(errors);

  const mode = input.mode ?? 'drafted';
  if (mode !== 'drafted' && mode !== 'live') errors.push('mode must be "drafted" or "live".');
  if (input.providerCosts !== undefined) {
    errors.push('providerCosts is no longer accepted: supply rates and usage instead.');
  }

  const target = (raw: Record<string, unknown>, at: string): ActionTarget => {
    const maxDurationSeconds = raw.maxDurationSeconds ?? null;
    if (maxDurationSeconds !== null && !(Number.isSafeInteger(maxDurationSeconds) && (maxDurationSeconds as number) > 0)) {
      errors.push(`${at}.maxDurationSeconds must be a positive whole number of seconds, or null.`);
    }
    return {
      actionType: read.key(raw.actionType, `${at}.actionType`, 'action key'),
      qualityTier: read.key(raw.qualityTier, `${at}.qualityTier`, 'tier key'),
      maxDurationSeconds: maxDurationSeconds as number | null,
      unit: read.oneOf(raw.unit, `${at}.unit`, ['per_action', 'per_minute'] as const),
    };
  };
  const targetKey = (t: ActionTarget) => actionKey(t.actionType, t.qualityTier, t.maxDurationSeconds);
  const meters = (raw: unknown, at: string, min: number) => {
    const seen = new Set<string>();
    return read.list(raw, at, { min, max: MAX_METERS }, (m, here): MeterUse => {
      const use = {
        provider: read.key(m.provider, `${here}.provider`, 'provider key'),
        meter: read.key(m.meter, `${here}.meter`, 'meter key'),
        quantity: read.quantity(m.quantity, `${here}.quantity`),
      };
      read.unique(seen, rateKey(use.provider, use.meter), here, 'meter');
      return use;
    });
  };

  const seenProviders = new Set<string>();
  const providers = read.list(input.providers, 'providers', { min: 0, max: MAX_ENTRIES }, (p, at): ProviderEndpointInput => {
    const provider = read.key(p.provider, `${at}.provider`, 'provider key');
    const endpoint = read.oneOf(p.endpoint, `${at}.endpoint`, ['global', 'us_regional'] as const);
    const premium = p.regionalPremiumPercent ?? null;
    let regionalPremium: Ratio | null = null;
    if (endpoint === 'us_regional') {
      regionalPremium = read.percent(premium, `${at}.regionalPremiumPercent`, true);
    } else if (premium !== null) {
      errors.push(`${at}.regionalPremiumPercent must be null on the global endpoint.`);
    }
    read.unique(seenProviders, provider, at, 'endpoint');
    return { provider, endpoint, regionalPremium };
  });

  const seenRates = new Set<string>();
  const rates = read.list(input.rates, 'rates', { min: 0, max: MAX_ENTRIES }, (rt, at): RateInput => {
    const rate: RateInput = {
      provider: read.key(rt.provider, `${at}.provider`, 'provider key'),
      meter: read.key(rt.meter, `${at}.meter`, 'meter key'),
      kind: read.oneOf(rt.kind, `${at}.kind`, RATE_KINDS),
      amountMicros: read.micros(rt.amountMicros, `${at}.amountMicros`),
      perQuantity:
        Number.isSafeInteger(rt.perQuantity) && (rt.perQuantity as number) > 0
          ? (rt.perQuantity as number)
          : (errors.push(`${at}.perQuantity must be a positive whole number of units.`), 1),
      currency: read.currency(rt.currency, `${at}.currency`),
      observedAt: read.date(rt.observedAt, `${at}.observedAt`),
      source: read.text(rt.source, `${at}.source`),
    };
    read.unique(seenRates, rateKey(rate.provider, rate.meter), at, 'rate');
    return rate;
  });

  const usageIn: Record<string, unknown> | null =
    isRecord(input.usage) ? input.usage : input.usage === undefined || input.usage === null ? {} : null;
  if (usageIn === null) errors.push('usage must be an object with "actions" and "plans".');
  const seenActionUsage = new Set<string>();
  const actionUsage = read.list(usageIn?.actions, 'usage.actions', { min: 0, max: MAX_ENTRIES }, (u, at): ActionUsageInput => {
    const t = target(u, at);
    const out = { ...t, meters: meters(u.meters, `${at}.meters`, 1), source: read.text(u.source, `${at}.source`) };
    read.unique(seenActionUsage, targetKey(t), at, 'usage');
    return out;
  });
  const seenPlanUsage = new Set<string>();
  const planUsage = read.list(usageIn?.plans, 'usage.plans', { min: 0, max: MAX_ENTRIES }, (u, at): PlanUsageInput => {
    const plan = read.key(u.plan, `${at}.plan`, 'plan code');
    const out = { plan, meters: meters(u.meters, `${at}.meters`, 0), source: read.text(u.source, `${at}.source`) };
    read.unique(seenPlanUsage, plan, at, 'usage');
    return out;
  });

  const seenChannels = new Set<string>();
  const salesChannels = read.list(input.salesChannels, 'salesChannels', { min: 0, max: MAX_ENTRIES }, (c, at): SalesChannelInput => {
    const channel = read.key(c.channel, `${at}.channel`, 'channel key');
    const seenDeductions = new Set<string>();
    const deductions = read.list(c.deductions, `${at}.deductions`, { min: 1, max: MAX_DEDUCTIONS }, (d, here): DeductionInput => {
      const pct = d.percentOfPrice ?? null;
      const fixed = d.fixedAmountMicros ?? null;
      if (pct === null && fixed === null) errors.push(`${here} must set percentOfPrice, fixedAmountMicros or both.`);
      const out: DeductionInput = {
        kind: read.oneOf(d.kind, `${here}.kind`, DEDUCTION_KINDS),
        label: read.text(d.label, `${here}.label`),
        percentOfPrice: pct === null ? null : read.percent(pct, `${here}.percentOfPrice`, false),
        fixedAmountMicros: fixed === null ? null : read.micros(fixed, `${here}.fixedAmountMicros`),
        currency: null,
        observedAt: read.date(d.observedAt, `${here}.observedAt`),
        source: read.text(d.source, `${here}.source`),
      };
      if (fixed !== null) {
        out.currency =
          typeof d.currency === 'string' && CURRENCY.test(d.currency)
            ? d.currency
            : (errors.push(`${here}.currency must be a 3-letter code when fixedAmountMicros is set.`), null);
      } else if ((d.currency ?? null) !== null) {
        errors.push(`${here}.currency must be null when there is no fixedAmountMicros.`);
      }
      read.unique(seenDeductions, `${out.kind}${out.label ? `:${out.label}` : ''}`, here, 'deduction');
      return out;
    });
    read.unique(seenChannels, channel, at, 'sales channel');
    return { channel, deductions };
  });

  const otherIn: Record<string, unknown> | null = isRecord(input.otherCosts)
    ? input.otherCosts
    : input.otherCosts === undefined || input.otherCosts === null
      ? {}
      : null;
  if (otherIn === null) errors.push('otherCosts must be an object with "actions" and "plans".');
  const seenActionOther = new Set<string>();
  const actionOther = read.list(otherIn?.actions, 'otherCosts.actions', { min: 0, max: MAX_ENTRIES }, (o, at): ActionOtherCostInput => {
    const out: ActionOtherCostInput = {
      ...target(o, at),
      kind: read.oneOf(o.kind, `${at}.kind`, OTHER_COST_KINDS),
      label: read.text(o.label, `${at}.label`),
      amountMicros: read.micros(o.amountMicros, `${at}.amountMicros`),
      currency: read.currency(o.currency, `${at}.currency`),
      observedAt: read.date(o.observedAt, `${at}.observedAt`),
      source: read.text(o.source, `${at}.source`),
    };
    read.unique(seenActionOther, otherLabel(targetKey(out), out), at, 'other cost');
    return out;
  });
  const seenPlanOther = new Set<string>();
  const planOther = read.list(otherIn?.plans, 'otherCosts.plans', { min: 0, max: MAX_ENTRIES }, (o, at): PlanOtherCostInput => {
    const out: PlanOtherCostInput = {
      plan: read.key(o.plan, `${at}.plan`, 'plan code'),
      kind: read.oneOf(o.kind, `${at}.kind`, OTHER_COST_KINDS),
      label: read.text(o.label, `${at}.label`),
      amountMicros: read.micros(o.amountMicros, `${at}.amountMicros`),
      currency: read.currency(o.currency, `${at}.currency`),
      observedAt: read.date(o.observedAt, `${at}.observedAt`),
      source: read.text(o.source, `${at}.source`),
    };
    read.unique(seenPlanOther, otherLabel(`plan:${out.plan}`, out), at, 'other cost');
    return out;
  });

  const rawGuard = input.marginGuard ?? {};
  let marginGuard: MarginGuardInput = { minGrossMarginPercent: null, minNetMarginPercent: null, maxCostAgeDays: null };
  if (!isRecord(rawGuard)) {
    errors.push('marginGuard must be an object.');
  } else {
    const floor = (v: unknown, name: string) => {
      const f = v ?? null;
      if (f !== null && !(typeof f === 'number' && f >= 0 && f < 100 && exactDecimal(f, 2) !== null)) {
        errors.push(`marginGuard.${name} must be at least 0 and below 100, to at most two decimal places.`);
      }
      return f as number | null;
    };
    const age = rawGuard.maxCostAgeDays ?? null;
    if (age !== null && !(Number.isSafeInteger(age) && (age as number) >= 1 && (age as number) <= 3650)) {
      errors.push('marginGuard.maxCostAgeDays must be a whole number of days from 1 to 3650.');
    }
    marginGuard = {
      minGrossMarginPercent: floor(rawGuard.minGrossMarginPercent, 'minGrossMarginPercent'),
      minNetMarginPercent: floor(rawGuard.minNetMarginPercent, 'minNetMarginPercent'),
      maxCostAgeDays: age as number | null,
    };
  }

  // Speech-to-speech already includes recognition and synthesis: a usage that
  // adds a separate speech-to-text or text-to-speech meter would count them twice.
  const kindOf = new Map(rates.map((rt) => [rateKey(rt.provider, rt.meter), rt.kind]));
  const checkSpeech = (list: MeterUse[], at: string) => {
    const kinds = new Set(list.map((m) => kindOf.get(rateKey(m.provider, m.meter))));
    if (kinds.has('speech_to_speech') && (kinds.has('speech_to_text') || kinds.has('text_to_speech'))) {
      errors.push(
        `${at} combines speech-to-speech with a separate speech-to-text or text-to-speech meter, which would count recognition and synthesis twice.`,
      );
    }
  };
  actionUsage.forEach((u, i) => checkSpeech(u.meters, `usage.actions[${i}]`));
  planUsage.forEach((u, i) => checkSpeech(u.meters, `usage.plans[${i}]`));

  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          mode: mode as PreviewMode,
          providers,
          rates,
          usage: { actions: actionUsage, plans: planUsage },
          salesChannels,
          otherCosts: { actions: actionOther, plans: planOther },
          marginGuard,
        },
      };
}

const otherLabel = (target: string, o: { kind: OtherCostKind; label: string | null }) =>
  `${target}/${o.kind}${o.label ? `:${o.label}` : ''}`;

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

/** Why a figure is not shown. `ref` names what is missing or wrong. */
export interface Gap {
  reason:
    | 'usage_not_supplied'
    | 'unit_mismatch'
    | 'rate_not_supplied'
    | 'endpoint_not_declared'
    | 'mixed_currencies'
    | 'ai_provider_cost_incomplete'
    | 'sales_channel_not_supplied'
    | 'infrastructure_not_supplied'
    | 'grant_cost_incomplete'
    | 'no_purchasable_pack'
    | 'currency_mismatch';
  ref: string;
}

export type AiProviderCostReport =
  | {
      status: 'complete';
      total: Money;
      base: Money;
      /** The regional-endpoint premium included in `total`; null when none applies. */
      regionalPremium: Money | null;
      lines: Array<{ provider: string; meter: string; kind: RateKind; quantity: string; cost: Money; source: string | null }>;
      /** The oldest rate used; both null if any rate is undated or future-dated. */
      observedAt: string | null;
      ageDays: number | null;
    }
  | { status: 'incomplete'; gaps: Gap[] };

export interface OtherCostsReport {
  lines: Array<{ kind: OtherCostKind; label: string | null; cost: Money }>;
  /** Measured infrastructure allocation is required for a net figure; the rest are optional. */
  infrastructure: 'supplied' | 'not_supplied';
}

type NetReport<Row> = { status: 'complete'; channels: Array<{ channel: string } & Row> } | { status: 'incomplete'; gaps: Gap[] };
type GuardState = 'ok' | 'below_threshold' | 'not_evaluated';

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
    /** §8.1 / B.4: AI provider cost if the whole grant goes on the dearest-to-serve action. */
    worstCaseAiProviderCost:
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
    /**
     * What RUNTIME would do when asked to price this row, answered by the
     * resolver's own `actionCostFor`: `priced`, or the reason it would refuse.
     */
    runtime: 'priced' | string;
    cashPrice: Array<{ pack: string; price: Money }>;
    /** (1) What the model provider bills for one action (or one minute). */
    aiProviderCost: AiProviderCostReport;
    /** AI provider cost per Credit: the §8.1 parity quantity. Lower is safer. */
    aiProviderCostPerCredit: Money | null;
    /** Price less AI provider cost, at every same-currency rung (§31, B.4). */
    grossMargins: Array<{ pack: string; grossMarginPercent: string; costMultiple: string }>;
    /** (3) Infrastructure, telephony and other costs of one action (or one minute). */
    otherCosts: OtherCostsReport;
    /** Price less (2) channel deductions, (1) and (3), per channel and rung; or the gaps. */
    net: NetReport<{ rungs: Array<{ pack: string; deductions: Money; contribution: Money; netMarginPercent: string }> }>;
    guard: GuardState;
    netGuard: GuardState;
  }>;
  /** Per subscriber per month: the plan's price against everything it costs to serve. */
  subscriptions: Array<{
    plan: string;
    version: number;
    source: Source;
    pricePerMonth: Money;
    /** (1) The AI provider cost of the plan's included, non-Credit usage. */
    includedUsage: AiProviderCostReport;
    /** (1) + (3) if the whole grant goes on the dearest action to serve (§8.1). */
    grantWorstCase: { status: 'complete'; action: string | null; cost: Money } | { status: 'incomplete'; gaps: Gap[] };
    /** (3) Per subscriber per month. */
    otherCosts: OtherCostsReport;
    net: NetReport<{ deductions: Money; contribution: Money; netMarginPercent: string }>;
  }>;
  disabledActions: string[];
  /** Rows the runtime would refuse to price, e.g. an ambiguous tier set. */
  configurationIssues: Array<{ action: string; reason: string }>;
  inputs: {
    /** Enabled actions whose AI provider cost cannot be computed; the action says why. */
    missingAiProviderCosts: string[];
    /** Usage or other costs that name no action or plan in this economy. */
    unmatched: string[];
    /** Rates no supplied usage refers to. */
    unusedRates: string[];
    unitMismatches: string[];
    currencyMismatches: string[];
    undated: string[];
    stale: Array<{ input: string; ageDays: number }>;
    futureDated: string[];
  };
  marginGuard: {
    status: 'not_configured' | 'evaluated';
    minGrossMarginPercent: number | null;
    maxCostAgeDays: number | null;
    /** `grossMarginPercent` here is to two decimals, rounded DOWN (see `decimalFloor`). */
    warnings: Array<{ action: string; pack: string; grossMarginPercent: string }>;
    notEvaluated: Array<{ action: string; reason: string }>;
    net: {
      status: 'not_configured' | 'evaluated';
      minNetMarginPercent: number | null;
      /** Rounded DOWN to two decimals, as above; at the thinnest channel and rung. */
      warnings: Array<{ action: string; channel: string; pack: string; netMarginPercent: string }>;
      notEvaluated: Array<{ action: string; reason: string }>;
    };
  };
  /** §8.1 margin parity, as information: the guard does not quantify "materially". */
  parity: { thinnestAction: string; highestCostPerCredit: Money; lowestCostPerCredit: Money } | null;
  caveats: string[];
  precision: {
    price: 2;
    perCredit: 3;
    actionCost: 4;
    meterLine: 6;
    perSubscriberMonth: 2;
    percent: 0;
    costMultiple: 1;
  };
}

const DAY_MS = 86_400_000;

type AiCost =
  | {
      ok: true;
      /** Null only for an empty usage (a plan with no included usage). */
      currency: string | null;
      base: Ratio;
      premium: Ratio | null;
      total: Ratio;
      lines: Array<{ provider: string; meter: string; kind: RateKind; quantity: Ratio; cost: Ratio; source: string | null }>;
      observedAt: string | null;
      ageDays: number | null;
    }
  | { ok: false; gaps: Gap[] };

type DatedRate = RateInput & { ageDays: number | null; dated: boolean };
type Other = { kind: OtherCostKind; label: string | null; amountMicros: number; currency: string };

function pushGap(gaps: Gap[], gap: Gap) {
  if (!gaps.some((g) => g.reason === gap.reason && g.ref === gap.ref)) gaps.push(gap);
}

/** Rate card x usage, plus any declared regional premium. Exact. */
function costOfUsage(
  meters: MeterUse[],
  rates: Map<string, DatedRate>,
  endpoints: Map<string, ProviderEndpointInput>,
): AiCost {
  const gaps: Gap[] = [];
  const lines: Extract<AiCost, { ok: true }>['lines'] = [];
  const used: DatedRate[] = [];
  const byProvider = new Map<string, Ratio>();
  for (const m of meters) {
    const rate = rates.get(rateKey(m.provider, m.meter));
    if (!rate) {
      pushGap(gaps, { reason: 'rate_not_supplied', ref: rateKey(m.provider, m.meter) });
      continue;
    }
    if (!endpoints.has(m.provider)) {
      pushGap(gaps, { reason: 'endpoint_not_declared', ref: m.provider });
      continue;
    }
    const cost = mul(m.quantity, ratio(BigInt(rate.amountMicros), BigInt(rate.perQuantity)));
    lines.push({ provider: m.provider, meter: m.meter, kind: rate.kind, quantity: m.quantity, cost, source: rate.source });
    used.push(rate);
    byProvider.set(m.provider, add(byProvider.get(m.provider) ?? ZERO, cost));
  }
  const currencies = [...new Set(used.map((r) => r.currency))].sort();
  if (currencies.length > 1) pushGap(gaps, { reason: 'mixed_currencies', ref: currencies.join(',') });
  if (gaps.length > 0) return { ok: false, gaps };

  const base = sum(lines.map((l) => l.cost));
  let premium: Ratio | null = null;
  for (const [provider, subtotal] of byProvider) {
    const endpoint = endpoints.get(provider)!;
    if (endpoint.endpoint === 'us_regional') premium = add(premium ?? ZERO, mul(subtotal, endpoint.regionalPremium!));
  }
  const allDated = used.every((r) => r.dated);
  const oldest = allDated && used.length > 0 ? used.reduce((a, b) => (b.ageDays! > a.ageDays! ? b : a)) : null;
  return {
    ok: true,
    currency: currencies[0] ?? null,
    base,
    premium,
    total: premium ? add(base, premium) : base,
    lines,
    observedAt: oldest?.observedAt ?? null,
    ageDays: oldest?.ageDays ?? null,
  };
}

function aiReport(ai: AiCost, fallbackCurrency: string): AiProviderCostReport {
  if (!ai.ok) return { status: 'incomplete', gaps: ai.gaps };
  const currency = ai.currency ?? fallbackCurrency;
  return {
    status: 'complete',
    total: money(ai.total, currency, 4),
    base: money(ai.base, currency, 4),
    regionalPremium: ai.premium ? money(ai.premium, currency, 4) : null,
    lines: ai.lines.map((l) => ({
      provider: l.provider,
      meter: l.meter,
      kind: l.kind,
      quantity: plain(l.quantity),
      cost: money(l.cost, currency, 6),
      source: l.source,
    })),
    observedAt: ai.observedAt,
    ageDays: ai.ageDays,
  };
}

function othersOf(list: Other[]) {
  return {
    list,
    total: sum(list.map((o) => micros(o.amountMicros))),
    currencies: [...new Set(list.map((o) => o.currency))].sort(),
    infrastructure: list.some((o) => o.kind === 'infrastructure'),
  };
}
const othersReport = (o: ReturnType<typeof othersOf>, digits: number): OtherCostsReport => ({
  lines: o.list.map((x) => ({ kind: x.kind, label: x.label, cost: money(micros(x.amountMicros), x.currency, digits) })),
  infrastructure: o.infrastructure ? 'supplied' : 'not_supplied',
});

/** A channel's deductions from one transaction of `price` (micros), plus its fixed part. */
const deductionsOf = (channel: SalesChannelInput, price: Ratio, fixedDivisor = 1n) =>
  sum(
    channel.deductions.map((d) =>
      add(
        d.percentOfPrice ? mul(price, d.percentOfPrice) : ZERO,
        d.fixedAmountMicros === null ? ZERO : ratio(BigInt(d.fixedAmountMicros), fixedDivisor),
      ),
    ),
  );

/** Gaps shared by every net figure: channels supplied, and in the figure's currency. */
function channelGaps(channels: SalesChannelInput[], currency: string, ref: string, gaps: Gap[]) {
  if (channels.length === 0) pushGap(gaps, { reason: 'sales_channel_not_supplied', ref });
  for (const ch of channels) {
    for (const d of ch.deductions) {
      if (d.currency !== null && d.currency !== currency) {
        pushGap(gaps, { reason: 'currency_mismatch', ref: `deduction ${ch.channel}/${d.kind} in ${d.currency}, not ${currency}` });
      }
    }
  }
}

/** The report for a composed economy. Pure: no queries, no clock of its own. */
export function computeEconomics(economy: ComposedEconomy, inputs: PreviewInputs): EconomyPreview {
  const rules = economy.ruleset?.view ?? null;
  const all = rules ? [...rules.actionCosts] : [];
  const enabled = all.filter((c) => c.enabled);
  const purchasablePacks = economy.packs.filter((p) => p.view.isPurchasable);
  const floorOf = (pct: number | null) => (pct === null ? null : ratio(exactDecimal(pct, 2)!, 10_000n));
  const grossFloor = floorOf(inputs.marginGuard.minGrossMarginPercent);
  const netFloor = floorOf(inputs.marginGuard.minNetMarginPercent);
  const asOfMs = Date.parse(economy.asOf.iso);
  const channels = inputs.salesChannels;

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
        price: money(ratio(BigInt(r.priceMinor) * MICROS_PER_MINOR), currency),
        perCredit: money(ratio(BigInt(r.priceMinor) * MICROS_PER_MINOR, BigInt(r.credits)), currency, 3),
        isBestValue: r.isBestValue,
      })),
      spreadPercent,
      issues,
    };
  });

  /* ---- the inputs: dated, matched, checked ---- */
  const report: EconomyPreview['inputs'] = {
    missingAiProviderCosts: [],
    unmatched: [],
    unusedRates: [],
    unitMismatches: [],
    currencyMismatches: [],
    undated: [],
    stale: [],
    futureDated: [],
  };
  const dated = (label: string, observedAt: string | null): { ageDays: number | null; dated: boolean } => {
    if (observedAt === null) {
      report.undated.push(label);
      return { ageDays: null, dated: false };
    }
    const observed = Date.parse(observedAt);
    if (observed > asOfMs) {
      report.futureDated.push(label);
      return { ageDays: null, dated: false };
    }
    const ageDays = Math.floor((asOfMs - observed) / DAY_MS);
    const max = inputs.marginGuard.maxCostAgeDays;
    if (max !== null && ageDays > max) report.stale.push({ input: label, ageDays });
    return { ageDays, dated: true };
  };

  const rates = new Map<string, DatedRate>(
    inputs.rates.map((r) => [rateKey(r.provider, r.meter), { ...r, ...dated(`rate ${rateKey(r.provider, r.meter)}`, r.observedAt) }]),
  );
  const endpoints = new Map(inputs.providers.map((p) => [p.provider, p]));
  for (const ch of channels) {
    for (const d of ch.deductions) dated(`deduction ${ch.channel}/${d.kind}${d.label ? `:${d.label}` : ''}`, d.observedAt);
  }

  const referenced = new Set(
    [...inputs.usage.actions, ...inputs.usage.plans].flatMap((u) => u.meters.map((m) => rateKey(m.provider, m.meter))),
  );
  report.unusedRates = [...rates.keys()].filter((k) => !referenced.has(k));

  const rowByKey = new Map(all.map((c) => [keyOf(c), c]));
  const planCodes = new Set(economy.plans.map((p) => p.view.ref.code));

  const usageByAction = new Map<string, ActionUsageInput>();
  const unitMismatched = new Set<string>();
  for (const u of inputs.usage.actions) {
    const key = actionKey(u.actionType, u.qualityTier, u.maxDurationSeconds);
    const row = rowByKey.get(key);
    if (!row) report.unmatched.push(`usage ${key}`);
    else if (row.unit !== u.unit) {
      report.unitMismatches.push(`usage ${key}: action is ${row.unit}, usage is ${u.unit}`);
      unitMismatched.add(key);
    } else usageByAction.set(key, u);
  }
  const usageByPlan = new Map<string, PlanUsageInput>();
  for (const u of inputs.usage.plans) {
    if (!planCodes.has(u.plan)) report.unmatched.push(`usage plan:${u.plan}`);
    else usageByPlan.set(u.plan, u);
  }

  const othersByAction = new Map<string, Other[]>();
  for (const o of inputs.otherCosts.actions) {
    const key = actionKey(o.actionType, o.qualityTier, o.maxDurationSeconds);
    dated(`other_cost ${otherLabel(key, o)}`, o.observedAt);
    const row = rowByKey.get(key);
    if (!row) report.unmatched.push(`other_cost ${otherLabel(key, o)}`);
    else if (row.unit !== o.unit) report.unitMismatches.push(`other_cost ${otherLabel(key, o)}: action is ${row.unit}, cost is ${o.unit}`);
    else othersByAction.set(key, [...(othersByAction.get(key) ?? []), o]);
  }
  const othersByPlan = new Map<string, Other[]>();
  for (const o of inputs.otherCosts.plans) {
    const label = otherLabel(`plan:${o.plan}`, o);
    dated(`other_cost ${label}`, o.observedAt);
    if (!planCodes.has(o.plan)) report.unmatched.push(`other_cost ${label}`);
    else othersByPlan.set(o.plan, [...(othersByPlan.get(o.plan) ?? []), o]);
  }

  /* ---- AI provider cost of every enabled action ---- */
  const aiByAction = new Map<string, AiCost>();
  for (const c of enabled) {
    const key = keyOf(c);
    const usage = usageByAction.get(key);
    const ai: AiCost = usage
      ? costOfUsage(usage.meters, rates, endpoints)
      : { ok: false, gaps: [{ reason: unitMismatched.has(key) ? 'unit_mismatch' : 'usage_not_supplied', ref: key }] };
    aiByAction.set(key, ai);
    if (!ai.ok) report.missingAiProviderCosts.push(key);
  }

  /* ---- actions: cash prices (B.2), margins (B.4), net, guards ---- */
  const guardWarnings: EconomyPreview['marginGuard']['warnings'] = [];
  const guardNotEvaluated: EconomyPreview['marginGuard']['notEvaluated'] = [];
  const netWarnings: EconomyPreview['marginGuard']['net']['warnings'] = [];
  const netNotEvaluated: EconomyPreview['marginGuard']['net']['notEvaluated'] = [];
  const perCreditCosts: Array<{ action: string; cost: Ratio; currency: string }> = [];
  const configurationIssues: EconomyPreview['configurationIssues'] = [];

  const actions: EconomyPreview['actions'] = enabled.map((c) => {
    const key = keyOf(c);
    const ai = aiByAction.get(key)!;
    const others = othersOf(othersByAction.get(key) ?? []);
    const retailAt = (p: PackView) =>
      ratio(BigInt(c.creditCost) * BigInt(p.priceMinor) * MICROS_PER_MINOR, BigInt(p.credits));
    const cashPrice = purchasablePacks.map((p) => ({ pack: p.view.ref.code, price: money(retailAt(p.view), p.view.currency) }));

    /* gross: price less AI provider cost */
    const grossMargins: EconomyPreview['actions'][number]['grossMargins'] = [];
    let worstGross: { pack: string; margin: Ratio } | null = null;
    const currency = ai.ok ? ai.currency! : null;
    const sameCurrency = currency ? purchasablePacks.filter((p) => p.view.currency === currency) : [];
    if (ai.ok) {
      if (purchasablePacks.length > 0 && sameCurrency.length === 0) {
        report.currencyMismatches.push(`${key}: AI provider cost in ${currency}, no purchasable pack in ${currency}`);
      }
      for (const p of sameCurrency) {
        const retail = retailAt(p.view);
        const margin = div(sub(retail, ai.total), retail);
        const multiple = div(retail, ai.total);
        grossMargins.push({
          pack: p.view.ref.code,
          grossMarginPercent: percent0(margin),
          costMultiple: decimal(multiple.num, multiple.den, 1),
        });
        if (!worstGross || cmp(margin, worstGross.margin) < 0) worstGross = { pack: p.view.ref.code, margin };
      }
      perCreditCosts.push({ action: key, cost: div(ai.total, ratio(BigInt(c.creditCost))), currency: currency! });
    }

    let guard: GuardState = 'not_evaluated';
    if (grossFloor === null) {
      // Reported once, at the guard level.
    } else if (!ai.ok) {
      guardNotEvaluated.push({ action: key, reason: 'ai_provider_cost_incomplete' });
    } else if (!worstGross) {
      guardNotEvaluated.push({ action: key, reason: purchasablePacks.length === 0 ? 'no_purchasable_packs' : 'currency_mismatch' });
    } else if (cmp(worstGross.margin, grossFloor) < 0) {
      guard = 'below_threshold';
      // Two decimals, rounded down: the precision the threshold is set in, and
      // never a figure that appears to meet the floor it breached.
      guardWarnings.push({ action: key, pack: worstGross.pack, grossMarginPercent: percentFloor2(worstGross.margin) });
    } else {
      guard = 'ok';
    }

    /* net: price less channel deductions, AI provider cost and other costs */
    const netGaps: Gap[] = [];
    if (!ai.ok) pushGap(netGaps, { reason: 'ai_provider_cost_incomplete', ref: key });
    if (!others.infrastructure) pushGap(netGaps, { reason: 'infrastructure_not_supplied', ref: key });
    if (currency) {
      if (sameCurrency.length === 0) pushGap(netGaps, { reason: 'no_purchasable_pack', ref: currency });
      for (const oc of others.currencies) {
        if (oc !== currency) pushGap(netGaps, { reason: 'currency_mismatch', ref: `other costs in ${oc}, not ${currency}` });
      }
      channelGaps(channels, currency, 'sales_channels', netGaps);
    } else if (channels.length === 0) {
      pushGap(netGaps, { reason: 'sales_channel_not_supplied', ref: 'sales_channels' });
    }

    let net: EconomyPreview['actions'][number]['net'];
    let worstNet: { channel: string; pack: string; margin: Ratio } | null = null;
    if (netGaps.length > 0 || !ai.ok) {
      net = { status: 'incomplete', gaps: netGaps };
    } else {
      net = {
        status: 'complete',
        channels: channels.map((ch) => ({
          channel: ch.channel,
          rungs: sameCurrency.map((p) => {
            const retail = retailAt(p.view);
            const perPurchase = deductionsOf(ch, ratio(BigInt(p.view.priceMinor) * MICROS_PER_MINOR));
            const deductions = mul(perPurchase, ratio(BigInt(c.creditCost), BigInt(p.view.credits)));
            const contribution = sub(sub(sub(retail, deductions), ai.total), others.total);
            const margin = div(contribution, retail);
            if (!worstNet || cmp(margin, worstNet.margin) < 0) worstNet = { channel: ch.channel, pack: p.view.ref.code, margin };
            return {
              pack: p.view.ref.code,
              deductions: money(deductions, currency!, 4),
              contribution: money(contribution, currency!, 4),
              netMarginPercent: percent0(margin),
            };
          }),
        })),
      };
    }

    let netGuard: GuardState = 'not_evaluated';
    const thinnest = worstNet as { channel: string; pack: string; margin: Ratio } | null;
    if (netFloor === null) {
      // Reported once, at the guard level.
    } else if (net.status === 'incomplete' || !thinnest) {
      netNotEvaluated.push({ action: key, reason: 'net_incomplete' });
    } else if (cmp(thinnest.margin, netFloor) < 0) {
      netGuard = 'below_threshold';
      netWarnings.push({ action: key, channel: thinnest.channel, pack: thinnest.pack, netMarginPercent: percentFloor2(thinnest.margin) });
    } else {
      netGuard = 'ok';
    }

    // Ask the runtime's own lookup what it would charge for exactly this row.
    // A tiered row is asked at its own upper bound, which the smallest-covering
    // rule answers with the row itself when the configuration is sound.
    const lookup = rules
      ? actionCostFor(rules, c.actionType, {
          qualityTier: c.qualityTier,
          ...(c.maxDurationSeconds === null ? {} : { durationSeconds: c.maxDurationSeconds }),
        })
      : null;
    const runtime = !lookup ? 'no_ruleset' : lookup.ok ? 'priced' : lookup.reason;
    if (runtime !== 'priced') configurationIssues.push({ action: key, reason: runtime });

    return {
      action: key,
      actionType: c.actionType,
      qualityTier: c.qualityTier,
      maxDurationSeconds: c.maxDurationSeconds,
      unit: c.unit,
      creditCost: c.creditCost,
      runtime,
      cashPrice,
      aiProviderCost: aiReport(ai, ''),
      aiProviderCostPerCredit: ai.ok ? money(div(ai.total, ratio(BigInt(c.creditCost))), currency!, 4) : null,
      grossMargins,
      otherCosts: othersReport(others, 4),
      net,
      guard,
      netGuard,
    };
  });

  /* ---- grants (B.1) and worst-case AI exposure (§8.1, B.4) ---- */
  const grants: EconomyPreview['grants'] = economy.plans.map(({ view: plan, source }) => {
    const buys = enabled.map((c) => ({
      action: keyOf(c),
      unit: c.unit,
      creditCost: c.creditCost,
      quantity: Math.floor(plan.monthlyIncludedCredits / c.creditCost),
    }));
    let knownWorst: { action: string; cost: Ratio } | null = null;
    const missingCosts: string[] = [];
    for (const buy of buys) {
      const ai = aiByAction.get(buy.action)!;
      if (!ai.ok || ai.currency !== plan.currency) {
        missingCosts.push(buy.action);
        if (ai.ok) report.currencyMismatches.push(`${buy.action}: AI provider cost in ${ai.currency}, plan ${plan.ref.code} in ${plan.currency}`);
        continue;
      }
      const cost = mul(ratio(BigInt(buy.quantity)), ai.total);
      if (!knownWorst || cmp(cost, knownWorst.cost) > 0) knownWorst = { action: buy.action, cost };
    }
    const asMoney = (w: { action: string; cost: Ratio }) => ({ action: w.action, cost: money(w.cost, plan.currency) });
    return {
      plan: plan.ref.code,
      version: plan.ref.version,
      source,
      monthlyCredits: plan.monthlyIncludedCredits,
      buys,
      worstCaseAiProviderCost:
        buys.length === 0
          ? { status: 'no_actions' as const }
          : missingCosts.length === 0 && knownWorst
            ? { status: 'complete' as const, ...asMoney(knownWorst) }
            : { status: 'incomplete' as const, knownWorst: knownWorst ? asMoney(knownWorst) : null, missingCosts },
    };
  });

  /* ---- subscriptions: per subscriber per month ---- */
  const subscriptions: EconomyPreview['subscriptions'] = economy.plans.map(({ view: plan, source }) => {
    const ref = `plan:${plan.ref.code}`;
    const currency = plan.currency;
    const months = BigInt(plan.billingPeriodMonths);
    const revenue = ratio(BigInt(plan.priceMinor) * MICROS_PER_MINOR, months);
    const gaps: Gap[] = [];

    const usage = usageByPlan.get(plan.ref.code);
    const included: AiCost = usage
      ? costOfUsage(usage.meters, rates, endpoints)
      : { ok: false, gaps: [{ reason: 'usage_not_supplied', ref }] };
    if (!included.ok) pushGap(gaps, { reason: 'ai_provider_cost_incomplete', ref });
    else if (included.currency !== null && included.currency !== currency) {
      pushGap(gaps, { reason: 'currency_mismatch', ref: `included usage in ${included.currency}, not ${currency}` });
    }

    // The grant, spent entirely on the dearest action to serve: AI provider
    // cost plus that action's other costs, per unit, times what the grant buys.
    const grantGaps: Gap[] = [];
    let worst: { action: string; cost: Ratio } | null = null;
    for (const c of enabled) {
      const key = keyOf(c);
      const ai = aiByAction.get(key)!;
      const o = othersOf(othersByAction.get(key) ?? []);
      if (!ai.ok || ai.currency !== currency || !o.infrastructure || o.currencies.some((x) => x !== currency)) {
        pushGap(grantGaps, { reason: 'grant_cost_incomplete', ref: key });
        continue;
      }
      const cost = mul(ratio(BigInt(Math.floor(plan.monthlyIncludedCredits / c.creditCost))), add(ai.total, o.total));
      if (!worst || cmp(cost, worst.cost) > 0) worst = { action: key, cost };
    }
    for (const g of grantGaps) pushGap(gaps, g);
    const grantCost = (worst as { action: string; cost: Ratio } | null)?.cost ?? ZERO;

    const others = othersOf(othersByPlan.get(plan.ref.code) ?? []);
    if (!others.infrastructure) pushGap(gaps, { reason: 'infrastructure_not_supplied', ref });
    for (const oc of others.currencies) {
      if (oc !== currency) pushGap(gaps, { reason: 'currency_mismatch', ref: `other costs in ${oc}, not ${currency}` });
    }
    channelGaps(channels, currency, 'sales_channels', gaps);

    return {
      plan: plan.ref.code,
      version: plan.ref.version,
      source,
      pricePerMonth: money(revenue, currency),
      includedUsage: aiReport(included, currency),
      grantWorstCase:
        grantGaps.length > 0
          ? { status: 'incomplete' as const, gaps: grantGaps }
          : {
              status: 'complete' as const,
              action: (worst as { action: string } | null)?.action ?? null,
              cost: money(grantCost, currency),
            },
      otherCosts: othersReport(others, 2),
      net:
        gaps.length > 0 || !included.ok
          ? { status: 'incomplete' as const, gaps }
          : {
              status: 'complete' as const,
              channels: channels.map((ch) => {
                // A subscription is one transaction per billing period.
                const deductions = deductionsOf(ch, revenue, months);
                const contribution = sub(sub(sub(sub(revenue, deductions), included.total), grantCost), others.total);
                return {
                  channel: ch.channel,
                  deductions: money(deductions, currency),
                  contribution: money(contribution, currency),
                  netMarginPercent: percent0(div(contribution, revenue)),
                };
              }),
            },
    };
  });

  /* ---- parity, as information ---- */
  let parity: EconomyPreview['parity'] = null;
  const parityCurrencies = new Set(perCreditCosts.map((p) => p.currency));
  if (perCreditCosts.length >= 2 && parityCurrencies.size === 1) {
    const sorted = [...perCreditCosts].sort((x, y) => cmp(x.cost, y.cost));
    const high = sorted[sorted.length - 1]!;
    const low = sorted[0]!;
    parity = {
      thinnestAction: high.action,
      highestCostPerCredit: money(high.cost, high.currency, 4),
      lowestCostPerCredit: money(low.cost, low.currency, 4),
    };
  }

  /* ---- what the reader must know ---- */
  const caveats = [
    'Gross margin is the cash price less the AI provider cost only: the basis of the §31 margin guard and of Appendix B. ' +
      'Net margin also deducts the sales channel\'s deductions and the other costs, and is shown only when every input it needs is supplied.',
    'Sales channels are alternatives and are never added together: each sale pays one channel\'s deductions.',
    'A regional-endpoint premium is added only for a provider declared to be on its regional endpoint.',
    'Taxes are not deducted unless supplied as an "other" deduction; rolling reserves are cash timing, not cost, and are not modelled.',
    'Cash prices and margins use pack rates only; subscription-grant Credits are not priced as a rung (Appendix B does the same).',
    'A subscription\'s net assumes its whole monthly grant is spent on the dearest action to serve (§8.1), plus the included usage supplied for it. Free-allowance usage earns nothing and is not modelled.',
    'Amounts assume two-decimal currencies. Currencies are never converted: a cost is compared only with prices in its own currency.',
    'Rates, usage, deductions, other costs and thresholds are the inputs supplied with this preview. None has a default, and nothing is stored or published.',
  ];
  if (grossFloor === null && netFloor === null) caveats.push('No margin threshold is configured, so the guard cannot warn.');
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
    subscriptions,
    disabledActions: all.filter((c) => !c.enabled).map(keyOf),
    configurationIssues,
    inputs: report,
    marginGuard: {
      status: grossFloor === null ? 'not_configured' : 'evaluated',
      minGrossMarginPercent: inputs.marginGuard.minGrossMarginPercent,
      maxCostAgeDays: inputs.marginGuard.maxCostAgeDays,
      warnings: guardWarnings,
      notEvaluated: guardNotEvaluated,
      net: {
        status: netFloor === null ? 'not_configured' : 'evaluated',
        minNetMarginPercent: inputs.marginGuard.minNetMarginPercent,
        warnings: netWarnings,
        notEvaluated: netNotEvaluated,
      },
    },
    parity,
    caveats,
    precision: { price: 2, perCredit: 3, actionCost: 4, meterLine: 6, perSubscriberMonth: 2, percent: 0, costMultiple: 1 },
  };
}

/** Compose and compute. Read-only from end to end. */
export async function previewEconomy(db: Db, inputs: PreviewInputs): Promise<EconomyPreview> {
  return computeEconomics(await composeEconomy(db, inputs.mode), inputs);
}
