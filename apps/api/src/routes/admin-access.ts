import type { FastifyInstance, FastifyReply } from 'fastify';
import { ADMIN_ROLES, type AdminRoleName } from '@over18/shared';
import type { Db } from '../db/client.js';
import {
  AdminRoleError,
  adminAccessFor,
  grantAdminRole,
  listStaff,
  revokeAdminRole,
} from '../services/admin-permissions-service.js';
import {
  AUDIT_EXPORT_MAX,
  auditEntriesToCsv,
  listAuditEntries,
  type AuditQuery,
} from '../services/audit-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin -> access, roles and audit (PRD v1.2 §34). Build step 0c.
 *
 * Every route is staff-only. The ones that expose or change who may do what
 * additionally require a named permission, which -- while enforcement is off --
 * any staff member holds.
 */
export default async function adminAccessRoutes(
  app: FastifyInstance,
  opts: { db: Db; permissionsEnforced: boolean; auditEnabled: boolean },
) {
  /**
   * What the signed-in operator may see. Staff-only but permission-free: the
   * admin shell needs it to decide what to render, including for an operator
   * whose role grants almost nothing.
   */
  app.get('/admin/me/access', { preHandler: app.requireAdmin }, async (request) => {
    const { granted: _granted, ...view } = await adminAccessFor(opts.db, request.currentUser!, {
      enforced: opts.permissionsEnforced,
      auditLogEnabled: opts.auditEnabled,
    });
    return view;
  });

  /* ---------------- audit ---------------- */

  const parseAuditQuery = (raw: Record<string, string | undefined>): AuditQuery | null => {
    const query: AuditQuery = {};
    if (raw.limit !== undefined) {
      const limit = Number.parseInt(raw.limit, 10);
      if (!Number.isFinite(limit)) return null;
      query.limit = limit;
    }
    if (raw.before !== undefined) {
      const before = Number.parseInt(raw.before, 10);
      if (!Number.isFinite(before) || before < 1) return null;
      query.before = before;
    }
    if (raw.objectType) query.objectType = raw.objectType;
    if (raw.actorUserId) {
      if (!UUID_RE.test(raw.actorUserId)) return null;
      query.actorUserId = raw.actorUserId;
    }
    return query;
  };

  const badQuery = (reply: FastifyReply) =>
    reply.code(400).send({ error: 'invalid_request', message: 'Invalid audit query.' });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/admin/audit',
    { preHandler: app.requirePermission('audit.read') },
    async (request, reply) => {
      const query = parseAuditQuery(request.query);
      if (!query) return badQuery(reply);
      return listAuditEntries(opts.db, query);
    },
  );

  /**
   * CSV export. Bounded: an export is evidence for a dispute window, not a
   * database dump, and an unbounded one would stream the whole table on a
   * single click.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/admin/audit/export.csv',
    { preHandler: app.requirePermission('audit.export') },
    async (request, reply) => {
      const query = parseAuditQuery(request.query);
      if (!query) return badQuery(reply);
      const { entries } = await listAuditEntries(
        opts.db,
        { ...query, limit: query.limit ?? AUDIT_EXPORT_MAX },
        AUDIT_EXPORT_MAX,
      );
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="over18-audit.csv"');
      reply.header('cache-control', 'private, no-store');
      return reply.send(auditEntriesToCsv(entries));
    },
  );

  /* ---------------- roles ---------------- */

  app.get('/admin/roles', { preHandler: app.requirePermission('roles.manage') }, async () => ({
    roles: ADMIN_ROLES,
    staff: await listStaff(opts.db),
  }));

  const roleChangeSchema = {
    body: {
      type: 'object',
      required: ['reason'],
      additionalProperties: false,
      properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
    },
  } as const;

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AdminRoleError) {
      const status =
        error.code === 'user_not_found' ? 404 : error.code === 'last_administrator' ? 409 : 400;
      return reply.code(status).send({ error: error.code, message: error.message });
    }
    throw error;
  };

  for (const verb of ['grant', 'revoke'] as const) {
    app.post<{ Params: { userId: string; role: string }; Body: { reason: string } }>(
      `/admin/roles/:userId/:role/${verb}`,
      {
        preHandler: app.requirePermission('roles.manage'),
        schema: roleChangeSchema,
        // The service writes the audit entry itself, with the real before and
        // after, inside the same transaction as the change.
        config: { auditHandled: true },
      },
      async (request, reply) => {
        const { userId, role } = request.params;
        if (!UUID_RE.test(userId)) {
          return reply.code(404).send({ error: 'user_not_found', message: 'User not found.' });
        }
        if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
          return reply.code(400).send({ error: 'invalid_role', message: 'Unknown role.' });
        }
        const change = {
          actor: { userId: request.currentUser!.id, email: request.currentUser!.email },
          userId,
          role: role as AdminRoleName,
          reason: request.body.reason,
          requestId: request.id,
        };
        try {
          const roles =
            verb === 'grant'
              ? await grantAdminRole(opts.db, change)
              : await revokeAdminRole(opts.db, change);
          return { userId, roles };
        } catch (error) {
          return failed(reply, error);
        }
      },
    );
  }
}
