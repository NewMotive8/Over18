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
 * The customer economy read API
 * ------------------------------------------------------------------ */

/**
 * What every customer economy endpoint answers, with HTTP 503, while the
 * economy is switched off. Clients render their pending/unavailable state and
 * show nothing paid; the body carries no price, balance or plan.
 */
export interface EconomyUnavailableResponse {
  error: 'economy_unavailable';
  reason: 'economy_disabled';
  message: string;
}

/**
 * A published plan version in effect now, as a customer may see it.
 * `code` is the plan's stable identity; `versionId` names the exact
 * configuration row, which is what a later checkout must pin rather than
 * re-resolving by time. Plan `features` are machine rules for the server's
 * entitlement decisions and are deliberately not part of this view.
 */
export interface CustomerPlanOffer {
  code: string;
  version: number;
  versionId: string;
  displayName: string;
  billingPeriodMonths: number;
  priceMinor: number;
  currency: string;
  monthlyIncludedCredits: number;
  /** False for a retired plan: still in effect, but not offered. */
  isPurchasable: boolean;
  /** ISO 8601, microsecond precision, UTC. */
  effectiveFrom: string;
}

/** A published Credit pack version in effect now, in ladder order. */
export interface CustomerPackOffer {
  code: string;
  version: number;
  versionId: string;
  displayName: string;
  credits: number;
  priceMinor: number;
  currency: string;
  sortOrder: number;
  isBestValue: boolean;
  isPurchasable: boolean;
  effectiveFrom: string;
}

/** GET /api/economy/catalog: the published, in-effect catalog. */
export interface CustomerEconomyCatalog {
  /** The database instant the catalog was resolved at. */
  asOf: string;
  plans: CustomerPlanOffer[];
  packs: CustomerPackOffer[];
}

/**
 * A commercial fact the backend cannot state with authority -- because nothing
 * persists it yet, or because what is stored cannot be resolved safely (a
 * subscription naming a plan version that is not published; Credit classes
 * that do not reconcile). Stated as absent, never as a placeholder value, and
 * never as Premium.
 */
export interface CommercialFactUnavailable {
  available: false;
  reason:
    | 'subscriptions_not_supported'
    | 'wallet_not_supported'
    | 'age_verification_not_supported'
    | 'subscription_unresolvable'
    | 'wallet_unresolvable';
}

/**
 * GET /api/me/commercial-state: the signed-in customer's commercial state, to
 * the extent the backend holds authoritative data for it. Each fact is either
 * `{ available: true, value }` or an explicit `CommercialFactUnavailable`.
 */
