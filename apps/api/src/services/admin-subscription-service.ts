import { eq } from 'drizzle-orm';
import {
  ADMIN_SUBSCRIPTION_ACTIONS,
  type AdminSubscriptionAction,
  type AdminSubscriptionChangeRequest,
  type AdminSubscriptionPlan,
  type AdminUserSubscription,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { recordAudit, type AuditActor } from './audit-service.js';
import { economyNow, resolvePlanCatalog, type PlanVersionView } from './economy-resolver.js';
import { changeSubscription, readSubscriptionHistory, readSubscriptionRecord, subscriptionActions } from './subscription-service.js';

/**
 * ADMIN SUBSCRIPTION MANAGEMENT (P3.5): an operator views and changes one
 * user's subscription from Admin -> Users -> User Detail.
 *
 * THIS MODULE OWNS NO SUBSCRIPTION RULE. What a subscription is, which change
 * each state allows, which plan version applies and how the history is kept
 * are the subscription service's (P3.1, P3.5); plans come from the P1
 * catalogue. This module checks the request and the operator, and writes the
 * change and its audit record in ONE transaction -- so there is never a change
 * without its record, nor a record of one that did not happen.
 *
 * WHO AND WHOM. The route requires `users.subscription.manage` (administrator
 * only). Nobody may change their own subscription; staff and suspended
 * accounts may be changed by another operator -- the rules P2.5.3 set for
 * wallets. A change is refused while the economy is switched off (the route),
 * exactly as a wallet adjustment is. Nothing here touches a wallet.
 */

export class AdminSubscriptionError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'user_not_found' | 'own_account',
    message: string,
  ) {
    super(message);
    this.name = 'AdminSubscriptionError';
  }
}

/** The audit object a change is recorded against: one user's subscription. */
export const SUBSCRIPTION_AUDIT_OBJECT_TYPE = 'subscription';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The P1 plan-code format (economy_plans_code_format). */
const PLAN_CODE = /^[a-z][a-z0-9_]{1,63}$/;
const REASON_MAX = 500;
const REFERENCE_MAX = 100;
const NEEDS_PLAN: ReadonlySet<AdminSubscriptionAction> = new Set(['assign', 'change_plan']);

function invalid(message: string): never {
  throw new AdminSubscriptionError('invalid_request', message);
}

/** The user, confirmed to exist, by the id as stored. */
async function findUser(db: Pick<Db, 'select'>, userId: string): Promise<string> {
  if (typeof userId !== 'string' || !UUID.test(userId)) invalid('The User ID must be a user id.');
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!row) throw new AdminSubscriptionError('user_not_found', `No user has the ID ${userId}.`);
  return row.id;
}

const toPlan = (p: PlanVersionView): AdminSubscriptionPlan => ({
  code: p.ref.code,
  version: p.ref.version,
  versionId: p.ref.id,
  displayName: p.displayName,
  billingPeriodMonths: p.billingPeriodMonths,
  monthlyIncludedCredits: p.monthlyIncludedCredits,
  priceMinor: p.priceMinor,
  currency: p.currency,
});

/** The user's subscription, its history, the plans that can be assigned now, and whether this operator may change it. */
export async function readUserSubscription(
  db: Db,
  userId: string,
  options: { economyEnabled: boolean; operator: { userId: string; canManage: boolean } },
): Promise<AdminUserSubscription> {
  const id = await findUser(db, userId);
  const [record, history, catalog] = await Promise.all([
    readSubscriptionRecord(db, id),
    readSubscriptionHistory(db, id),
    economyNow(db).then((asOf) => resolvePlanCatalog(db, asOf)),
  ]);
  const change: AdminUserSubscription['change'] = !options.operator.canManage
    ? { allowed: false, reason: 'permission_required' }
    : id === options.operator.userId
      ? { allowed: false, reason: 'own_account' }
      : !options.economyEnabled
        ? { allowed: false, reason: 'economy_disabled' }
        : { allowed: true };
  const current = record.current;
  return {
    userId: id,
    economyEnabled: options.economyEnabled,
    version: record.version,
    current: current
      ? {
          plan: { ...toPlan(current.plan), live: current.plan.status === 'published' },
          status: current.status,
          storedStatus: current.storedStatus,
          currentPeriodEnd: current.currentPeriodEnd,
          premium: current.premium,
        }
      : null,
    history,
    // Assignable: published, in effect now and purchasable. A retired plan stays with its subscribers but is not given out.
    plans: catalog.plans.filter((p) => p.isPurchasable).map(toPlan),
    actions: subscriptionActions(current),
    change,
  };
}

