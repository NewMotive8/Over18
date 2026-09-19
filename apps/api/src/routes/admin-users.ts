import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { adminAccessFor } from '../services/admin-permissions-service.js';
import { AdminUserError, listUsers, readUserDetail } from '../services/admin-user-service.js';

/**
 * Admin -> Users (P2.5.1) -- a thin HTTP boundary over
 * `services/admin-user-service.ts`. READ-ONLY: GET only.
 *
 * STAFF ONLY, BY PERMISSION: both routes need `users.commercial.read` -- the
 * §34.1 permission to read a user's commercial state and ledger -- through the
 * existing `requirePermission` (401 / 403; with enforcement off, any staff
 * member, as for every admin route). The audit panel additionally needs
 * `audit.read`, decided exactly as `/admin/audit` decides it.
 *
 * Reading never depends on the economy switch: the detail says whether it is on.
 */
export default async function adminUserRoutes(
  app: FastifyInstance,
  opts: { db: Db; commerce: Pick<CommerceEnv, 'enabled'>; permissionsEnforced: boolean; auditEnabled: boolean },
) {
  const read = { preHandler: app.requirePermission('users.commercial.read') };

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AdminUserError) {
      return reply.code(error.code === 'user_not_found' ? 404 : 400).send({ error: error.code, message: error.message });
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
      });
    } catch (error) {
      return failed(reply, error);
    }
  });
}
