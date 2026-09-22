/**
 * Economy configuration -- the key catalogue and the admin wire types (P1).
 *
 * The catalogue fixes which KEYS a configuration may use; it never fixes a
 * VALUE. Every price, cost, grant and allowance is an admin-entered number,
 * published through the draft -> review -> publish workflow.
 */

/* ------------------------------------------------------------------ *
 * The key catalogue (PRD v1.2 §8, §9, §31)
 * ------------------------------------------------------------------ */

/**
 * Plan features: structured machine-readable rules (PRD §9 Premium benefits),
 * never customer-facing text. A published plan states every flag explicitly.
 */
export const PLAN_FEATURE_KEYS = [
  'unlimited_text',
  'full_character_access',
  'advanced_media_access',
  'voice_access',
] as const;
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];
export type PlanFeatures = Record<PlanFeatureKey, boolean>;

export const ECONOMY_QUALITY_TIERS = ['standard', 'high'] as const;
export type EconomyQualityTier = (typeof ECONOMY_QUALITY_TIERS)[number];

/**
 * The action types a ruleset may price (PRD §8), with the unit each is priced
 * in and whether its costs are split into duration tiers. Locked photos and
 * videos are priced per asset (the commercial boundary), not here.
 */
export const ECONOMY_ACTION_CATALOGUE = {
  image: { unit: 'per_action', durationTiers: 'forbidden' },
  voice_message: { unit: 'per_action', durationTiers: 'forbidden' },
  voice_call: { unit: 'per_minute', durationTiers: 'forbidden' },
  video: { unit: 'per_action', durationTiers: 'required' },
} as const satisfies Record<string, { unit: 'per_action' | 'per_minute'; durationTiers: 'required' | 'forbidden' }>;
export type EconomyActionType = keyof typeof ECONOMY_ACTION_CATALOGUE;
export const ECONOMY_ACTION_TYPES = Object.keys(ECONOMY_ACTION_CATALOGUE) as EconomyActionType[];

/** The allowances every published ruleset must define (PRD §8, §31). */
export const ECONOMY_ALLOWANCE_KEYS = [
  'free_first_conversation_messages',
  'free_daily_messages',
  'signup_grant_credits',
  'grace_period_days',
  'reward_monthly_cap_credits',
] as const;
export type EconomyAllowanceKey = (typeof ECONOMY_ALLOWANCE_KEYS)[number];

/* ------------------------------------------------------------------ *
 * Draft inputs (admin -> server)
 * ------------------------------------------------------------------ */

export interface PlanDraftInput {
  displayName: string;
  billingPeriodMonths: number;
  priceMinor: number;
  currency: string;
  monthlyIncludedCredits: number;
  features: Partial<Record<PlanFeatureKey, boolean>>;
  /** False retires the plan: still in effect for existing subscribers, not offered. */
  isPurchasable: boolean;
}

export interface PackDraftInput {
  displayName: string;
  credits: number;
  priceMinor: number;
  currency: string;
  sortOrder: number;
  isBestValue: boolean;
  isPurchasable: boolean;
}

export interface ActionCostInput {
  actionType: string;
  qualityTier: string;
  maxDurationSeconds: number | null;
  unit: 'per_action' | 'per_minute';
  creditCost: number;
  enabled: boolean;
}

export interface RewardInput {
  rewardKey: string;
  credits: number;
  perUserCap: number | null;
  enabled: boolean;
}

export interface RulesetDraftInput {
  actionCosts: ActionCostInput[];
  allowances: Record<string, number>;
  rewards: RewardInput[];
}

/* ------------------------------------------------------------------ *
 * Admin views (server -> admin)
 * ------------------------------------------------------------------ */

/**
 * Where a version stands at the database clock's "now". `scheduled`,
 * `active` and `superseded` are derived from `effectiveFrom`; only `draft`,
 * published and `cancelled` are stored.
 */
export type EconomyVersionState = 'draft' | 'scheduled' | 'active' | 'superseded' | 'cancelled';

export interface EconomyVersionMeta {
  id: string;
  version: number;
  state: EconomyVersionState;
  effectiveFrom: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  publishReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
}

export type AdminPlanVersion = EconomyVersionMeta &
  Omit<PlanDraftInput, 'features'> & {
    /** As stored. A published version carries exactly the catalogue flags. */
    features: Record<string, unknown>;
  };
export type AdminPackVersion = EconomyVersionMeta & PackDraftInput;
export type AdminRulesetVersion = EconomyVersionMeta & RulesetDraftInput;

export interface EconomyConfigurationView {
  /** The database instant the states were derived at. */
  asOf: string;
  plans: Array<{ code: string; versions: AdminPlanVersion[] }>;
  packs: Array<{ code: string; versions: AdminPackVersion[] }>;
  rulesets: AdminRulesetVersion[];
  catalogue: {
    planFeatures: readonly PlanFeatureKey[];
    qualityTiers: readonly EconomyQualityTier[];
    actions: typeof ECONOMY_ACTION_CATALOGUE;
    allowances: readonly EconomyAllowanceKey[];
  };
}

/** One changed value: what is live now, and what the draft would make it. */
export interface EconomyFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface EconomyDraftDiff {
  kind: 'plan' | 'pack' | 'ruleset';
  /** The plan or pack code; null for the ruleset. */
  code: string | null;
  draftVersion: number;
  /** The version the draft would supersede, or null when there is none live. */
  liveVersion: number | null;
  changes: EconomyFieldChange[];
}

export interface EconomyPublishReview {
  asOf: string;
  /** Pass back to publish: it fails if any draft changed after this review. */
  draftSetToken: string;
  diff: EconomyDraftDiff[];
  /** Blocking: while any exist, publishing is refused. */
  errors: string[];
  /** Shown, never blocking (PRD §31: the margin guard warns, it does not block). */
  warnings: string[];
}

export interface EconomyPublishResult {
  published: Array<{ kind: 'plan' | 'pack' | 'ruleset'; code: string | null; id: string; version: number; effectiveFrom: string }>;
}
