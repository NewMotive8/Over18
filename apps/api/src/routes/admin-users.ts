import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { AccountStatusError, changeAccountStatus } from '../services/account-status-service.js';
import { adminAccessFor } from '../services/admin-permissions-service.js';
import { AdminUserError, listUsers, readUserDetail } from '../services/admin-user-service.js';

/**
 * Admin -> Users -- a thin HTTP boundary over `services/admin-user-service.ts`
 * (the P2.5.1 read model) and `services/account-status-service.ts` (P2.5.2).
 *
 * STAFF ONLY, BY PERMISSION: reading needs `users.commercial.read` -- the
 * §34.1 permission to read a user's commercial state and ledger -- through the
 * existing `requirePermission` (401 / 403; with enforcement off, any staff
 * member, as for every admin route). The audit panel additionally needs
 * `audit.read`, decided exactly as `/admin/audit` decides it. Changing an
 * account's status needs `users.status.manage`, held by the administrator role
 * alone.
 *
 * Neither reading nor the account status depends on the economy switch: the
 * status is not commercial.
 */
export default async function adminUserRoutes(
  app: FastifyInstance,
  opts: { db: Db; commerce: Pick<CommerceEnv, 'enabled'>; permissionsEnforced: boolean; auditEnabled: boolean },
) {
  const read = { preHandler: app.requirePermission('users.commercial.read') };
  // The service writes the audit record itself, with the real before and
  // after, inside the same transaction as the change.
  const manageStatus = { preHandler: app.requirePermission('users.status.manage'), config: { auditHandled: true } };

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
