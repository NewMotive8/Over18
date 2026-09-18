import type { EconomyUnavailableResponse } from '@over18/shared';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { readCustomerCatalog, readCustomerCommercialState } from '../services/customer-economy.js';

const ECONOMY_UNAVAILABLE: EconomyUnavailableResponse = {
  error: 'economy_unavailable',
  reason: 'economy_disabled',
  message: 'The economy is not available yet.',
};

/**
 * The customer economy read API -- a thin HTTP boundary over the P1.2
 * resolver (`services/customer-economy.ts`).
 *
 * EVERY ROUTE REQUIRES A SESSION (401 otherwise), and the user is taken only
 * from `request.currentUser`: nothing in a path, query or body can name
 * another account, and no client-supplied price or Credit value is read.
 *
 * DARK UNTIL SWITCHED ON. While ECONOMY_ENABLED is off every route answers 503
 * `economy_unavailable` -- the same 503 convention as `uploads_unavailable` and
 * `ai_not_configured` -- and reads nothing, so no price, plan or balance can
 * reach a customer before the economy is activated.
 *
 * READ-ONLY. GET only; nothing here writes, reserves, charges or grants.
 * Responses are per-session, so never cacheable by a shared cache.
 */
export default async function customerEconomyRoutes(
  app: FastifyInstance,
  opts: { db: Db; commerce: Pick<CommerceEnv, 'enabled'> },
) {
  /** The published, in-effect plans and Credit packs. */
  app.get('/api/economy/catalog', { preHandler: app.requireAuth }, async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
    if (!opts.commerce.enabled) return reply.code(503).send(ECONOMY_UNAVAILABLE);
    return readCustomerCatalog(opts.db);
  });

  /** The signed-in customer's own commercial state, as far as it is known. */
  app.get('/api/me/commercial-state', { preHandler: app.requireAuth }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    if (!opts.commerce.enabled) return reply.code(503).send(ECONOMY_UNAVAILABLE);
    return readCustomerCommercialState(request.currentUser!);
  });
}
