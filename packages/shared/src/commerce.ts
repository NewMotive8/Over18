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
 * Credits by class. The classes stay distinguishable because they may carry
 * different expiry and refund treatment (PRD §6.3, §18); a customer is shown
 * one total, `spendable`. `included` is the subscription's allowance; `bonus`
 * is given on top of a purchase or as a promotion. `held` is reserved for
 * in-flight paid actions and is NOT part of `spendable`.
 */
export interface CommercialWallet {
  included: number;
  earned: number;
  purchased: number;
  bonus: number;
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
  /** The store's label for the pack ("Best value"), as configured; null for none. */
  badge: string | null;
  /** Credits given on top of `credits`; 0 for none. */
  bonusCredits: number;
  /** `credits + bonusCredits`: what the customer receives. */
  totalCredits: number;
  /**
   * The regular price, ONLY while a promotion is in effect at `asOf`, so the
   * store can strike it through; `priceMinor` is then the promotional price.
   * Null when there is no promotion or it has ended -- and once it has ended,
   * `priceMinor` IS the regular price.
   */
  wasPriceMinor: number | null;
  /** When the promotion in effect ends; null when there is none, or it has no end. */
  promotionEndsAt: string | null;
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
 * Managing one's own subscription (GET/POST /api/me/subscription)
 * ------------------------------------------------------------------ */

/**
 * The plan a subscriber actually holds: the EXACT version their subscription
 * names, not whatever the catalogue offers under that code today. A retired
 * plan still describes itself here, which the catalogue cannot do -- it offers
 * only purchasable plans, so a subscriber on a withdrawn plan would otherwise
 * be shown nothing at all.
 */
export interface CustomerSubscriptionPlan {
  code: string;
  version: number;
  displayName: string;
  priceMinor: number;
  currency: string;
  billingPeriodMonths: number;
  monthlyIncludedCredits: number;
  /** False once this version is no longer the published one in effect. */
  live: boolean;
}

/** What the subscriber last actually paid, from the payment record itself. */
export interface CustomerSubscriptionPayment {
  amountMinor: number;
  currency: string;
  /** When it settled. ISO 8601. */
  paidAt: string;
}

/**
 * A subscriber's own subscription, for managing it.
 *
 * THERE IS NO NEXT BILLING DATE, and this type deliberately offers no field for
 * one. Nothing in the system renews a subscription (see the API's
 * subscription-service and payment-service): `currentPeriodEnd` is when Premium
 * lapses, not when it bills again. Inventing a renewal date here would be
 * promising a charge that nothing makes.
 */
export interface CustomerSubscriptionDetail {
  plan: CustomerSubscriptionPlan;
  /** As the customer is told it: cancelled past its period end reads as expired. */
  status: SubscriptionStatus;
  /** ISO 8601 -- when the paid period ends. */
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  /** When the current subscription began, from its own recorded history. Null when unrecorded. */
  startedAt: string | null;
  /** The most recent settled subscription payment, or null when none is recorded. */
  lastPayment: CustomerSubscriptionPayment | null;
  /** Whether cancelling is available now -- the server's answer, never the page's guess. */
  canCancel: boolean;
}

/** GET /api/me/subscription -- `subscription` is null when there is none. */
export interface CustomerSubscriptionResponse {
  subscription: CustomerSubscriptionDetail | null;
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
  /**
   * A Credit pack payment the provider declined, or the customer cancelled
   * (PR 3). No other name can say it: `completed` would be false and
   * `spend_refunded` is about spending. Never emitted with `completed`.
   */
  'credit_purchase_failed',
  'credit_spend',
  'locked_content_viewed',
  'locked_content_unlocked',
  /**
   * A piece of her content actually watched or looked at, reported by the
   * server that served the bytes.
   *
   * `locked_content_viewed` is NOT this and cannot replace it: that one is a
   * browser reporting a LOCKED tile appearing on one tab, which says what was
   * advertised to someone, never what they watched. This is the engagement
   * signal -- the only record that a given person saw a given clip.
   *
   * SERVER-ONLY, deliberately. A browser claiming a view could inflate any
   * character's popularity at will, so this is absent from
   * `ANALYTICS_CLIENT_EVENTS` exactly as purchases and spends are.
   */
  'content_viewed',
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

/**
 * The events a BROWSER may report (PR 3): only what the server cannot see for
 * itself -- a screen shown, a button pressed, a sheet dismissed. Purchases,
 * spends and unlocks are reported by the server where they commit, and a
 * client claiming one is refused, so a browser can never fake a conversion.
 */
export const ANALYTICS_CLIENT_EVENTS = [
  'paywall_viewed',
  'subscription_cta_clicked',
  'paywall_dismissed',
  'credit_purchase_viewed',
  'locked_content_viewed',
] as const satisfies readonly AnalyticsEventName[];
export type AnalyticsClientEventName = (typeof ANALYTICS_CLIENT_EVENTS)[number];

export function isAnalyticsClientEvent(value: string): value is AnalyticsClientEventName {
  return (ANALYTICS_CLIENT_EVENTS as readonly string[]).includes(value);
}

/**
 * What one property may hold: an id, a short code from a fixed vocabulary, a
 * whole number, a boolean, or one value of a fixed list. Never free text --
 * which is how an email or a message could never ride along in an event.
 */
export type AnalyticsPropertyKind = 'id' | 'code' | 'int' | 'bool' | readonly string[];

/* ---- the funnels (GET /admin/analytics/funnels) ---- */

export interface AnalyticsFunnelStep {
  /** The event this step counts, and the filter on it, said plainly. */
  label: string;
  /** People who reached this step after every earlier one, within the window. */
  users: number;
}
export interface AnalyticsFunnel {
  key: 'free_to_premium' | 'free_to_credit_purchase' | 'locked_content_to_unlock' | 'purchase_to_spend';
  title: string;
  steps: AnalyticsFunnelStep[];
}
export interface AnalyticsFunnelsView {
  from: string;
  to: string;
  funnels: AnalyticsFunnel[];
  /** Every event in the window by name, signed in or not. */
  eventCounts: Record<string, number>;
  /** Credit pack payments that failed or were cancelled in the window. */
  failedCreditPurchases: number;
  /** Whether ANALYTICS_ENABLED is on now. Off: nothing new is being recorded. */
  recording: boolean;
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
  /**
   * P3.5: assign, change, cancel or end one user's subscription, with a
   * reason. Administrator only: no other role lists it. (Editing the plan
   * catalogue itself is economy.manage.)
   */
  'users.subscription.manage',
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

export type WalletCreditClass = 'included' | 'earned' | 'purchased' | 'bonus';
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
  bonus: number;
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

/* ------------------------------------------------------------------ *
 * Admin user subscription management (P3.5)
 * ------------------------------------------------------------------ */

/**
 * What an operator can do to one user's subscription, in the P3.1 states:
 *   assign       no subscription, or an expired one -> active on a plan, for one
 *                billing period of that plan from now;
 *   change_plan  a current subscription moves to another plan now; its status
 *                and period end stay as they are (no proration is defined);
 *   cancel       -> cancelled: Premium continues to the period end, then expires;
 *   end          -> expired now.
 */
export const ADMIN_SUBSCRIPTION_ACTIONS = ['assign', 'change_plan', 'cancel', 'end'] as const;
export type AdminSubscriptionAction = (typeof ADMIN_SUBSCRIPTION_ACTIONS)[number];

/**
 * WHO MADE A RECORDED CHANGE.
 *
 *   admin     an operator acted, and the history names them;
 *   payment   a provider's confirmed payment did, and names the payment;
 *   customer  the subscriber acted on their own subscription.
 *
 * `customer` exists so a self-service cancellation is recorded truthfully. The
 * alternative -- writing it as `admin` with the subscriber as the operator --
 * would put a false operator in the audit trail.
 */
export const SUBSCRIPTION_CHANGE_SOURCES = ['admin', 'payment', 'customer'] as const;
export type SubscriptionChangeSource = (typeof SUBSCRIPTION_CHANGE_SOURCES)[number];

/** A plan version, as the P1 catalogue defines it. */
export interface AdminSubscriptionPlan {
  code: string;
  version: number;
  versionId: string;
  displayName: string;
  billingPeriodMonths: number;
  monthlyIncludedCredits: number;
  priceMinor: number;
  currency: string;
}

/** The user's subscription now, resolved as the customer's commercial state resolves it. */
export interface AdminSubscriptionState {
  /** The exact version held. `live` is false when it is no longer published: then there is no Premium. */
  plan: AdminSubscriptionPlan & { live: boolean };
  /** As the customer is told it (a cancelled subscription past its period end reads as expired). */
  status: SubscriptionStatus;
  /** As recorded. */
  storedStatus: SubscriptionStatus;
  /** ISO 8601. */
  currentPeriodEnd: string;
  premium: boolean;
}

/** One side of a recorded change. */
export interface AdminSubscriptionSnapshot {
  planCode: string;
  planVersion: number;
  status: SubscriptionStatus;
  currentPeriodEnd: string;
}

/** One recorded change, from the append-only subscription history. */
export interface AdminSubscriptionHistoryEntry {
  sequence: number;
  change: AdminSubscriptionAction;
  source: SubscriptionChangeSource;
  /** When it took effect. ISO 8601. */
  effectiveAt: string;
  /** Null when the user had no subscription before it. */
  from: AdminSubscriptionSnapshot | null;
  to: AdminSubscriptionSnapshot;
  actorUserId: string | null;
  actorEmail: string | null;
  reason: string | null;
  reference: string | null;
}

/** GET /admin/users/:userId/subscription -- and the answer to a change. */
export interface AdminUserSubscription {
  userId: string;
  economyEnabled: boolean;
  /** The number of changes recorded. A change must name it as `expectedVersion`. */
  version: number;
  current: AdminSubscriptionState | null;
  /** Newest first. */
  history: AdminSubscriptionHistoryEntry[];
  /** The plans that can be assigned now: published, in effect and purchasable. */
  plans: AdminSubscriptionPlan[];
  /** What the current state allows. */
  actions: AdminSubscriptionAction[];
  /** Whether THIS operator may make a change now, decided by the server. */
  change: { allowed: true } | { allowed: false; reason: 'permission_required' | 'own_account' | 'economy_disabled' };
}

/** POST /admin/users/:userId/subscription. */
export interface AdminSubscriptionChangeRequest {
  action: AdminSubscriptionAction;
  /** For assign and change_plan only: the plan's code; its version in effect now is used. */
  planCode?: string;
  expectedVersion: number;
  reason: string;
  reference?: string | null;
}

/* ------------------------------------------------------------------ *
 * Content access (P4.1, PRD §10, §32.1)
 * ------------------------------------------------------------------ */

/**
 * A piece of content's access state, held on its offer (the P0.8 commercial
 * boundary). Content with no offer is `free`.
 *   free         no condition
 *   premium      included with a subscription (Premium)
 *   credit       unlocked with Credits, at the offer's whole-Credit price
 *   unavailable  cannot be accessed
 * Whether a particular user may access it -- a subscription, an unlock, an
 * age check -- is decided later (P4/P5/P8), never by a client.
 */
export const CONTENT_ACCESS_STATES = ['free', 'premium', 'credit', 'unavailable'] as const;
export type ContentAccessState = (typeof CONTENT_ACCESS_STATES)[number];

/**
 * What the signed-in customer may do with one piece of content right now
 * (P4.2). The server decides this; a client never derives it.
 *
 *   owned                they bought it and keep it, whatever their tier or
 *                        balance is now (P8.2)
 *   open                 it opens: free content, or Premium content for a
 *                        subscriber
 *   premium_required     Premium content, and this customer is not Premium
 *   credits_required     Credit content: it can be unlocked for `creditPrice`
 *   insufficient_credits Credit content, and their balance is below the price
 *   age_restricted       the content has an age floor this customer has not met
 *   unavailable          withdrawn, unknown, or not resolvable -- fails closed
 *
 * `owned` and `pending` arrive with unlocking (P8); until then a Credit unlock
 * cannot be bought, so no content is ever owned.
 */
export type CustomerAccessDecision =
  | 'owned'
  | 'open'
  | 'premium_required'
  | 'credits_required'
  | 'insufficient_credits'
  | 'age_restricted'
  | 'unavailable';

/** One piece of content's access terms and this customer's decision. */
export interface CustomerContentAccess {
  assetId: string;
  /** The content's own access state (P4.1). */
  state: ContentAccessState;
  /** Whole Credits to unlock: only for `credit` content. */
  creditPrice: number | null;
  /** The minimum age the content requires, or null. */
  ageFloor: number | null;
  decision: CustomerAccessDecision;
}

/** GET /api/content/access -- one entry per asset asked about, in the order asked. */
export interface CustomerContentAccessResponse {
  items: CustomerContentAccess[];
}

/**
 * POST /api/content/:assetId/unlock -- what the customer now owns (P8.2).
 *
 * The same answer whether this call bought it or a previous one did: ownership
 * is the fact, and `replayed` only says whether this particular request is what
 * created it. No balance, ledger or wallet detail is ever included.
 */
export interface CustomerContentUnlock {
  assetId: string;
  entitlementId: string;
  /** The content offer bought -- the durable identity ownership is recorded against. */
  offerId: string;
  /** Whole Credits actually paid, pinned at the time of purchase. */
  creditPrice: number;
  acquiredAt: string;
  /** True when this request had already been applied: nothing was charged. */
  replayed: boolean;
}


/* ------------------------------------------------------------------ *
 * Payments (P9.1 / P9.2)
 * ------------------------------------------------------------------ */

/**
 * The payment method a customer picks before being sent to the provider.
 *
 * A HINT, NEVER AUTHORITY. Which method actually took the money is the
 * provider's to report; a real hosted checkout may offer a different one, or
 * the customer may change their mind on the provider's own page.
 */
export const PAYMENT_METHODS = ['apple_pay', 'google_pay', 'paypal'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  paypal: 'PayPal',
};

/** Where a payment stands. Mirrors the `payment_status` enum. */
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'refunded' | 'disputed';

/**
 * Where a customer opened the Credits Store from, and what they were doing.
 * Fixed lists: the app turns these back into one of its own pages afterwards,
 * so nothing here is ever a URL.
 */
export const PURCHASE_ORIGINS = ['chat', 'store', 'header', 'profile', 'lobby', 'premium', 'content'] as const;
export type PurchaseOrigin = (typeof PURCHASE_ORIGINS)[number];
export const PURCHASE_ORIGIN_ACTIONS = ['content_unlock', 'image', 'video', 'voice_message', 'voice_call', 'browse'] as const;
export type PurchaseOriginAction = (typeof PURCHASE_ORIGIN_ACTIONS)[number];

/* ---- analytics property allow-lists (PR 3), beside the purchase vocabulary they use ---- */

const SURFACES = ['premium_gate', 'subscription_page', 'credits_store', 'posts', 'home_feed', 'swipe'] as const;
const TIERS = ['free', 'premium'] as const;
const PURCHASE_CONTEXT = {
  origin: PURCHASE_ORIGINS,
  originAction: PURCHASE_ORIGIN_ACTIONS,
  assetId: 'id',
  conversationId: 'id',
  characterId: 'id',
} as const;
const PACK_TERMS = {
  paymentId: 'id',
  packCode: 'code',
  packVersion: 'int',
  credits: 'int',
  bonusCredits: 'int',
  totalCredits: 'int',
  priceMinor: 'int',
  currency: 'code',
  promoted: 'bool',
  tier: TIERS,
} as const;

/**
 * EVERY EVENT'S PROPERTIES, AS A FIXED ALLOW-LIST (PR 3). A key not listed for
 * an event is dropped, and so is a value of the wrong kind -- whether it came
 * from the server or a browser. An event not listed here carries no
 * properties at all until it is given a list.
 */
export const ANALYTICS_EVENT_PROPERTIES: Readonly<Partial<Record<AnalyticsEventName, Readonly<Record<string, AnalyticsPropertyKind>>>>> = {
  // Client-reported
  paywall_viewed: { surface: SURFACES, characterId: 'id', tier: TIERS },
  subscription_cta_clicked: { surface: SURFACES, planCode: 'code' },
  paywall_dismissed: { surface: SURFACES, packCode: 'code', planCode: 'code' },
  credit_purchase_viewed: {
    ...PURCHASE_CONTEXT,
    tier: TIERS,
    balanceState: ['unknown', 'zero', 'low', 'normal'],
    packCount: 'int',
    /** The pack the store recommended -- stated by the server, from its own catalog and facts. */
    recommendedPackCode: 'code',
  },
  locked_content_viewed: {
    surface: SURFACES,
    assetId: 'id',
    characterId: 'id',
    decision: ['credits_required', 'insufficient_credits', 'premium_required'],
    creditPrice: 'int',
  },
  // Server-reported, where the business transaction commits
  subscription_started: { paymentId: 'id', planCode: 'code', billingPeriodMonths: 'int', priceMinor: 'int', currency: 'code' },
  credit_purchase_started: { ...PACK_TERMS, ...PURCHASE_CONTEXT, method: 'code' },
  credit_purchase_completed: { ...PACK_TERMS, ...PURCHASE_CONTEXT },
  credit_purchase_failed: { ...PACK_TERMS, ...PURCHASE_CONTEXT, status: ['failed', 'cancelled'] },
  credit_spend: { paidActionId: 'id', actionType: 'code', amount: 'int' },
  locked_content_unlocked: { assetId: 'id', offerId: 'id', entitlementId: 'id', creditPrice: 'int' },
  /**
   * WHAT WAS WATCHED, WHOSE IT IS, AND WHERE IT WAS SERVED FROM.
   *
   * `context` is the one thing about placement the server can state as fact:
   * her gallery and a conversation are different ROUTES, so the distinction is
   * read from which handler ran, never from anything a client said. Which rail
   * or tab a gallery view came from is NOT here, because the server genuinely
   * cannot know it -- every surface fetches the same URL -- and a property that
   * could only be taken on trust does not belong in a funnel.
   */
  content_viewed: {
    assetId: 'id',
    characterId: 'id',
    contentRating: ['sfw', 'explicit'],
    mediaType: ['image', 'video'],
    channel: ['gallery', 'chat'],
  },
  spend_refunded: { paidActionId: 'id', actionType: 'code', amount: 'int' },
};

const ANALYTICS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANALYTICS_CODE = /^[A-Za-z0-9_]{1,64}$/;

/** At or below this many spendable Credits, a balance is "low" (the store's notice and its analytics agree). */
export const LOW_CREDIT_BALANCE = 10;

export type CreditBalanceState = 'unknown' | 'zero' | 'low' | 'normal';

export function creditBalanceState(spendable: number | null): CreditBalanceState {
  if (spendable === null) return 'unknown';
  if (spendable <= 0) return 'zero';
  return spendable <= LOW_CREDIT_BALANCE ? 'low' : 'normal';
}

/* ---- which pack the Credits Store recommends (store conversion) ---- */

/**
 * What a pack needs to say for the store to recommend one. Every field is the
 * catalog's; nothing here prices anything -- it only CHOOSES among the server's
 * packs. Shared so the server states the same recommendation for analytics
 * that the page shows (`credit_purchase_viewed.recommendedPackCode`).
 */
export interface RecommendablePack {
  code: string;
  totalCredits: number;
  priceMinor: number;
  isBestValue: boolean;
  isPurchasable: boolean;
  sortOrder?: number;
}

/** How many more Credits an unlock needs: the server's price less the server's balance. Null when either is unknown. */
export function creditsNeededFor(creditPrice: number | null | undefined, spendable: number | null | undefined): number | null {
  if (typeof creditPrice !== 'number' || typeof spendable !== 'number') return null;
  return Math.max(0, creditPrice - spendable);
}

const byLadder = (a: RecommendablePack, b: RecommendablePack) =>
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.code.localeCompare(b.code);

/**
 * The smallest purchasable pack whose Credits cover `creditsNeeded` ("Unlocks
 * this ✓"). Null when nothing is needed or no pack is big enough.
 */
export function packCoveringNeed(packs: readonly RecommendablePack[], creditsNeeded: number | null): string | null {
  if (creditsNeeded === null || creditsNeeded <= 0) return null;
  const covering = packs
    .filter((p) => p.isPurchasable && p.totalCredits >= creditsNeeded)
    .sort((a, b) => a.totalCredits - b.totalCredits || a.priceMinor - b.priceMinor || byLadder(a, b));
  return covering[0]?.code ?? null;
}

/**
 * The pack the store puts first and selects by default:
 *   1. the one the operator marked best value;
 *   2. arriving to unlock something: the smallest pack that covers it;
 *   3. otherwise the second-cheapest (the cheapest when there is only one).
 */
export function recommendCreditPack(packs: readonly RecommendablePack[], creditsNeeded: number | null): string | null {
  const offered = packs.filter((p) => p.isPurchasable);
  if (offered.length === 0) return null;
  const best = offered.filter((p) => p.isBestValue).sort(byLadder)[0];
  if (best) return best.code;
  const covering = packCoveringNeed(offered, creditsNeeded);
  if (covering) return covering;
  const byPrice = [...offered].sort((a, b) => a.priceMinor - b.priceMinor || a.totalCredits - b.totalCredits || byLadder(a, b));
  return (byPrice[1] ?? byPrice[0])!.code;
}

/**
 * An event's properties with everything not on its allow-list removed. Pure,
 * shared by the server (for every event it stores) and the client (before it
 * sends anything).
 */
export function allowedAnalyticsProperties(
  name: AnalyticsEventName,
  properties: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, string | number | boolean> {
  const allowed = ANALYTICS_EVENT_PROPERTIES[name];
  const out: Record<string, string | number | boolean> = {};
  if (!allowed || !properties) return out;
  for (const [key, kind] of Object.entries(allowed)) {
    const value = properties[key];
    if (value === undefined || value === null) continue;
    if (kind === 'id') {
      if (typeof value === 'string' && ANALYTICS_ID.test(value)) out[key] = value.toLowerCase();
    } else if (kind === 'code') {
      if (typeof value === 'string' && ANALYTICS_CODE.test(value)) out[key] = value;
    } else if (kind === 'int') {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[key] = value;
    } else if (kind === 'bool') {
      if (typeof value === 'boolean') out[key] = value;
    } else if (typeof value === 'string' && kind.includes(value)) {
      out[key] = value;
    }
  }
  return out;
}


export interface PurchaseContext {
  origin: PurchaseOrigin | null;
  originAction: PurchaseOriginAction | null;
  /** The content asset being unlocked, when that is the action. */
  assetId: string | null;
  /** The conversation it was in, when there is one. */
  conversationId: string | null;
  /** The character it was with, when there is one. */
  characterId: string | null;
}

/** A Credit pack's terms as they stood at checkout: what the payment buys, whatever the catalog says later. */
export interface CreditPackTerms {
  packCode: string;
  packVersion: number;
  displayName: string;
  credits: number;
  bonusCredits: number;
  totalCredits: number;
}

/** One payment, as its own customer may see it. No card data, ever. */
export interface CustomerPaymentView {
  id: string;
  status: PaymentStatus;
  kind: 'subscription' | 'credit_pack';
  /** Our product identifier -- a plan or pack code. Never the processor's. */
  productRef: string;
  /** Integer minor units. */
  amountMinor: number;
  currency: string;
  methodHint: string | null;
  /** Which adapter took it: `fake` while the processor is undecided (P9.D1). */
  provider: string;
  createdAt: string;
  settledAt: string | null;
  /** A Credit pack's locked terms; null for a subscription. */
  pack: CreditPackTerms | null;
  /** Where the purchase started; null when it carried none. */
  context: PurchaseContext | null;
}

/**
 * POST /api/payments/checkout -- a started checkout.
 *
 * `redirectUrl` is where the customer goes to pay. NOTHING is activated or
 * granted by this call: the payment is `pending` until the provider confirms it.
 */
export interface CustomerCheckout {
  payment: CustomerPaymentView;
  checkoutRef: string;
  /** Null when the checkout was already created under this key. */
  redirectUrl: string | null;
  replayed: boolean;
}

/** What a simulated payment is told to do. Test-only; never a real processor. */
export const SIMULATED_OUTCOMES = ['success', 'failure', 'cancel'] as const;
export type SimulatedOutcome = (typeof SIMULATED_OUTCOMES)[number];

/** POST /api/payments/simulate -- the result of feeding one simulated provider event in. */
export interface SimulatedPaymentResult {
  /** `processed`, `replayed`, `rejected` or `ignored`, as the ingestion decided. */
  status: string;
  payment: CustomerPaymentView | null;
}

/* ------------------------------------------------------------------ *
 * Admin content access -- a character's Free/Premium clips (P4.D2)
 * ------------------------------------------------------------------ */

/** One clip of a character, and the access it has now. */
export interface AdminClipAccess {
  assetId: string;
  /** What the clip is, as the admin content shelf states it. */
  mediaType: string;
  workflow: string;
  /** Whether a customer can meet it anywhere today. */
  live: boolean;
  /**
   * THE CLIP'S OWN BYTES, so an operator classifying it can SEE it.
   *
   * An access decision is made about a particular clip, and the only thing on
   * this screen that identified one was the head of its uuid -- which
   * identifies nothing to a person. This is the same opaque, id-keyed admin
   * locator every other admin content surface uses (never a storage key and
   * never a path), and it is null when the row has no file.
   */
  previewUrl: string | null;
  /**
   * The name the file was uploaded under, when one was recorded.
   *
   * RECORDED, NOT INVENTED. It is `provenance.originalName`, which an operator
   * chose themselves; where it is absent this is null and the screen simply
   * shows no name rather than manufacturing one.
   */
  fileName: string | null;
  /** How long it runs, where generation recorded a duration. Null otherwise. */
  durationSeconds: number | null;
  state: ContentAccessState;
  /** True while nothing was written for this clip: it reads its character's default. */
  byDefault: boolean;
  creditPrice: number | null;
  ageFloor: number | null;
}

/**
 * GET /admin/characters/:characterId/content-access -- and the answer to every
 * change. `allocation.configured` is the character's opt-in: while it is true,
 * her clips -- including ones uploaded later -- are Premium unless an offer
 * says otherwise.
 */
export interface AdminCharacterContentAccess {
  characterId: string;
  economyEnabled: boolean;
  allocation: { configured: boolean; freeClipCount: number | null };
  clips: AdminClipAccess[];
  counts: { clips: number; free: number; premium: number; credit: number };
}
