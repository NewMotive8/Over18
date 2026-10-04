import type {
  ActionCostInput,
  AdminPackVersion,
  AdminPlanVersion,
  AdminRulesetVersion,
  EconomyConfigurationView,
  EconomyDraftDiff,
  EconomyVersionState,
  PackDraftInput,
  PlanDraftInput,
  RulesetDraftInput,
} from '@over18/shared';
import { ApiRequestError } from '../lib/api';

/**
 * Admin -> Economy editors (P1.4), as pure logic. The web suite runs no
 * effects, so everything the editors decide lives here and is tested here.
 *
 * THE SERVER DECIDES. These helpers turn form text into the request shapes
 * and back, and nothing more. Every range, the catalogue, completeness and
 * publishability are the server's. The vocabulary (feature flags, action
 * types, tiers, allowance keys) is read from the catalogue the server sends,
 * never from a copy here. No price, Credit figure or other economy value is
 * pre-filled.
 *
 * THE FORM SPEAKS THE ADMIN'S LANGUAGE; THE REQUEST IS UNCHANGED. The plan and
 * pack forms used to show the database's own fields -- "Price (minor units)",
 * "Billing period (months)", a code to type -- and the errors that followed
 * were about those fields ("Billing period (months) must be a whole number").
 * Now a price is typed as money, a billing period is chosen by name, the code
 * is made from the name, and messages are written for the person filling the
 * form in. The conversion to the server's fields happens HERE, and the request
 * bodies (`PlanDraftInput`, `PackDraftInput`) are exactly what they were.
 */

export type Catalogue = EconomyConfigurationView['catalogue'];

/* ------------------------------------------------------------------ *
 * Versions
 * ------------------------------------------------------------------ */

export const STATE_LABEL: Record<EconomyVersionState, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  active: 'Published',
  superseded: 'Replaced',
  cancelled: 'Cancelled',
};

/** What each state means for the business -- shown beside the version history. */
export const STATE_HELP: Record<EconomyVersionState, string> = {
  draft: 'Being edited. Customers do not see it, and nothing changes until it is published.',
  scheduled: 'Published, waiting for its start time. It goes live by itself then; until then it can still be cancelled.',
  active: 'Live now. This is the version customers see and are charged for.',
  superseded: 'An earlier version, replaced by a newer one. Kept as a record.',
  cancelled: 'Was scheduled, then cancelled before its start time. It never went live.',
};

/**
 * "Retired" is not a state of its own: it is a PUBLISHED version that is no
 * longer offered (`isPurchasable` false). Said in the words an admin uses.
 */
export const AVAILABILITY_LABEL = { onSale: 'On sale', retired: 'Retired' } as const;
export const availabilityLabel = (isPurchasable: boolean): string => (isPurchasable ? AVAILABILITY_LABEL.onSale : AVAILABILITY_LABEL.retired);
export const RETIRED_HELP =
  'Retired: no longer offered to new customers once published. Customers who already bought it keep what they bought.';

type Stateful = { state: EconomyVersionState };
export const draftOf = <V extends Stateful>(versions: readonly V[]): V | null => versions.find((v) => v.state === 'draft') ?? null;
export const activeOf = <V extends Stateful>(versions: readonly V[]): V | null => versions.find((v) => v.state === 'active') ?? null;

export interface VersionRow {
  kind: 'plan' | 'pack' | 'ruleset';
  code: string | null;
  /** The name this version carries; null for the ruleset. */
  name: string | null;
  id: string;
  version: number;
  state: EconomyVersionState;
  effectiveFrom: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  publishReason: string | null;
  cancelReason: string | null;
}

