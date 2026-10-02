import { ANALYTICS_EVENT_PROPERTIES, creditBalanceState, isAnalyticsClientEvent } from '@over18/shared';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { Analytics } from '../services/analytics-service.js';
import { readContentAccess } from '../services/content-access.js';
import { readCustomerCommercialState } from '../services/customer-economy.js';

/** A client event is a name and a handful of ids and codes; anything bigger is not one. */
const BODY_LIMIT_BYTES = 4 * 1024;

/** Properties only the server may state, whatever a client sends. */
const SERVER_OWNED = ['tier', 'balanceState', 'decision', 'creditPrice'] as const;

/**
 * What the BROWSER may report (PR 3): that a customer SAW or DISMISSED
 * something -- a paywall, the Credits store, a locked clip. Nothing else.
 *
 * ONLY CLIENT EVENTS. Purchases, spends, unlocks and refunds are recorded by the
 * server after they commit; a browser claiming one is refused, so the funnel's
 * money steps can never be inflated from outside.
 *
 * ONLY SIGNED-IN CUSTOMERS, and only as themselves. The user is the session's;
 * nothing in the body can name another. An anonymous report is answered and
 * dropped -- funnels are per customer, and an open write endpoint would only be
 * a way to fill a table.
 *
 * FACTS ARE THE SERVER'S. The browser says only WHAT was seen (which surface,
 * which asset, which pack). The tier and the balance state come from the
 * customer's commercial state (P3.1), and a locked post's decision and price from
 * the content-access resolver (P4.2) -- read here, whatever the browser sent, so a
 * client cannot skew the free-tier funnels or report a price it was not shown.
 *
 * ONLY ALLOW-LISTED PROPERTIES. The shared per-event list keeps ids, short
 * codes, whole numbers and fixed values; everything else -- free text, emails,
 * URLs -- is dropped before storage.
 *
 * NOT RATE LIMITED. The API has no inbound per-user limiter to reuse (the one in
 * prompt-generation paces our own calls to a provider), and PR 3 adds no new
 * infrastructure for one. What bounds this endpoint is the session requirement
 * and the 4 KB body limit.
 *
 * NEVER IN THE WAY. The answer is always quick and always 202 for a well-formed
 * report, whether analytics is on, off or failing: the page that sent it does
 * not wait for it and must not learn anything from it.
 */
export default async function analyticsRoutes(app: FastifyInstance, opts: { db: Db; analytics: Analytics }) {
  app.post<{ Body: { name?: unknown; properties?: unknown } }>(
    '/api/analytics/events',
    { bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const body = request.body;
      const name = body && typeof body === 'object' ? body.name : undefined;
      if (typeof name !== 'string' || !isAnalyticsClientEvent(name)) {
        return reply.code(400).send({ error: 'invalid_event', message: 'Not an event a client may report.' });
      }
      const properties = body!.properties;
      if (properties !== undefined && (properties === null || typeof properties !== 'object' || Array.isArray(properties))) {
        return reply.code(400).send({ error: 'invalid_event', message: 'properties must be an object.' });
      }
      const user = request.currentUser;
      if (!user) return reply.code(202).send({ recorded: false });

      if (!opts.analytics.enabled) return reply.code(202).send({ recorded: false });
      // Dated on arrival, before the server's facts are read for it.
      const occurredAt = opts.analytics.now();
      const stated: Record<string, unknown> = { ...((properties ?? {}) as Record<string, unknown>) };
      for (const key of SERVER_OWNED) delete stated[key];
      const allowed = ANALYTICS_EVENT_PROPERTIES[name] ?? {};
      try {
        if ('tier' in allowed || 'balanceState' in allowed) {
          const state = await readCustomerCommercialState(opts.db, user);
          if ('tier' in allowed && state.tier.available) stated.tier = state.tier.value;
          if ('balanceState' in allowed) stated.balanceState = creditBalanceState(state.wallet.available ? state.wallet.value.spendable : null);
        }
        if ('decision' in allowed && typeof stated.assetId === 'string') {
          const [item] = (await readContentAccess(opts.db, user, [stated.assetId])).items;
          stated.decision = item?.decision;
          stated.creditPrice = item?.creditPrice;
        }
      } catch {
        /* a fact that cannot be read is left out, never taken from the browser */
      }
      const recorded = await opts.analytics.emit(name, {
        userId: user.id,
        properties: stated,
        source: 'client',
        requestId: request.id,
        occurredAt,
      });
      return reply.code(202).send({ recorded });
    },
  );
}