interface ParsedChange extends Omit<AdminSubscriptionChangeRequest, 'planCode' | 'reference'> {
  planCode: string | null;
  reference: string | null;
}

/** The request body, checked. Anything unrecognised or malformed is refused, never guessed. */
export function parseSubscriptionChange(body: unknown): ParsedChange {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) invalid('The request must be a JSON object.');
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !['action', 'planCode', 'expectedVersion', 'reason', 'reference'].includes(k));
  if (unknown.length > 0) invalid(`Unexpected field: ${unknown.join(', ')}.`);
  if (!(ADMIN_SUBSCRIPTION_ACTIONS as readonly unknown[]).includes(raw.action)) invalid(`action must be one of: ${ADMIN_SUBSCRIPTION_ACTIONS.join(', ')}.`);
  const action = raw.action as AdminSubscriptionAction;

  let planCode: string | null = null;
  if (NEEDS_PLAN.has(action)) {
    if (typeof raw.planCode !== 'string' || !PLAN_CODE.test(raw.planCode)) invalid(`${action} needs planCode: a plan code from the catalogue.`);
    planCode = raw.planCode;
  } else if (raw.planCode !== undefined && raw.planCode !== null) {
    invalid(`${action} takes no planCode.`);
  }
  if (typeof raw.expectedVersion !== 'number' || !Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion < 0) {
    invalid('expectedVersion must be the version you loaded: a whole number, 0 or more.');
  }
  if (typeof raw.reason !== 'string' || raw.reason.trim() === '') invalid('A reason is required.');
  const reason = raw.reason.trim();
  if (reason.length > REASON_MAX) invalid(`The reason must be at most ${REASON_MAX} characters.`);
  let reference: string | null = null;
  if (raw.reference !== undefined && raw.reference !== null) {
    if (typeof raw.reference !== 'string' || raw.reference.length > REFERENCE_MAX) invalid(`reference must be text of at most ${REFERENCE_MAX} characters.`);
    reference = raw.reference.trim() || null;
  }
  return { action, planCode, expectedVersion: raw.expectedVersion, reason, reference };
}

/**
 * Makes one change to one user's subscription and records it: the subscription
 * service writes the change and its history row, and the audit record is
 * written in the same transaction. Answers with the subscription as it now is.
 */
export async function changeUserSubscription(
  db: Db,
  userId: string,
  body: unknown,
  ctx: { actor: AuditActor & { userId: string }; requestId: string | null },
): Promise<AdminUserSubscription> {
  if (typeof userId !== 'string' || !UUID.test(userId)) invalid('The User ID must be a user id.');
  const request = parseSubscriptionChange(body);
  const id = await findUser(db, userId);
  if (id === ctx.actor.userId) throw new AdminSubscriptionError('own_account', 'You cannot change your own subscription. Another administrator must.');

  await db.transaction(async (tx) => {
    const result = await changeSubscription(tx, {
      userId: id,
      action: request.action,
      planCode: request.planCode,
      expectedVersion: request.expectedVersion,
      source: 'admin',
      actorUserId: ctx.actor.userId,
      reason: request.reason,
      reference: request.reference,
      requestId: ctx.requestId,
    });
    await recordAudit(tx, {
      actor: ctx.actor,
      action: `subscription.${request.action}`,
      objectType: SUBSCRIPTION_AUDIT_OBJECT_TYPE,
      objectId: id,
      before: result.before,
      after: result.after,
      reason: request.reason,
      requestId: ctx.requestId,
      metadata: { source: 'admin', historySequence: result.sequence, effectiveAt: result.effectiveAt, reference: request.reference },
    });
  });

  return readUserSubscription(db, id, { economyEnabled: true, operator: { userId: ctx.actor.userId, canManage: true } });
}
