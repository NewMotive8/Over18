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
 * and back, and nothing more: they check only that a number field holds a
 * whole number. Every range, the catalogue, completeness and publishability
 * are the server's -- its messages are shown as they come. The vocabulary
 * (feature flags, action types, tiers, allowance keys) is read from the
 * catalogue the server sends, never from a copy here. No value is pre-filled.
 */

export type Catalogue = EconomyConfigurationView['catalogue'];

/* ------------------------------------------------------------------ *
 * Versions
 * ------------------------------------------------------------------ */

export const STATE_LABEL: Record<EconomyVersionState, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  active: 'Active',
  superseded: 'Superseded',
  cancelled: 'Cancelled',
};

type Stateful = { state: EconomyVersionState };
export const draftOf = <V extends Stateful>(versions: readonly V[]): V | null => versions.find((v) => v.state === 'draft') ?? null;
export const activeOf = <V extends Stateful>(versions: readonly V[]): V | null => versions.find((v) => v.state === 'active') ?? null;

export interface VersionRow {
  kind: 'plan' | 'pack' | 'ruleset';
  code: string | null;
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
 * Plans
 * ------------------------------------------------------------------ */

export interface PlanForm {
  displayName: string;
  billingPeriodMonths: string;
  priceMinor: string;
  currency: string;
  monthlyIncludedCredits: string;
  /** One entry per catalogue flag: a checkbox always states true or false. */
  features: Record<string, boolean>;
  isPurchasable: boolean;
}

/** A new plan's form: every field empty, every catalogue flag unticked. */
export function emptyPlanForm(catalogue: Catalogue): PlanForm {
  return {
    displayName: '',
    billingPeriodMonths: '',
    priceMinor: '',
    currency: '',
    monthlyIncludedCredits: '',
    features: Object.fromEntries(catalogue.planFeatures.map((key) => [key, false])),
    isPurchasable: true,
  };
}

/** A form holding a version's values: to edit its draft, or to start one from it. */
export function planFormFrom(version: AdminPlanVersion, catalogue: Catalogue): PlanForm {
  return {
    displayName: version.displayName,
    billingPeriodMonths: asText(version.billingPeriodMonths),
    priceMinor: asText(version.priceMinor),
    currency: version.currency,
    monthlyIncludedCredits: asText(version.monthlyIncludedCredits),
    features: Object.fromEntries(catalogue.planFeatures.map((key) => [key, version.features[key] === true])),
    isPurchasable: version.isPurchasable,
  };
}

export function planDraftFromForm(form: PlanForm): Parsed<PlanDraftInput> {
  const errors: string[] = [];
  const body = {
    displayName: form.displayName,
    billingPeriodMonths: wholeNumber(form.billingPeriodMonths, 'Billing period (months)', errors),
    priceMinor: wholeNumber(form.priceMinor, 'Price (minor units)', errors),
    currency: form.currency.trim(),
    monthlyIncludedCredits: wholeNumber(form.monthlyIncludedCredits, 'Monthly included Credits', errors),
    features: { ...form.features },
    isPurchasable: form.isPurchasable,
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body: body as PlanDraftInput };
}

/* ------------------------------------------------------------------ *
 * Packs
 * ------------------------------------------------------------------ */

export interface PackForm {
  displayName: string;
  credits: string;
  priceMinor: string;
  currency: string;
  sortOrder: string;
  isBestValue: boolean;
  isPurchasable: boolean;
}

export const EMPTY_PACK_FORM: PackForm = {
  displayName: '',
  credits: '',
  priceMinor: '',
  currency: '',
  sortOrder: '',
  isBestValue: false,
  isPurchasable: true,
};

export function packFormFrom(version: AdminPackVersion): PackForm {
  return {
    displayName: version.displayName,
    credits: asText(version.credits),
    priceMinor: asText(version.priceMinor),
    currency: version.currency,
    sortOrder: asText(version.sortOrder),
    isBestValue: version.isBestValue,
    isPurchasable: version.isPurchasable,
  };
}

export function packDraftFromForm(form: PackForm): Parsed<PackDraftInput> {
  const errors: string[] = [];
  const body = {
    displayName: form.displayName,
    credits: wholeNumber(form.credits, 'Credits', errors),
    priceMinor: wholeNumber(form.priceMinor, 'Price (minor units)', errors),
    currency: form.currency.trim(),
    sortOrder: wholeNumber(form.sortOrder, 'Ladder position', errors),
    isBestValue: form.isBestValue,
    isPurchasable: form.isPurchasable,
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

export function diffTitle(diff: EconomyDraftDiff): string {
  const what = diff.kind === 'ruleset' ? 'Ruleset' : `${diff.kind === 'plan' ? 'Plan' : 'Pack'} ${diff.code}`;
  return diff.liveVersion === null ? `${what}: new (v${diff.draftVersion})` : `${what}: v${diff.liveVersion} → v${diff.draftVersion}`;
}

/** A changed value, as text: absent is an em dash, a structure is compact JSON. */
export function changeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
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

/** The server's own messages for a failed request, or one plain sentence. */
export function serverMessages(error: unknown): string[] {
  if (error instanceof ApiRequestError) {
    const messages = (error.details as { messages?: unknown } | null)?.messages;
    if (Array.isArray(messages) && messages.length > 0 && messages.every((m) => typeof m === 'string')) return messages;
    if (error.status === 401) return ['Your session has ended. Sign in again.'];
    return [error.message];
  }
  return ['The request could not be completed. Try again.'];
}

/** True when the server refused because the drafts changed after the review. */
export const draftsChanged = (error: unknown) => error instanceof ApiRequestError && error.code === 'drafts_changed';
