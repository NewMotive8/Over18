import type { EconomyUnavailableResponse } from '@over18/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { AccountStatusError, changeAccountStatus } from '../services/account-status-service.js';
import { adminAccessFor } from '../services/admin-permissions-service.js';
import { AdminSubscriptionError, changeUserSubscription, readUserSubscription } from '../services/admin-subscription-service.js';
import { AdminUserError, listUsers, readUserDetail } from '../services/admin-user-service.js';
import { SubscriptionError } from '../services/subscription-service.js';

const SUBSCRIPTION_CHANGES_UNAVAILABLE: EconomyUnavailableResponse = {
  error: 'economy_unavailable',
  reason: 'economy_disabled',
  message: 'Subscription changes are unavailable while the economy is switched off.',
};

/**
 * Admin -> Users -- a thin HTTP boundary over `services/admin-user-service.ts`
 * (the P2.5.1 read model), `services/account-status-service.ts` (P2.5.2) and
 * `services/admin-subscription-service.ts` (P3.5).
 *
 * STAFF ONLY, BY PERMISSION: reading needs `users.commercial.read` -- the
 * §34.1 permission to read a user's commercial state and ledger -- through the
 * existing `requirePermission` (401 / 403; with enforcement off, any staff
 * member, as for every admin route). The audit panel additionally needs
 * `audit.read`, decided exactly as `/admin/audit` decides it. Changing an
 * account's status needs `users.status.manage`, and changing a subscription
 * (P3.5) needs `users.subscription.manage` -- each held by the administrator
 * role alone.
 *
 * Reading never depends on the economy switch, and neither does the account
 * status, which is not commercial. A subscription change does: while the
 * economy is off it is refused (503) before anything is read or written, as a
 * wallet adjustment is.
 */
export default async function adminUserRoutes(
  app: FastifyInstance,
  opts: { db: Db; commerce: Pick<CommerceEnv, 'enabled'>; permissionsEnforced: boolean; auditEnabled: boolean },
) {
  const read = { preHandler: app.requirePermission('users.commercial.read') };
  // The service writes the audit record itself, with the real before and
  // after, inside the same transaction as the change.
  const manageStatus = { preHandler: app.requirePermission('users.status.manage'), config: { auditHandled: true } };
  const manageSubscription = { preHandler: app.requirePermission('users.subscription.manage'), config: { auditHandled: true } };

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AdminUserError) {
      return reply.code(error.code === 'user_not_found' ? 404 : 400).send({ error: error.code, message: error.message });
    }
    if (error instanceof AccountStatusError) {
      const status = error.code === 'user_not_found' ? 404 : error.code === 'invalid_request' ? 400 : 409;
      return reply.code(status).send({
        error: error.code,
        message: error.message,
        ...(error.currentStatus ? { currentStatus: error.currentStatus } : {}),
      });
    }
    if (error instanceof AdminSubscriptionError) {
      const status = error.code === 'user_not_found' ? 404 : error.code === 'invalid_request' ? 400 : 409;
      return reply.code(status).send({ error: error.code, message: error.message });
    }
    if (error instanceof SubscriptionError) {
      return reply.code(error.code === 'unknown_plan' ? 400 : 409).send({
        error: error.code,
        message: error.message,
        ...(error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}),
      });
    }
    throw error;
  };

  /** Search, filter and page through users, newest first. */
  app.get<{ Querystring: Record<string, unknown> }>('/admin/users', read, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    try {
      return await listUsers(opts.db, request.query ?? {});
    } catch (error) {
      return failed(reply, error);
    }
  });

  /** One user, by permanent User ID: identity, account, activity, commercial state, wallets, audit. */
  app.get<{ Params: { userId: string } }>('/admin/users/:userId', read, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    try {
      const access = await adminAccessFor(opts.db, request.currentUser!, {
        enforced: opts.permissionsEnforced,
        auditLogEnabled: opts.auditEnabled,
      });
      return await readUserDetail(opts.db, request.params.userId, {
        economyEnabled: opts.commerce.enabled,
        auditVisible: access.permissions.includes('audit.read'),
        operator: { userId: request.currentUser!.id, canManageStatus: access.permissions.includes('users.status.manage') },
      });
    } catch (error) {
      return failed(reply, error);
    }
  });

  /** The subscription, its history, the assignable plans, and whether this operator may change it. */
  app.get<{ Params: { userId: string } }>('/admin/users/:userId/subscription', read, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    try {
      const access = await adminAccessFor(opts.db, request.currentUser!, {
        enforced: opts.permissionsEnforced,
        auditLogEnabled: opts.auditEnabled,
      });
      return await readUserSubscription(opts.db, request.params.userId, {
        economyEnabled: opts.commerce.enabled,
        operator: { userId: request.currentUser!.id, canManage: access.permissions.includes('users.subscription.manage') },
      });
    } catch (error) {
      return failed(reply, error);
    }
  });

  /** Assign, change, cancel or end the subscription: the change, its history and its audit record, together. */
  app.post<{ Params: { userId: string } }>('/admin/users/:userId/subscription', manageSubscription, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    if (!opts.commerce.enabled) return reply.code(503).send(SUBSCRIPTION_CHANGES_UNAVAILABLE);
    try {
      return await changeUserSubscription(opts.db, request.params.userId, request.body, {
        actor: { userId: request.currentUser!.id, email: request.currentUser!.email },
        requestId: request.id,
      });
    } catch (error) {
      return failed(reply, error);
    }
  });

  /** Suspend or reactivate a customer account: the change and its audit record, together. */
  app.post<{ Params: { userId: string } }>('/admin/users/:userId/status', manageStatus, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    try {
      return await changeAccountStatus(opts.db, request.params.userId, request.body, {
        actor: { userId: request.currentUser!.id, email: request.currentUser!.email },
        requestId: request.id,
      });
    } catch (error) {
      return failed(reply, error);
    }
  });
}
