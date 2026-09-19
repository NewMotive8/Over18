import { eq, sql } from 'drizzle-orm';
import type { CommercialSubscription, CommercialTier, SubscriptionStatus } from '@over18/shared';
import type { Db } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import { loadPlanVersion } from './economy-resolver.js';

/**
 * THE SUBSCRIPTION STATE (P3.1): the one place that answers "what is this
 * user's subscription, and does it give Premium?". It reads; nothing here
 * writes a subscription (P9).
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
 */

const PREMIUM: ReadonlySet<SubscriptionStatus> = new Set(['active', 'past_due', 'grace', 'cancelled']);

export type SubscriptionState =
  | { ok: true; tier: CommercialTier; subscription: CommercialSubscription | null }
  | { ok: false; reason: 'plan_version_unresolvable' };

export async function resolveSubscription(db: Db, userId: string): Promise<SubscriptionState> {
  const [row] = await db
    .select({
      planVersionId: subscriptions.planVersionId,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      periodEnded: sql<boolean>`${subscriptions.currentPeriodEnd} <= now()`,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  if (!row) return { ok: true, tier: 'free', subscription: null };

  const plan = await loadPlanVersion(db, row.planVersionId);
  if (!plan.ok || plan.value.status !== 'published') return { ok: false, reason: 'plan_version_unresolvable' };

  const status: SubscriptionStatus = row.status === 'cancelled' && row.periodEnded ? 'expired' : row.status;
  return {
    ok: true,
    tier: PREMIUM.has(status) ? 'premium' : 'free',
    subscription: {
      status,
      planCode: plan.value.ref.code,
      currentPeriodEnd: row.currentPeriodEnd.toISOString(),
      cancelAtPeriodEnd: status === 'cancelled',
    },
  };
}
