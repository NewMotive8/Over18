import { eq, sql } from 'drizzle-orm';
import type {
  AdminSubscriptionAction,
  AdminSubscriptionHistoryEntry,
  CommercialSubscription,
  CommercialTier,
  SubscriptionStatus,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import { subscriptionHistory, subscriptions, users } from '../db/schema.js';
import {
  economyNow,
  loadPlanVersion,
  lockEconomyRefForRecording,
  resolvePlanVersion,
  type PlanVersionView,
} from './economy-resolver.js';

/**
 * THE SUBSCRIPTION STATE (P3.1): the one place that answers "what is this
 * user's subscription, and does it give Premium?" -- and (P3.5) the one place
 * that changes it, recording every change in its append-only history.
 *
 * THE STORED STATE IS AUTHORITATIVE (decided 2026-09-19). The billing
 * lifecycle records `active`, `past_due`, `grace`, `cancelled` and `expired`;
 * this module reports them and derives no transition from dates, except the
 * one the PRD states: a `cancelled` subscription reads as `expired` once its
 * paid period has ended (§13, UC-12), measured on the database clock.
 *
 * PREMIUM (decided 2026-09-19): active, past_due (UC-15: no hard lockout on
 * the first failed payment), grace (UC-15) and cancelled-with-time-left (§13).
 * Expired is not Premium; no subscription is Free. A staff role is never a
 * commercial tier.
 *
 * FAIL CLOSED ON THE PLAN. The plan code comes from the exact P1 plan version
 * the subscription names, never from a copy. If that version is not a
 * published one, the subscription cannot be resolved: it yields no Premium and
 * no plan, only `unresolvable`.
 *
 * CHANGES (P3.5) use only these states -- no new lifecycle is invented:
 *   assign       none or expired -> active on a plan's version in effect now,
 *                for one billing period of that plan (from the P1 catalogue);
 *   change_plan  a current subscription -> another plan now; status and period
 *                end are kept (proration is not defined yet: P3/P9);
 *   cancel       active, past_due or grace -> cancelled: Premium to the period end;
 *   end          any current subscription -> expired, now.
 * Scheduling a change for a later date is not offered: nothing yet renews a
 * subscription, so nothing could apply it (P9). Past_due and grace belong to
 * the billing provider and are never set here. No wallet is touched: included
 * Credits are granted by their own lifecycle, never as a side effect.
 */

const PREMIUM: ReadonlySet<SubscriptionStatus> = new Set(['active', 'past_due', 'grace', 'cancelled']);

/** A database or a transaction: what reading and changing a subscription needs. */
type Reader = Pick<Db, 'select' | 'selectDistinctOn' | 'execute'>;
type Writer = Reader & Pick<Db, 'insert' | 'update'>;

/** The status a customer is told -- the ONE derivation. */
const told = (stored: SubscriptionStatus, periodEnded: boolean): SubscriptionStatus =>
  stored === 'cancelled' && periodEnded ? 'expired' : stored;

/** A timestamp exactly, to the microsecond, for copying from one row to another. */
const exact = (col: unknown) => sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface Stored {
  planVersionId: string;
  storedStatus: SubscriptionStatus;
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  /** `currentPeriodEnd` to the microsecond. */
  currentPeriodEndExact: string;
}

async function readStored(db: Pick<Db, 'select'>, userId: string): Promise<Stored | null> {
  const [row] = await db
    .select({
      planVersionId: subscriptions.planVersionId,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      currentPeriodEndExact: exact(subscriptions.currentPeriodEnd),
      periodEnded: sql<boolean>`${subscriptions.currentPeriodEnd} <= now()`,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  if (!row) return null;
  return {
    planVersionId: row.planVersionId,
    storedStatus: row.status,
    status: told(row.status, row.periodEnded),
    currentPeriodEnd: row.currentPeriodEnd,
    currentPeriodEndExact: row.currentPeriodEndExact,
  };
}

export type SubscriptionState =
  | { ok: true; tier: CommercialTier; subscription: CommercialSubscription | null }
  | { ok: false; reason: 'plan_version_unresolvable' };

export async function resolveSubscription(db: Db, userId: string): Promise<SubscriptionState> {
  const stored = await readStored(db, userId);
  if (!stored) return { ok: true, tier: 'free', subscription: null };

  const plan = await loadPlanVersion(db, stored.planVersionId);
  if (!plan.ok || plan.value.status !== 'published') return { ok: false, reason: 'plan_version_unresolvable' };

  return {
    ok: true,
    tier: PREMIUM.has(stored.status) ? 'premium' : 'free',
    subscription: {
      status: stored.status,
      planCode: plan.value.ref.code,
      currentPeriodEnd: stored.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: stored.status === 'cancelled',
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reading for an operator (P3.5)
 * ------------------------------------------------------------------ */

/** A subscription as an operator sees it: the stored row, its exact plan version, and whether it gives Premium. */
export interface SubscriptionRecord {
  plan: PlanVersionView;
  status: SubscriptionStatus;
  storedStatus: SubscriptionStatus;
  currentPeriodEnd: string;
  /** By exactly the rule `resolveSubscription` applies. */
  premium: boolean;
}

async function toRecord(db: Reader, stored: Stored): Promise<SubscriptionRecord> {
  const plan = await loadPlanVersion(db, stored.planVersionId);
  // The foreign key keeps the version; only a draft is hidden from loadPlanVersion, and none is ever subscribed to.
  if (!plan.ok) throw new Error(`Subscription names plan version ${stored.planVersionId}, which cannot be loaded.`);
  const live = plan.value.status === 'published';
  return {
    plan: plan.value,
    status: stored.status,
    storedStatus: stored.storedStatus,
    currentPeriodEnd: stored.currentPeriodEnd.toISOString(),
    premium: live && PREMIUM.has(stored.status),
  };
}

/** The number of recorded changes: the optimistic-concurrency version of a user's subscription. */
async function historyVersion(db: Pick<Db, 'select'>, userId: string): Promise<number> {
  const [row] = await db
    .select({ version: sql<number>`coalesce(max(${subscriptionHistory.sequence}), 0)::int` })
    .from(subscriptionHistory)
    .where(eq(subscriptionHistory.userId, userId));
  return row?.version ?? 0;
}

export async function readSubscriptionRecord(db: Db, userId: string): Promise<{ version: number; current: SubscriptionRecord | null }> {
  const [version, stored] = await Promise.all([historyVersion(db, userId), readStored(db, userId)]);
  return { version, current: stored ? await toRecord(db, stored) : null };
}

/** What the current state allows. `status` is as the customer is told it. */
export function subscriptionActions(current: { status: SubscriptionStatus } | null): AdminSubscriptionAction[] {
  if (!current || current.status === 'expired') return ['assign'];
  return current.status === 'cancelled' ? ['change_plan', 'end'] : ['change_plan', 'cancel', 'end'];
}

/**
 * A user's recorded changes, newest first, naming each plan version by its P1
 * code and number. The plan versions are read through the economy resolver --
 * the one reader of economy configuration -- never joined here.
 */
export async function readSubscriptionHistory(db: Db, userId: string, limit = 20): Promise<AdminSubscriptionHistoryEntry[]> {
  const rows = await db.execute<{
    sequence: number;
    change: AdminSubscriptionAction;
    source: 'admin';
    effective_at: Date;
    previous_plan_version_id: string | null;
    previous_status: SubscriptionStatus | null;
    previous_period_end: Date | null;
    plan_version_id: string;
    status: SubscriptionStatus;
    current_period_end: Date;
    actor_user_id: string | null;
    actor_email: string | null;
    reason: string | null;
    reference: string | null;
  }>(sql`
    select h.sequence, h.change, h.source, h.effective_at,
           h.previous_plan_version_id, h.previous_status, h.previous_period_end,
           h.plan_version_id, h.status, h.current_period_end,
           h.actor_user_id, a.email as actor_email, h.reason, h.reference
      from ${subscriptionHistory} h
      left join ${users} a on a.id = h.actor_user_id
     where h.user_id = ${userId}
     order by h.sequence desc
     limit ${limit}`);

  const versionIds = [...new Set(rows.rows.flatMap((r) => [r.plan_version_id, r.previous_plan_version_id]))].filter((id): id is string => id !== null);
  const plans = new Map<string, { planCode: string; planVersion: number }>();
  await Promise.all(
    versionIds.map(async (id) => {
      const plan = await loadPlanVersion(db, id);
      // The foreign keys keep every version; only a draft is hidden, and none is ever subscribed to.
      if (!plan.ok) throw new Error(`Subscription history names plan version ${id}, which cannot be loaded.`);
      plans.set(id, { planCode: plan.value.ref.code, planVersion: plan.value.ref.version });
    }),
  );

  return rows.rows.map((r) => ({
    sequence: r.sequence,
    change: r.change,
    source: r.source,
    effectiveAt: new Date(r.effective_at).toISOString(),
    from:
      r.previous_plan_version_id !== null && r.previous_status !== null && r.previous_period_end !== null
        ? { ...plans.get(r.previous_plan_version_id)!, status: r.previous_status, currentPeriodEnd: new Date(r.previous_period_end).toISOString() }
        : null,
    to: { ...plans.get(r.plan_version_id)!, status: r.status, currentPeriodEnd: new Date(r.current_period_end).toISOString() },
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_email,
    reason: r.reason,
    reference: r.reference,
  }));
}

/* ------------------------------------------------------------------ *
 * Changing (P3.5)
 * ------------------------------------------------------------------ */

export class SubscriptionError extends Error {
  constructor(
    public readonly code: 'invalid_transition' | 'unknown_plan' | 'plan_unavailable' | 'same_plan' | 'subscription_conflict',
    message: string,
    /** The recorded version, on a `subscription_conflict`. */
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

interface SubscriptionChangeBase {
  /** The user's id as stored (lower case). */
  userId: string;
  action: AdminSubscriptionAction;
  /** For assign and change_plan: the plan whose version in effect now is used. */
  planCode: string | null;
  /** The version the caller saw: the change is refused if another was recorded since. */
  expectedVersion: number;
  reason: string;
  reference: string | null;
  requestId: string | null;
}

/**
 * WHO MADE THE CHANGE, and what that obliges them to supply.
 *
 * A discriminated union rather than two loose fields, because migration 0039
 * refuses an `admin` history row without an operator and a reason -- so the
 * type should refuse it too, rather than leaving the database to catch it.
 * A payment has no operator: the provider's confirmation is the authority, and
 * the payment itself is named in `reference`.
 */
export type SubscriptionChange = SubscriptionChangeBase &
  ({ source: 'admin'; actorUserId: string } | { source: 'payment'; actorUserId: null });

/** One side of a change, for its audit record. */
export interface SubscriptionSnapshot {
  planVersionId: string;
  planCode: string;
  planVersion: number;
  status: SubscriptionStatus;
  storedStatus: SubscriptionStatus;
  currentPeriodEnd: string;
  premium: boolean;
}

export interface SubscriptionChangeResult {
  sequence: number;
  effectiveAt: string;
  before: SubscriptionSnapshot | null;
  after: SubscriptionSnapshot;
}

const snapshot = (r: SubscriptionRecord): SubscriptionSnapshot => ({
  planVersionId: r.plan.ref.id,
  planCode: r.plan.ref.code,
  planVersion: r.plan.ref.version,
  status: r.status,
  storedStatus: r.storedStatus,
  currentPeriodEnd: r.currentPeriodEnd,
  premium: r.premium,
});

const NOT_ALLOWED: Record<AdminSubscriptionAction, string> = {
  assign: 'A plan can only be assigned to a user with no subscription or an expired one; change the current plan instead.',
  change_plan: 'There is no current subscription to change; assign a plan instead.',
  cancel: 'Only an active, past-due or grace subscription can be cancelled.',
  end: 'There is no current subscription to end.',
};

/**
 * The plan version in effect now for `planCode` -- published, taken effect,
 * purchasable -- held with the P1 recording lock so it cannot be cancelled
 * while the change commits.
 */
async function livePlan(tx: Writer, planCode: string): Promise<PlanVersionView> {
  const resolved = await resolvePlanVersion(tx, planCode, await economyNow(tx));
  if (!resolved.ok) {
    throw resolved.reason === 'unknown_plan'
      ? new SubscriptionError('unknown_plan', `There is no plan ${planCode}.`)
      : new SubscriptionError('plan_unavailable', `Plan ${planCode} has no published version in effect now.`);
  }
  const plan = resolved.value;
  if (!plan.isPurchasable) throw new SubscriptionError('plan_unavailable', `Plan ${planCode} is retired: it can no longer be assigned.`);
  const locked = await lockEconomyRefForRecording(tx, plan.ref);
  if (!locked.ok) throw new SubscriptionError('plan_unavailable', `Plan ${planCode} version ${plan.ref.version} is no longer live.`);
  return plan;
}

/**
 * Makes one change and records it in the history, inside the CALLER's
 * transaction -- so the caller's audit record commits with it, or nothing does.
 *
 * Serialised per user by a transaction-scoped advisory lock (a user with no
 * subscription has no row to lock), then checked against what is stored: the
 * version the caller saw, and whether the current state allows the action.
 * The unique (user, sequence) index refuses a second change claiming the same
 * version, whatever happens.
 */
export async function changeSubscription(tx: Writer, change: SubscriptionChange): Promise<SubscriptionChangeResult> {
  const { userId, action } = change;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`subscription:${userId}`}, 0))`);

  const version = await historyVersion(tx, userId);
  if (version !== change.expectedVersion) {
    throw new SubscriptionError(
      'subscription_conflict',
      `This subscription has changed since you loaded it (${version} change${version === 1 ? '' : 's'} recorded, you saw ${change.expectedVersion}). Nothing was changed.`,
      version,
    );
  }

  const stored = await readStored(tx, userId);
  if (!subscriptionActions(stored).includes(action)) throw new SubscriptionError('invalid_transition', NOT_ALLOWED[action]);
  const before = stored ? snapshot(await toRecord(tx, stored)) : null;

  const target = action === 'assign' || action === 'change_plan' ? await livePlan(tx, change.planCode ?? '') : null;
  if (action === 'change_plan' && target!.ref.id === stored!.planVersionId) {
    throw new SubscriptionError('same_plan', `The subscription is already on ${target!.ref.code} version ${target!.ref.version}.`);
  }

  const now = sql`now()`;
  const written = {
    planVersionId: subscriptions.planVersionId,
    status: subscriptions.status,
    currentPeriodEndExact: exact(subscriptions.currentPeriodEnd),
  };
  let row: { planVersionId: string; status: SubscriptionStatus; currentPeriodEndExact: string } | undefined;
  if (action === 'assign') {
    const periodEnd = sql`now() + make_interval(months => ${target!.billingPeriodMonths})`;
    [row] = await tx
      .insert(subscriptions)
      .values({ userId, planVersionId: target!.ref.id, status: 'active', currentPeriodEnd: periodEnd })
      .onConflictDoUpdate({
        target: subscriptions.userId,
        set: { planVersionId: target!.ref.id, status: 'active', currentPeriodEnd: periodEnd, updatedAt: now },
      })
      .returning(written);
  } else {
    const set =
      action === 'change_plan'
        ? { planVersionId: target!.ref.id, updatedAt: now }
        : action === 'cancel'
          ? { status: 'cancelled' as const, updatedAt: now }
          : { status: 'expired' as const, currentPeriodEnd: now, updatedAt: now };
    [row] = await tx.update(subscriptions).set(set).where(eq(subscriptions.userId, userId)).returning(written);
  }

  const [recorded] = await tx
    .insert(subscriptionHistory)
    .values({
      userId,
      sequence: version + 1,
      change: action,
      source: change.source,
      previousPlanVersionId: stored?.planVersionId ?? null,
      previousStatus: stored?.storedStatus ?? null,
      previousPeriodEnd: stored ? sql`${stored.currentPeriodEndExact}::timestamptz` : null,
      planVersionId: row!.planVersionId,
      status: row!.status,
      currentPeriodEnd: sql`${row!.currentPeriodEndExact}::timestamptz`,
      actorUserId: change.actorUserId,
      reason: change.reason,
      reference: change.reference,
      requestId: change.requestId,
    })
    .returning({ effectiveAt: subscriptionHistory.effectiveAt });

  const after = snapshot(await toRecord(tx, (await readStored(tx, userId))!));
  return { sequence: version + 1, effectiveAt: recorded!.effectiveAt.toISOString(), before, after };
}

