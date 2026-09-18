/**
 * Subscription & App Economy -- wire types shared by the API and the web app.
 *
 * PRD v1.2, build step 0b. Nothing here carries a price, a cost or an
 * allowance: those are server configuration (PRD §20) and arrive as data in
 * later phases. What is fixed in code is only the SHAPE a client may rely on.
 */

/* ------------------------------------------------------------------ *
 * The entitlement resolver's answer (PRD §18)
 * ------------------------------------------------------------------ */

export type CommercialTier = 'free' | 'premium';

export type SubscriptionStatus = 'active' | 'past_due' | 'grace' | 'cancelled' | 'expired';

export interface CommercialSubscription {
  status: SubscriptionStatus;
  planCode: string;
  /** ISO 8601. */
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

/**
 * Credits by class. The three classes stay distinguishable because they may
 * carry different expiry and refund treatment (PRD §6.3, §18). `held` is
 * reserved for in-flight paid actions and is NOT part of `spendable`.
 */
export interface CommercialWallet {
  included: number;
  earned: number;
  purchased: number;
  held: number;
  spendable: number;
}

export interface CommercialAgeStatus {
  verified: boolean;
  /** ISO 8601, or null when unverified. */
  expiresAt: string | null;
}

/**
 * A user's complete commercial state, from ONE function.
 *
 * Every gated route consults the resolver that produces this; no route derives
 * entitlement for itself (PRD §18). The client renders it and enforces nothing
 * (PRD §5, §19.1).
 */
export interface CommercialState {
  viewer: 'anonymous' | 'user';
  tier: CommercialTier;
  subscription: CommercialSubscription | null;
  wallet: CommercialWallet;
  age: CommercialAgeStatus;
  /** False until the economy is switched on; clients must show nothing paid. */
  economyEnabled: boolean;
}

/* ------------------------------------------------------------------ *
 * Analytics event catalogue (PRD §23)
 * ------------------------------------------------------------------ */

/**
 * The only event names that may be emitted. A typo becomes a compile error
 * rather than a silently empty funnel step.
 */
export const ANALYTICS_EVENT_NAMES = [
  'paywall_viewed',
  'subscription_cta_clicked',
  'subscription_started',
  'free_limit_reached',
  'credit_balance_viewed',
  'credit_purchase_viewed',
  'credit_purchase_started',
  'credit_purchase_completed',
  'credit_spend',
  'locked_content_viewed',
  'locked_content_unlocked',
  'reward_earned',
  'paywall_dismissed',
  'grant_exhausted',
  'spend_refunded',
  'age_verification_started',
  'age_verification_completed',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export function isAnalyticsEventName(value: string): value is AnalyticsEventName {
  return (ANALYTICS_EVENT_NAMES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Admin roles and permissions (PRD §34.1)
 * ------------------------------------------------------------------ */

export const ADMIN_ROLES = [
  'administrator',
  'economy_editor',
  'content_editor',
  'marketing',
  'support',
  'analyst',
] as const;

export type AdminRoleName = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMISSIONS = [
  /** §31: plans, packs, action costs, allowances, rewards. */
  'economy.manage',
  /** §32: per-asset access states and Credit prices. */
  'access.manage',
  /** §34.1 content editor: approval and content ratings. */
  'content.review',
  /** §33: campaigns, slots, scheduling, audiences. */
  'promotions.manage',
  /** §34.1 support: read a user's entitlement and ledger. */
  'users.commercial.read',
  /** §34.1 support: a capped goodwill Credit adjustment, with a reason. */
  'users.credits.adjust',
  /** §34.1 analyst: read and export everything in §23. */
  'analytics.read',
  'analytics.export',
  /** §34.2: the audit log. Administrator only until decided otherwise. */
  'audit.read',
  'audit.export',
  /** §34.1: role assignment. Administrator only, by definition. */
  'roles.manage',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/**
 * §34.1 as data. The "Cannot" column is expressed by absence: a role holds
 * exactly the permissions listed and nothing else.
 */
export const ADMIN_ROLE_PERMISSIONS: Readonly<Record<AdminRoleName, readonly AdminPermission[]>> = {
  administrator: ADMIN_PERMISSIONS,
  economy_editor: ['economy.manage'],
  content_editor: ['content.review', 'access.manage'],
  marketing: ['promotions.manage'],
  support: ['users.commercial.read', 'users.credits.adjust'],
  analyst: ['analytics.read', 'analytics.export'],
};

/** What the admin shell needs to decide which sections to show. */
export interface AdminAccessView {
  roles: AdminRoleName[];
  /**
   * EFFECTIVE permissions. While enforcement is off every staff member
   * effectively holds all of them, and this says so -- the navigation must not
   * hide what the server would allow.
   */
  permissions: AdminPermission[];
  enforced: boolean;
  features: {
    auditLog: boolean;
  };
}

export interface AuditEntryView {
  id: number;
  occurredAt: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
}