/** Every version the server reported, newest first within each plan, pack and the ruleset. */
export function versionRows(config: EconomyConfigurationView): VersionRow[] {
  const row = (kind: VersionRow['kind'], code: string | null, v: AdminPlanVersion | AdminPackVersion | AdminRulesetVersion): VersionRow => ({
    kind,
    code,
    name: 'displayName' in v ? v.displayName : null,
    id: v.id,
    version: v.version,
    state: v.state,
    effectiveFrom: v.effectiveFrom,
    publishedAt: v.publishedAt,
    publishedBy: v.publishedBy,
    publishReason: v.publishReason,
    cancelReason: v.cancelReason,
  });
  const newestFirst = <V extends { version: number }>(versions: readonly V[]) => [...versions].sort((a, b) => b.version - a.version);
  return [
    ...config.plans.flatMap((p) => newestFirst(p.versions).map((v) => row('plan', p.code, v))),
    ...config.packs.flatMap((p) => newestFirst(p.versions).map((v) => row('pack', p.code, v))),
    ...newestFirst(config.rulesets).map((v) => row('ruleset', null, v)),
  ];
}

/** The name an item goes by: the live version's, else its newest version's, else its internal ID. */
export function itemName(item: { code: string; versions: ReadonlyArray<Stateful & { version: number; displayName: string }> }): string {
  const named = activeOf(item.versions) ?? [...item.versions].sort((a, b) => b.version - a.version)[0];
  return named?.displayName.trim() || item.code;
}

/** What a plan, pack or the ruleset is called on screen: by its name, never by its code alone. */
export function whatLabel(kind: VersionRow['kind'], name: string | null): string {
  if (kind === 'ruleset') return 'Ruleset';
  return `${kind === 'plan' ? 'Plan' : 'Pack'} “${name ?? ''}”`;
}

/** A plan's or pack's current name, looked up by its code; the code itself if it is not in the configuration. */
export function nameByCode(config: Pick<EconomyConfigurationView, 'plans' | 'packs'>, kind: VersionRow['kind'], code: string | null): string | null {
  if (kind === 'ruleset' || code === null) return null;
  const item = kind === 'plan' ? config.plans.find((p) => p.code === code) : config.packs.find((p) => p.code === code);
  return item ? itemName(item) : code;
}

/** Only a scheduled version can be cancelled -- the server says which are. */
export const isCancellable = (row: Pick<VersionRow, 'state'>) => row.state === 'scheduled';

/* ------------------------------------------------------------------ *
 * Number fields: whole numbers only; the server owns every range
 * ------------------------------------------------------------------ */

type Parsed<T> = { ok: true; body: T } | { ok: false; errors: string[] };

function wholeNumber(value: string, label: string, errors: string[], optional = false): number | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    if (!optional) errors.push(`${label} is required.`);
    return null;
  }
  if (!/^-?\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    errors.push(`${label} must be a whole number.`);
    return null;
  }
  return Number(trimmed);
}

const asText = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

/* ------------------------------------------------------------------ *
 * Money: typed as an amount, sent as minor units
 * ------------------------------------------------------------------ */

/**
 * How many decimal places a currency has (2 for US dollars, 0 for yen), from
 * the browser's own currency data -- the same source `formatMinor` displays
 * with, so what is typed, stored and shown always agree. Null for something
 * that is not a currency code.
 */
export function currencyDigits(currency: string): number | null {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? null;
  } catch {
    return null;
  }
}

/** The currency's symbol, to sit in front of a price field ("$"); the code itself when there is none. */
export function currencySymbol(currency: string): string {
  const code = currency.trim().toUpperCase();
  if (currencyDigits(code) === null) return '';
  const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).formatToParts(0);
  return parts.find((part) => part.type === 'currency')?.value ?? code;
}

/**
 * A stored amount as the text an admin types: minor units -> a plain decimal
 * amount (digits only, so it can be edited and typed back unchanged). Built
 * from the digits, never by dividing, so no rounding can creep in.
 */
