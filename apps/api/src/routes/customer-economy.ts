import type { EconomyUnavailableResponse } from '@over18/shared';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { ContentAccessError, parseAssetIds, readContentAccess } from '../services/content-access.js';
import { ContentUnlockError, unlockContent, type ContentUnlockErrorCode } from '../services/content-unlock-service.js';
import { readCustomerCatalog, readCustomerCommercialState } from '../services/customer-economy.js';

const ECONOMY_UNAVAILABLE: EconomyUnavailableResponse = {
  error: 'economy_unavailable',
  reason: 'economy_disabled',
  message: 'The economy is not available yet.',
};

/**
 * The customer economy read API -- a thin HTTP boundary over the P1.2
 * resolver (`services/customer-economy.ts`) and the P4.2 content access
 * resolver (`services/content-access.ts`).
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
 * ONE ROUTE WRITES, AND IT IS THE UNLOCK (P8.2). Everything else is a read
 * that reserves, charges and grants nothing. The unlock takes only an asset id
 * and an idempotency key: no price, Credit amount or entitlement can be named
 * by a client, and what it costs is read from the content's own offer on the
 * server. Responses are per-session, so never cacheable by a shared cache.
 */

/** What each unlock refusal means over HTTP. Anything unmapped is a 400. */
const UNLOCK_STATUS: Partial<Record<ContentUnlockErrorCode, number>> = {
  unavailable: 404,
  not_owned: 404,
  age_restricted: 403,
  premium_required: 403,
  insufficient_credits: 402,
  not_purchasable: 409,
  price_changed: 409,
  purchase_reversed: 409,
  economy_disabled: 503,
};
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
    return readCustomerCommercialState(opts.db, request.currentUser!);
  });

  /**
   * What this customer may do with the content they are looking at (P4.2):
   * one decision per asset, made by the server from the content's own terms
   * and this customer's commercial state. Nothing is charged or unlocked.
   */
  app.get<{ Querystring: { assetIds?: unknown } }>('/api/content/access', { preHandler: app.requireAuth }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    if (!opts.commerce.enabled) return reply.code(503).send(ECONOMY_UNAVAILABLE);
    try {
      return await readContentAccess(opts.db, request.currentUser!, parseAssetIds(request.query?.assetIds));
    } catch (error) {
      if (error instanceof ContentAccessError) return reply.code(400).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  /**
   * Unlocks one piece of Credit-priced content (P8.2): reserve the offer's
   * price, record the ownership, consume the Credits -- atomically, on the
   * server. The customer is always `request.currentUser`, so no body can buy
   * content for another account.
   *
   * A repeat of the same request, and a request for content already owned, both
   * answer with the ownership and charge nothing.
   */
  app.post<{ Params: { assetId: string }; Body: { idempotencyKey?: unknown } }>(
    '/api/content/:assetId/unlock',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (!opts.commerce.enabled) return reply.code(503).send(ECONOMY_UNAVAILABLE);
      try {
        return await unlockContent(opts.db, opts.commerce, request.currentUser!, {
          assetId: request.params.assetId,
          idempotencyKey: typeof request.body?.idempotencyKey === 'string' ? request.body.idempotencyKey : '',
          requestId: request.id,
        });
      } catch (error) {
        if (error instanceof ContentUnlockError) {
          return reply.code(UNLOCK_STATUS[error.code] ?? 400).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );
}
