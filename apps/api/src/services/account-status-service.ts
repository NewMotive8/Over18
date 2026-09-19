import { and, eq, gt, sql } from 'drizzle-orm';
import {
  ACCOUNT_STATUSES,
  type AccountStatus,
  type AdminAccountStatusChangeRequest,
  type AdminAccountStatusChangeResult,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { recordAudit, type AuditActor } from './audit-service.js';

/**
 * ACCOUNT STATUS (P2.5.2): the one place `users.status` is changed.
 *
 * Two statuses, reversible both ways: `active` and `suspended`. A suspension
 * blocks sign-in and ends every session (services/auth-service enforces both);
 * it touches NOTHING commercial -- no subscription, wallet, entitlement or
 * content. Closing or deleting an account is not a status and is not here.
 *
 * WHO AND WHOM. Only an operator holding `users.status.manage` reaches this
 * (the route's `requirePermission`), only a CUSTOMER account can be changed
 * (`users.role = 'user'`), and nobody can change their own.
 *
 * ONE TRANSACTION, ONE LOCK, ONE AUDIT RECORD. The user row is locked, the
 * rules are checked against what is actually stored, the status is changed,
 * the sessions are ended and the audit record is written -- all inside one
 * transaction. If any step fails, nothing happens, including the audit
 * record. Every success writes exactly one audit record; every refusal none.
 *
 * COMPARE-AND-SET. The request names the status the operator saw
 * (`expectedStatus`); if the account is no longer in it -- another operator
 * got there first -- the change is refused as a conflict. Two concurrent
 * changes therefore serialise on the row lock, and the second is refused
 * instead of silently re-applying or undoing the first.
 */

export const ACCOUNT_STATUS_AUDIT_OBJECT_TYPE = 'account_status';
/** `metadata.source` of every change made here: an operator, through the admin API. */
export const ACCOUNT_STATUS_SOURCE = 'admin';
export const ACCOUNT_STATUS_REASON_MAX = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccountStatusErrorCode = 'invalid_request' | 'user_not_found' | 'own_account' | 'staff_account' | 'status_conflict';

export class AccountStatusError extends Error {
  constructor(
    public readonly code: AccountStatusErrorCode,
    message: string,
    /** The status actually stored, on a `status_conflict`. */
    public readonly currentStatus?: AccountStatus,
  ) {
    super(message);
    this.name = 'AccountStatusError';
  }
}

function invalid(message: string): never {
  throw new AccountStatusError('invalid_request', message);
}

const isStatus = (value: unknown): value is AccountStatus => (ACCOUNT_STATUSES as readonly unknown[]).includes(value);

/** The request body, checked. Anything unrecognised or malformed is refused, never guessed. */
export function parseStatusChange(body: unknown): AdminAccountStatusChangeRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) invalid('The request must be a JSON object.');
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !['status', 'expectedStatus', 'reason'].includes(k));
  if (unknown.length > 0) invalid(`Unexpected field: ${unknown.join(', ')}.`);
  if (!isStatus(raw.status)) invalid(`status must be one of: ${ACCOUNT_STATUSES.join(', ')}.`);
  if (!isStatus(raw.expectedStatus)) invalid(`expectedStatus must be one of: ${ACCOUNT_STATUSES.join(', ')}.`);
  if (raw.status === raw.expectedStatus) invalid('status must differ from expectedStatus: a change goes from one status to the other.');
  if (typeof raw.reason !== 'string' || raw.reason.trim() === '') invalid('A reason is required.');
  const reason = raw.reason.trim();
  if (reason.length > ACCOUNT_STATUS_REASON_MAX) invalid(`The reason must be at most ${ACCOUNT_STATUS_REASON_MAX} characters.`);
  return { status: raw.status, expectedStatus: raw.expectedStatus, reason };
}

/** Suspends or reactivates one customer account. See the module comment for the rules. */
export async function changeAccountStatus(
  db: Db,
  userId: string,
  body: unknown,
  ctx: { actor: AuditActor & { userId: string }; requestId: string | null },
): Promise<AdminAccountStatusChangeResult> {
  if (typeof userId !== 'string' || !UUID.test(userId)) invalid('The User ID must be a user id.');
  const request = parseStatusChange(body);

  return db.transaction(async (tx) => {
    // NO KEY UPDATE: serialises status changes on this row without blocking
    // the inserts that merely reference it (a sign-in's session, a message).
    const [row] = await tx
      .select({ id: users.id, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
    if (!row) throw new AccountStatusError('user_not_found', `No user has the ID ${userId}.`);
    if (row.id === ctx.actor.userId) throw new AccountStatusError('own_account', 'You cannot change the status of your own account.');
    if (row.role !== 'user') {
      throw new AccountStatusError('staff_account', 'Only customer accounts can be suspended or reactivated here. This is a staff account.');
    }
    if (row.status !== request.expectedStatus) {
      throw new AccountStatusError(
        'status_conflict',
        `This account is ${row.status} now, not ${request.expectedStatus}: it changed since you loaded it. Nothing was changed.`,
        row.status,
      );
    }

    const [changed] = await tx
      .update(users)
      .set({ status: request.status, updatedAt: sql`now()` })
      .where(eq(users.id, userId))
      .returning({ changedAt: sql<string>`to_char(${users.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` });

    // A suspension ends every live session at once. They are expired rather
    // than deleted, so the sign-in history the admin read model shows is kept;
    // reactivating does not revive them -- the customer signs in afresh.
    const revoked =
      request.status === 'suspended'
        ? await tx
            .update(sessions)
            .set({ expiresAt: sql`now()` })
            .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, sql`now()`)))
            .returning({ id: sessions.id })
        : [];

    await recordAudit(tx, {
      actor: ctx.actor,
      action: request.status === 'suspended' ? 'account.status.suspend' : 'account.status.reactivate',
      objectType: ACCOUNT_STATUS_AUDIT_OBJECT_TYPE,
      objectId: userId,
      before: { status: row.status },
      after: { status: request.status },
      reason: request.reason,
      requestId: ctx.requestId,
      metadata: { source: ACCOUNT_STATUS_SOURCE, revokedSessions: revoked.length },
    });

    return {
      userId,
      previousStatus: row.status,
      status: request.status,
      changedAt: changed!.changedAt,
      revokedSessions: revoked.length,
    };
  });
}