export interface CustomerCommercialState {
  viewer: { userId: string };
  economyEnabled: true;
  tier: { available: true; value: CommercialTier } | CommercialFactUnavailable;
  subscription: { available: true; value: CommercialSubscription | null } | CommercialFactUnavailable;
  wallet: { available: true; value: CommercialWallet } | CommercialFactUnavailable;
  age: { available: true; value: CommercialAgeStatus } | CommercialFactUnavailable;
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
  /**
   * P2.5.2: suspend or reactivate a customer account, with a reason.
   * Administrator only: no other role lists it.
   */
  'users.status.manage',
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

/* ------------------------------------------------------------------ *
 * Admin wallet support (P2.4, PRD §16, §18, §34)
 * ------------------------------------------------------------------ */

export type WalletCreditClass = 'included' | 'earned' | 'purchased';
export type WalletDirection = 'credit' | 'debit';
export type WalletEntryType =
  | 'grant'
  | 'reward'
  | 'purchase'
  | 'paid_action'
  | 'refund'
  | 'reversal'
  | 'admin_adjustment'
  | 'hold'
  | 'capture'
  | 'release';

/** The account being supported: enough to confirm it is the right one, nothing more. */
export interface AdminWalletUser {
  id: string;
  email: string;
  createdAt: string;
}

/** One currency's wallet. `exists: false` means the user has none yet; every figure is then zero. */
export interface AdminWalletSummary {
  currency: string;
  exists: boolean;
  /** Spendable Credits. */
  balance: number;
  /** Credits held for actions in flight; not spendable. */
  held: number;
  /** Transactions applied. */
  version: number;
  classes: Record<WalletCreditClass, { spendable: number; held: number }>;
}

export interface AdminAdjustmentLimit {
  cap: number;
  used: number;
  remaining: number;
}

/** The signed-in operator's own daily adjustment limits in one currency (UTC day). */
export interface AdminAdjustmentAllowance {
  currency: string;
  credit: AdminAdjustmentLimit;
  debit: AdminAdjustmentLimit;
}

/** GET /admin/users/:userId/wallets */
export interface AdminUserWallets {
  user: AdminWalletUser;
  /** While false, every adjustment is refused; reading is unaffected. */
  economyEnabled: boolean;
  wallets: AdminWalletSummary[];
  allowances: AdminAdjustmentAllowance[];
}

/** One ledger transaction, as support sees it. Read-only. */
export interface AdminWalletTransaction {
  id: string;
  sequence: number;
  entryType: WalletEntryType;
  direction: WalletDirection;
  amount: number;
  creditClass: WalletCreditClass;
  balanceAfter: number;
  heldAfter: number;
  relatedTransactionId: string | null;
  source: { type: string; id: string } | null;
  reason: string | null;
  actorUserId: string | null;
  createdAt: string;
}

/** GET /admin/users/:userId/wallets/:currency/transactions -- newest first. */
export interface AdminWalletHistory {
  currency: string;
  transactions: AdminWalletTransaction[];
  /** Pass as `before` for the next, older page; null at the start of the history. */
  nextBefore: number | null;
}

/** POST /admin/users/:userId/wallets/:currency/adjustments */
export interface AdminWalletAdjustmentRequest {
  direction: WalletDirection;
  amount: number;
  reason: string;
  /** An optional support reference (e.g. a ticket id), recorded as the transaction's source. */
  reference?: string | null;
  /** One per intended adjustment: a retry with the same key applies once. */
  idempotencyKey: string;
}

export interface AdminWalletAdjustmentResult {
  transaction: AdminWalletTransaction;
  /** True when this key had already been applied: nothing new was written. */
  replayed: boolean;
  wallet: AdminWalletSummary;
  allowance: AdminAdjustmentAllowance;
}

/* ------------------------------------------------------------------ *
 * Admin users read model (P2.5.1)
 * ------------------------------------------------------------------ */

/** `users.role`: authorization, never a commercial tier. `admin` is staff. */
export type AdminUserAccountRole = 'user' | 'admin';

/**
 * `users.status` (P2.5.2): whether the account may sign in and use its
 * sessions. Nothing commercial -- a suspended customer keeps their
 * subscription, wallet and entitlements untouched.
 */
export const ACCOUNT_STATUSES = ['active', 'suspended'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Whether THIS operator may change this account's status, decided by the
 * server: only a customer account, never one's own, and only with
 * `users.status.manage`.
 */
export type AdminAccountStatusChange =
  | { allowed: true }
  | { allowed: false; reason: 'own_account' | 'staff_account' | 'permission_required' };

/**
 * POST /admin/users/:userId/status. A compare-and-set: `expectedStatus` is the
 * status the operator saw, and the change is refused (409 `status_conflict`)
 * if the account is no longer in it.
 */
export interface AdminAccountStatusChangeRequest {
  status: AccountStatus;
  expectedStatus: AccountStatus;
  reason: string;
}

export interface AdminAccountStatusChangeResult {
  userId: string;
  previousStatus: AccountStatus;
  status: AccountStatus;
  /** ISO 8601, microsecond precision, UTC -- the account's new `updatedAt`. */
  changedAt: string;
  /** Sessions ended by a suspension; 0 for a reactivation. */
  revokedSessions: number;
}

/** One row of GET /admin/users. */
export interface AdminUserListItem {
  id: string;
  email: string;
  role: AdminUserAccountRole;
  status: AccountStatus;
  /** Staff roles granted, in the §34.1 order of `ADMIN_ROLES`; empty for a customer. */
  staffRoles: AdminRoleName[];
  /** ISO 8601, microsecond precision, UTC. */
  createdAt: string;
  /** The most recent session started, or null if they never signed in. */
  lastSignInAt: string | null;
}

/** GET /admin/users -- newest accounts first. */
export interface AdminUserList {
  users: AdminUserListItem[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

/** One wallet in the P0 `CommercialWallet` terms, from the P2.4 wallet read model. */
export interface AdminUserWallet {
  currency: string;
  /** False when the user has no wallet in this currency: every figure is then zero. */
  exists: boolean;
  included: number;
  earned: number;
  purchased: number;
  /** Reserved for in-flight actions; not part of `spendable`. */
  held: number;
  spendable: number;
  transactions: number;
}

/** GET /admin/users/:userId -- a consolidated, read-only view of one user. */
export interface AdminUserDetail {
  identity: { id: string; email: string };
  account: {
    role: AdminUserAccountRole;
    staffRoles: Array<{ role: AdminRoleName; grantedAt: string; grantedBy: string | null }>;
    createdAt: string;
    updatedAt: string;
    status: AccountStatus;
    statusChange: AdminAccountStatusChange;
  };
  activity: {
    lastSignInAt: string | null;
    /** Sessions not yet expired. */
    activeSessions: number;
    conversations: number;
    /** When any of their conversations last changed, e.g. by a message. */
    lastConversationAt: string | null;
  };
  /** From the P3.1 commercial-state resolver -- the same facts the customer is told. */
  commercial: {
    /** Whether the economy is switched on. The facts are resolved either way. */
    economyEnabled: boolean;
    tier: CustomerCommercialState['tier'];
    subscription: CustomerCommercialState['subscription'];
    age: CustomerCommercialState['age'];
  };
  wallets: AdminUserWallet[];
  /** Recent audit entries concerning this user -- only for an operator holding `audit.read`. */
  audit: { available: true; entries: AuditEntryView[] } | { available: false; reason: 'audit_read_required' };
}
