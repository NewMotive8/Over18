import fp from 'fastify-plugin';
import type { Db } from '../db/client.js';
import { recordAudit } from '../services/audit-service.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Set on an admin route whose handler writes its own, richer audit entry
     * (with the real before/after) inside the change's transaction. The
     * generic hook then stays out of the way instead of logging it twice.
     */
    auditHandled?: boolean;
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The generic admin-write audit hook (PRD v1.2 §34.2). OFF unless
 * ADMIN_AUDIT_ENABLED is exactly "true".
 *
 * Every successful write to an `/admin` route gets one entry naming who called
 * which route on which ids. It covers every existing admin screen without
 * touching a single existing handler.
 *
 * WHAT IT DELIBERATELY DOES NOT RECORD:
 *
 *   - Request bodies. They carry credentials (the Drive OAuth exchange),
 *     uploaded file metadata and free text. Recording them would turn the
 *     audit log into the most sensitive table in the database.
 *   - Before and after values. A request hook cannot know them; recording a
 *     guess would be worse than recording nothing. Services that change money,
 *     access or roles write their own entries with the real values.
 *   - Refused writes. A 4xx or 5xx changed nothing, so it is not a change.
 *
 * AFTER THE RESPONSE, AND NEVER FATAL. It runs on `onResponse`, when the change
 * has already committed, so a failure to write the audit row is logged loudly
 * but cannot undo or fail an operator's action. Anything that must be audited
 * atomically with its change does so inside its own transaction instead.
 */
export default fp(async function adminAuditPlugin(app, opts: { db: Db; enabled: boolean }) {
  if (!opts.enabled) return;

  app.addHook('onResponse', async (request, reply) => {
    if (READ_METHODS.has(request.method)) return;
    if (reply.statusCode >= 400) return;
    const route = request.routeOptions.url;
    if (!route || !route.startsWith('/admin/')) return;
    if (request.routeOptions.config?.auditHandled) return;
    const user = request.currentUser;
    if (!user) return;

    const params = (request.params ?? {}) as Record<string, unknown>;
    const firstParam = Object.values(params).find((v) => typeof v === 'string') as
      | string
      | undefined;

    try {
      await recordAudit(opts.db, {
        actor: { userId: user.id, email: user.email },
        action: `${request.method} ${route}`,
        objectType: 'admin_route',
        objectId: firstParam ?? null,
        requestId: request.id,
        metadata: { params, statusCode: reply.statusCode },
      });
    } catch (err) {
      request.log.error({ err, route }, 'admin audit entry could not be written');
    }
  });
});
