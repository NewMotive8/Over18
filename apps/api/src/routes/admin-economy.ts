import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { parsePreviewInputs, previewEconomy } from '../services/economy-preview.js';

/**
 * P1.3 -- the economy preview (PRD v1.2 §31), for an authorised admin.
 *
 * READ-ONLY. It is a POST only because its inputs (provider rates and usage,
 * sales-channel deductions, other costs, margin floors) are structured data
 * that does not belong in a URL. None has a default. It publishes,
 * schedules and stores nothing, and touches no wallet, payment or entitlement.
 * With ADMIN_AUDIT_ENABLED on, the generic audit hook records the call like any
 * other admin POST -- a record of who ran a preview, never of a change.
 *
 * `economy.manage` is the §31 permission already in the P0 catalogue; while
 * permission enforcement is off, `requirePermission` falls back to "is an
 * admin", exactly as every other admin route does.
 *
 * NOT A CUSTOMER SURFACE, AND NOT A SWITCH. Nothing here is reachable without
 * an admin session, and nothing here makes any economy behaviour live.
 */
export default async function adminEconomyRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.post(
    '/admin/economy/preview',
    { preHandler: app.requirePermission('economy.manage') },
    async (request, reply) => {
      const parsed = parsePreviewInputs(request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: 'invalid_preview_input', messages: parsed.errors });
      }
      return previewEconomy(opts.db, parsed.value);
    },
  );
}