export function moneyText(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return '';
  const digits = currencyDigits(currency);
  if (digits === null || digits === 0) return String(minor);
  const padded = String(Math.abs(minor)).padStart(digits + 1, '0');
  return `${minor < 0 ? '-' : ''}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

/**
 * A typed amount as minor units. Accepts what a person types -- with or
 * without the currency symbol, spaces or thousands commas, with or without the
 * decimals -- and converts by digits, never by floating-point multiplication,
 * so a price is stored as exactly the cents that were typed.
 */
function moneyToMinor(value: string, currency: string, label: string, errors: string[], optional = false): number | null {
  const typed = value.trim();
  if (typed === '') {
    if (!optional) errors.push(`${label}: enter an amount.`);
    return null;
  }
  const digits = currencyDigits(currency);
  if (digits === null) {
    errors.push(`${label}: choose the currency first, so the amount can be read correctly.`);
    return null;
  }
  // Drop a leading symbol or code, spaces and thousands commas; keep digits and the decimal point.
  const amount = typed.replace(/[\s,]/g, '').replace(/^[^\d.-]+/, '');
  const match = /^(\d+)(?:\.(\d*))?$/.exec(amount);
  if (!match) {
    errors.push(`${label}: enter a money amount using digits, such as the price a customer pays.`);
    return null;
  }
  const fraction = match[2] ?? '';
  if (fraction.length > digits) {
    errors.push(
      digits === 0
        ? `${label}: this currency has no decimal places. Enter a whole amount.`
        : `${label}: use at most ${digits} decimal places.`,
    );
    return null;
  }
  const minor = Number(match[1] + fraction.padEnd(digits, '0'));
  if (!Number.isSafeInteger(minor)) {
    errors.push(`${label}: that amount is too large.`);
    return null;
  }
  if (minor <= 0) {
    errors.push(`${label} must be more than zero.`);
    return null;
  }
  return minor;
}

/** The currency a new plan or pack starts with: the one the existing products use, if they agree. */
export function suggestedCurrency(config: Pick<EconomyConfigurationView, 'plans' | 'packs'>): string {
  const inUse = new Set<string>();
  const note = (versions: ReadonlyArray<Stateful & { currency: string }>) => {
    const live = activeOf(versions) ?? versions[versions.length - 1];
    if (live) inUse.add(live.currency);
  };
  config.plans.forEach((plan) => note(plan.versions));
  config.packs.forEach((pack) => note(pack.versions));
  return inUse.size === 1 ? [...inUse][0]! : '';
}

/* ------------------------------------------------------------------ *
 * Billing period: chosen by name, sent as months
 * ------------------------------------------------------------------ */

/** The three terms the product sells today, and the months each is stored as. */
export const BILLING_PERIODS = [
  { months: 1, label: 'Monthly', every: 'Charged every month' },
  { months: 3, label: 'Quarterly', every: 'Charged every 3 months' },
  { months: 12, label: 'Annual', every: 'Charged once a year' },
] as const;

/** A stored term in words: Monthly / Quarterly / Annual, or "Every N months" for any other. */
export function billingPeriodLabel(months: number): string {
  return BILLING_PERIODS.find((period) => period.months === months)?.label ?? `Every ${months} months`;
}

/* ------------------------------------------------------------------ *
 * Names for the catalogue's features, and codes made from names
 * ------------------------------------------------------------------ */

/**
 * A catalogue feature key as words: underscores become spaces, the first
 * letter a capital.
 *
 * DERIVED, NOT LISTED. The keys come from the server's catalogue and no copy of
 * them may live here, so the readable name is made from the key itself -- which
 * also means a feature the server adds tomorrow reads sensibly with no change.
 */
export function featureLabel(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

const CODE_MAX = 64;

/**
 * The permanent internal ID for a new plan or pack, made from its name.
 *
 * The server needs a code (lowercase letters, digits and `_`, starting with a
 * letter) and it can never be changed. An admin should not have to invent one:
 * "Premium Monthly" becomes `premium_monthly`. A name that starts with a digit
 * gets the product kind in front (`pack_100_credits`), and a code that is
 * already taken gets `_2`, `_3`... Null when the name has no letters or digits.
 */
export function codeFromName(name: string, kind: 'plan' | 'pack', taken: readonly string[]): string | null {
  let base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (base === '') return null;
  if (!/^[a-z]/.test(base)) base = `${kind}_${base}`;
  if (base.length < 2) base = `${kind}_${base}`;
  base = base.slice(0, CODE_MAX).replace(/_+$/g, '');
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = base.slice(0, CODE_MAX - suffix.length).replace(/_+$/g, '') + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

export interface PlanForm {
  displayName: string;
  /** The chosen term, as the months it is stored as; empty until one is chosen. */
  billingPeriodMonths: string;
  /** The price as typed: a money amount in `currency`, not minor units. */
  price: string;
  currency: string;
  /** Credits included with each payment, i.e. per billing cycle. */
  includedCredits: string;
  /** One entry per catalogue flag: a checkbox always states true or false. */
  features: Record<string, boolean>;
  isPurchasable: boolean;
}

/** A new plan's form: no price, term or Credits chosen, every catalogue flag unticked. */
export function emptyPlanForm(catalogue: Catalogue, currency = ''): PlanForm {
  return {
    displayName: '',
    billingPeriodMonths: '',
    price: '',
    currency,
    includedCredits: '',
    features: Object.fromEntries(catalogue.planFeatures.map((key) => [key, false])),
    isPurchasable: true,
  };
}

/** A form holding a version's values: to edit its draft, or to start one from it. */
export function planFormFrom(version: AdminPlanVersion, catalogue: Catalogue): PlanForm {
  return {
    displayName: version.displayName,
    billingPeriodMonths: asText(version.billingPeriodMonths),
    price: moneyText(version.priceMinor, version.currency),
    currency: version.currency,
    includedCredits: asText(version.monthlyIncludedCredits),
    features: Object.fromEntries(catalogue.planFeatures.map((key) => [key, version.features[key] === true])),
    isPurchasable: version.isPurchasable,
  };
}

function requiredName(value: string, errors: string[]): string {
  if (value.trim() === '') errors.push('Name: enter the name customers will see.');
  return value;
}

function currencyCode(value: string, errors: string[]): string {
  const code = value.trim().toUpperCase();
  if (currencyDigits(code) === null) errors.push('Currency: enter a 3-letter currency code.');
  return code;
}

export function planDraftFromForm(form: PlanForm): Parsed<PlanDraftInput> {
  const errors: string[] = [];
  const displayName = requiredName(form.displayName, errors);
  let billingPeriodMonths: number | null = null;
  if (form.billingPeriodMonths.trim() === '') errors.push('Billing period: choose Monthly, Quarterly or Annual.');
  else billingPeriodMonths = wholeNumber(form.billingPeriodMonths, 'Billing period', errors);
  const currency = currencyCode(form.currency, errors);
  const body = {
    displayName,
    billingPeriodMonths,
    priceMinor: moneyToMinor(form.price, currency, 'Price', errors),
    currency,
    monthlyIncludedCredits: creditCount(form.includedCredits, 'Credits included per billing cycle', errors, { min: 0 }),
    features: { ...form.features },
    isPurchasable: form.isPurchasable,
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body: body as PlanDraftInput };
}

/** A count of Credits (or a position): digits only, said in the admin's words. */
function creditCount(value: string, label: string, errors: string[], rule: { min: number; optional?: boolean }): number | null {
  const typed = value.trim().replace(/,/g, '');
  if (typed === '') {
    if (!rule.optional) errors.push(`${label}: enter a number${rule.min === 0 ? ' (0 for none)' : ''}.`);
    return null;
  }
  if (!/^\d+$/.test(typed) || !Number.isSafeInteger(Number(typed))) {
    errors.push(`${label}: enter a whole number, using digits only.`);
    return null;
  }
  const n = Number(typed);
  if (n < rule.min) {
    errors.push(`${label} must be ${rule.min} or more.`);
    return null;
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * Packs
 * ------------------------------------------------------------------ */

export interface PackForm {
  displayName: string;
  credits: string;
  /** The price as typed: a money amount in `currency`, not minor units. */
  price: string;
  currency: string;
  sortOrder: string;
  isBestValue: boolean;
  isPurchasable: boolean;
  /** Shown on the pack in the store; empty for none. */
  badge: string;
  bonusCredits: string;
  /** The regular price while the price above is promotional, as money; empty for no promotion. */
  regularPrice: string;
  /** A `datetime-local` value, in the operator's own time zone; empty for no end. */
  promotionEndsAt: string;
}

export const EMPTY_PACK_FORM: PackForm = {
  displayName: '',
  credits: '',
  price: '',
  currency: '',
  sortOrder: '',
  isBestValue: false,
  isPurchasable: true,
  badge: '',
  bonusCredits: '',
  regularPrice: '',
  promotionEndsAt: '',
};

/** A new pack's form: empty, in the currency the existing products use. */
export const emptyPackForm = (currency = ''): PackForm => ({ ...EMPTY_PACK_FORM, currency });

/** An instant as a `datetime-local` value in this browser's time zone, to the minute. */
export function localDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value as an ISO instant; empty means no end. */
function promotionEndFrom(value: string, errors: string[]): string | null {
  if (value.trim() === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    errors.push('Promotion ends: choose a date and time.');
    return null;
  }
  return d.toISOString();
}

export function packFormFrom(version: AdminPackVersion): PackForm {
  return {
    displayName: version.displayName,
    credits: asText(version.credits),
    price: moneyText(version.priceMinor, version.currency),
    currency: version.currency,
    sortOrder: asText(version.sortOrder),
    isBestValue: version.isBestValue,
    isPurchasable: version.isPurchasable,
    badge: version.badge ?? '',
    bonusCredits: version.bonusCredits ? asText(version.bonusCredits) : '',
    regularPrice: moneyText(version.wasPriceMinor, version.currency),
    promotionEndsAt: localDateTime(version.promotionEndsAt),
  };
}

export function packDraftFromForm(form: PackForm): Parsed<PackDraftInput> {
  const errors: string[] = [];
  const displayName = requiredName(form.displayName, errors);
  const currency = currencyCode(form.currency, errors);
  const priceMinor = moneyToMinor(form.price, currency, 'Price', errors);
  const wasPriceMinor = moneyToMinor(form.regularPrice, currency, 'Regular price', errors, true);
  if (priceMinor !== null && wasPriceMinor !== null && wasPriceMinor <= priceMinor) {
    errors.push('Regular price must be higher than the price: it is the usual price that the promotion is cheaper than.');
  }
  const promotionEndsAt = promotionEndFrom(form.promotionEndsAt, errors);
  if (promotionEndsAt !== null && form.regularPrice.trim() === '') {
    errors.push('Promotion ends: a promotion needs a regular price. Add one, or clear the end date.');
  }
  const body = {
    displayName,
    credits: creditCount(form.credits, 'Credits', errors, { min: 1 }),
    priceMinor,
    currency,
    sortOrder: creditCount(form.sortOrder, 'Position in the store', errors, { min: 0 }),
    isBestValue: form.isBestValue,
    isPurchasable: form.isPurchasable,
    badge: form.badge.trim() === '' ? null : form.badge.trim(),
    bonusCredits: creditCount(form.bonusCredits, 'Bonus Credits', errors, { min: 0, optional: true }) ?? 0,
    wasPriceMinor,
    promotionEndsAt,
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body: body as PackDraftInput };
}

/* ------------------------------------------------------------------ *
 * The ruleset: action costs, allowances and rewards -- one draft
 * ------------------------------------------------------------------ */

export interface ActionCostRow {
  actionType: string;
  qualityTier: string;
  /** Blank for an action without duration tiers. */
  maxDurationSeconds: string;
  creditCost: string;
  enabled: boolean;
}

export interface RewardRow {
  rewardKey: string;
  credits: string;
  /** Blank means once per user. */
  perUserCap: string;
  enabled: boolean;
}

export interface RulesetForm {
  actionCosts: ActionCostRow[];
  /** One entry per catalogue allowance; blank means not set. */
  allowances: Record<string, string>;
  rewards: RewardRow[];
}

/** An empty ruleset form: no action cost, no reward, every catalogue allowance blank. */
export function emptyRulesetForm(catalogue: Catalogue): RulesetForm {
  return { actionCosts: [], allowances: Object.fromEntries(catalogue.allowances.map((key) => [key, ''])), rewards: [] };
}

/** A form holding a ruleset's values: to edit its draft, or to start one from it. */
export function rulesetFormFrom(ruleset: RulesetDraftInput, catalogue: Catalogue): RulesetForm {
  const allowances: Record<string, string> = Object.fromEntries(catalogue.allowances.map((key) => [key, '']));
  for (const [key, value] of Object.entries(ruleset.allowances)) allowances[key] = asText(value);
  return {
    actionCosts: ruleset.actionCosts.map((c) => ({
      actionType: c.actionType,
      qualityTier: c.qualityTier,
      maxDurationSeconds: asText(c.maxDurationSeconds),
      creditCost: asText(c.creditCost),
      enabled: c.enabled,
    })),
    allowances,
    rewards: ruleset.rewards.map((r) => ({ rewardKey: r.rewardKey, credits: asText(r.credits), perUserCap: asText(r.perUserCap), enabled: r.enabled })),
  };
}

/** A new action-cost row: the first catalogue action and tier, nothing else filled in. */
export function newActionCostRow(catalogue: Catalogue): ActionCostRow {
  return {
    actionType: Object.keys(catalogue.actions)[0] ?? '',
    qualityTier: catalogue.qualityTiers[0] ?? '',
    maxDurationSeconds: '',
    creditCost: '',
    enabled: true,
  };
}
export const NEW_REWARD_ROW: RewardRow = { rewardKey: '', credits: '', perUserCap: '', enabled: true };

/** Whether the catalogue gives an action duration tiers -- read from the server's catalogue. */
export function hasDurationTiers(catalogue: Catalogue, actionType: string): boolean {
  const entry = (catalogue.actions as Record<string, { durationTiers: string } | undefined>)[actionType];
  return entry?.durationTiers === 'required';
}

/** An action's unit, as the server's catalogue states it. */
export function unitOf(catalogue: Catalogue, actionType: string): ActionCostInput['unit'] | null {
  const entry = (catalogue.actions as Record<string, { unit: ActionCostInput['unit'] } | undefined>)[actionType];
  return entry?.unit ?? null;
}

export function rulesetDraftFromForm(form: RulesetForm, catalogue: Catalogue): Parsed<RulesetDraftInput> {
  const errors: string[] = [];
  const actionCosts = form.actionCosts.map((row, i) => {
    const label = `Action cost ${i + 1}`;
    const unit = unitOf(catalogue, row.actionType);
    if (!unit) errors.push(`${label}: choose an action.`);
    return {
      actionType: row.actionType,
      qualityTier: row.qualityTier,
      maxDurationSeconds: wholeNumber(row.maxDurationSeconds, `${label}: maximum duration (seconds)`, errors, true),
      unit,
      creditCost: wholeNumber(row.creditCost, `${label}: Credit cost`, errors),
      enabled: row.enabled,
    };
  });
  const allowances: Record<string, number> = {};
  for (const [key, value] of Object.entries(form.allowances)) {
    const n = wholeNumber(value, `Allowance ${key}`, errors, true);
    if (n !== null) allowances[key] = n;
  }
  const rewards = form.rewards.map((row, i) => {
    const label = `Reward ${i + 1}`;
    return {
      rewardKey: row.rewardKey.trim(),
      credits: wholeNumber(row.credits, `${label}: Credits`, errors),
      perUserCap: wholeNumber(row.perUserCap, `${label}: per-user cap`, errors, true),
      enabled: row.enabled,
    };
  });
  // Every missing unit or required number above recorded an error; the body is only sent without one.
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body: { actionCosts, allowances, rewards } as RulesetDraftInput };
}

/* ------------------------------------------------------------------ *
 * Review and publish
 * ------------------------------------------------------------------ */

export function diffTitle(diff: EconomyDraftDiff, name?: string | null): string {
  const what = whatLabel(diff.kind, name ?? diff.code);
  return diff.liveVersion === null ? `${what}: new (v${diff.draftVersion})` : `${what}: v${diff.liveVersion} → v${diff.draftVersion}`;
}

/** A changed value, as text: absent is an em dash, a structure is compact JSON. */
export function changeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The form's label for each plan and pack field the server reports a change to. */
const CHANGE_LABEL: Record<string, string> = {
  displayName: 'Name',
  billingPeriodMonths: 'Billing period',
  priceMinor: 'Price',
  currency: 'Currency',
  monthlyIncludedCredits: 'Credits included per billing cycle',
  isPurchasable: 'Availability',
  credits: 'Credits',
  sortOrder: 'Position in the store',
  isBestValue: 'Best-value highlight',
  badge: 'Badge',
  bonusCredits: 'Bonus Credits',
  wasPriceMinor: 'Regular price',
  promotionEndsAt: 'Promotion ends',
};

/**
 * One reviewed change, in the words of the form that made it.
 *
 * The server reports a change by its stored field and value. For a plan or a
 * pack that is restated the way the form asked for it: the price as money, the
 * term by name, a feature as included or not. The currency for an amount is the
 * one the server reports in the same diff, else the one given (the item's
 * own). The ruleset's changes, and any field not known here, are shown as the
 * server sent them -- nothing is hidden.
 */
export function describeChange(
  diff: Pick<EconomyDraftDiff, 'kind' | 'changes'>,
  change: EconomyDraftDiff['changes'][number],
  currency: { before: string; after: string } = { before: '', after: '' },
): { label: string; before: string; after: string } {
  const raw = { label: change.field, before: changeValue(change.before), after: changeValue(change.after) };
  if (diff.kind === 'ruleset') return raw;
  const feature = /^features.(.+)$/.exec(change.field);
  const say = (value: unknown, text: (v: never) => string) => (value === null || value === undefined ? '—' : text(value as never));
  if (feature) {
    const included = (v: boolean) => (v ? 'Included' : 'Not included');
    return { label: `Feature: ${featureLabel(feature[1]!)}`, before: say(change.before, included), after: say(change.after, included) };
  }
  const label = CHANGE_LABEL[change.field];
  if (!label) return raw;
  const reported = diff.changes.find((c) => c.field === 'currency');
  const money = (code: unknown, fallback: string) => (v: number) => {
    const use = typeof code === 'string' && code ? code : fallback;
    return currencyDigits(use) === null ? String(v) : `${currencySymbol(use)}${moneyText(v, use)}`;
  };
  const text: Record<string, [(v: never) => string, (v: never) => string] | undefined> = {
    priceMinor: [money(reported?.before, currency.before), money(reported?.after, currency.after)],
    wasPriceMinor: [money(reported?.before, currency.before), money(reported?.after, currency.after)],
    billingPeriodMonths: [billingPeriodLabel, billingPeriodLabel],
    isPurchasable: [availabilityLabel, availabilityLabel],
    isBestValue: [(v: boolean) => (v ? 'Yes' : 'No'), (v: boolean) => (v ? 'Yes' : 'No')],
    promotionEndsAt: [(v: string) => new Date(v).toLocaleString(), (v: string) => new Date(v).toLocaleString()],
  };
  const [before, after] = text[change.field] ?? [changeValue, changeValue];
  return { label, before: say(change.before, before), after: say(change.after, after) };
}

/** The currencies a plan's or pack's amounts are in: the live version's, and the draft's. */
export function diffCurrencies(config: Pick<EconomyConfigurationView, 'plans' | 'packs'>, diff: Pick<EconomyDraftDiff, 'kind' | 'code'>): { before: string; after: string } {
  const item = diff.kind === 'plan' ? config.plans.find((p) => p.code === diff.code) : diff.kind === 'pack' ? config.packs.find((p) => p.code === diff.code) : undefined;
  const versions: ReadonlyArray<Stateful & { currency: string }> = item?.versions ?? [];
  const after = draftOf(versions)?.currency ?? activeOf(versions)?.currency ?? '';
  return { before: activeOf(versions)?.currency ?? after, after };
}

export interface PublishForm {
  reason: string;
  when: 'now' | 'scheduled';
  /** A `datetime-local` value, in the admin's own time zone. */
  scheduledAt: string;
}

export const EMPTY_PUBLISH_FORM: PublishForm = { reason: '', when: 'now', scheduledAt: '' };

/**
 * The publish request. A reason is required; a scheduled time is sent as an
 * ISO instant. Whether it is far enough ahead is the server's to judge.
 */
export function publishRequest(form: PublishForm, draftSetToken: string): Parsed<{ reason: string; effectiveFrom: string | null; draftSetToken: string }> {
  const errors: string[] = [];
  const reason = form.reason.trim();
  if (!reason) errors.push('A reason is required to publish.');
  let effectiveFrom: string | null = null;
  if (form.when === 'scheduled') {
    const at = new Date(form.scheduledAt);
    if (!form.scheduledAt || Number.isNaN(at.getTime())) errors.push('Choose when the drafts take effect.');
    else effectiveFrom = at.toISOString();
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body: { reason, effectiveFrom, draftSetToken } };
}

/**
 * The server's rules, in the words of the form.
 *
 * The server names the FIELD it refused ("priceMinor must be a positive whole
 * number of minor units."), which is exact and meaningless to the person who
 * typed a price. Each known refusal is restated against the label that person
 * can see. THE RULE IS STILL THE SERVER'S: this changes the wording, never
 * whether something is allowed, and a message it does not recognise is shown
 * exactly as it came, so nothing the server says is ever hidden.
 */
const SERVER_WORDING: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/^displayName must be/, () => 'Name: enter a name of up to 120 characters.'],
  [/^billingPeriodMonths must be/, () => 'Billing period: choose Monthly, Quarterly or Annual.'],
  [/^priceMinor must be/, () => 'Price must be more than zero.'],
  [/^currency must be/, () => 'Currency: enter a 3-letter currency code.'],
  [/^monthlyIncludedCredits must be/, () => 'Credits included per billing cycle: enter a whole number, 0 or more.'],
  [/^isPurchasable must be/, () => 'Choose whether this is on sale or retired.'],
  [/^isBestValue must be/, () => 'Choose whether this pack is marked as best value.'],
  [/^features must be/, () => 'Included features could not be read. Reload the page and try again.'],
  [/^features\.(\w+) is not a catalogue feature/, (m) => `"${featureLabel(m[1]!)}" is not a feature this system offers. Reload the page and try again.`],
  [/^features\.(\w+) must be true or false/, (m) => `Included features: choose whether "${featureLabel(m[1]!)}" is included.`],
  [
    /^features\.(\w+) must be stated before publishing/,
    (m) => `A plan must say whether "${featureLabel(m[1]!)}" is included before it can be published. Open the plan's draft and save it.`,
  ],
  [/^credits must be/, () => 'Credits: enter a whole number of 1 or more.'],
  [/^sortOrder must be/, () => 'Position in the store: enter a whole number, 0 or more.'],
  [/^badge must be/, () => 'Badge: use up to 40 characters, or leave it empty.'],
  [/^bonusCredits must be/, () => 'Bonus Credits: enter a whole number, 0 or more, or leave it empty.'],
  [/^wasPriceMinor must be a positive/, () => 'Regular price must be more than zero.'],
  [
    /^wasPriceMinor must be higher than priceMinor/,
    () => 'Regular price must be higher than the price: it is the usual price that the promotion is cheaper than.',
  ],
  [/^promotionEndsAt must be/, () => 'Promotion ends: choose a date and time.'],
  [/^promotionEndsAt needs a wasPriceMinor/, () => 'Promotion ends: a promotion needs a regular price. Add one, or clear the end date.'],
  [/^".*" is not a valid code/, () => 'The internal ID for this item could not be created from its name. Use a name that contains letters.'],
];

/** One server message in the form's words; unchanged when it is not one of the known refusals. */
export function adminWording(message: string): string {
  // The request-shape check names the field as `body/<field>`; say which form field that is.
  const shape = /^body\/(\w+) must /.exec(message);
  const field = shape && CHANGE_LABEL[shape[1]!];
  if (field) return `${field}: the value entered is not valid. Check it and try again.`;
  for (const [pattern, say] of SERVER_WORDING) {
    const match = pattern.exec(message);
    if (match) return say(match);
  }
  return message;
}

/** The server's messages for a failed request, in the form's words, or one plain sentence. */
export function serverMessages(error: unknown): string[] {
  if (error instanceof ApiRequestError) {
    const messages = (error.details as { messages?: unknown } | null)?.messages;
    if (Array.isArray(messages) && messages.length > 0 && messages.every((m) => typeof m === 'string')) {
      return [...new Set((messages as string[]).map(adminWording))];
    }
    if (error.status === 401) return ['Your session has ended. Sign in again.'];
    return [adminWording(error.message)];
  }
  return ['The request could not be completed. Try again.'];
}

/** True when the server refused because the drafts changed after the review. */
export const draftsChanged = (error: unknown) => error instanceof ApiRequestError && error.code === 'drafts_changed';
