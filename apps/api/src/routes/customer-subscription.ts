import type { EconomyUnavailableResponse } from '@over18/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { readCustomerSubscriptionDetail } from '../services/customer-economy.js';
import { cancelOwnSubscription, SubscriptionError } from '../services/subscription-service.js';

const ECONOMY_UNAVAILABLE: EconomyUnavailableResponse = {
  error: 'economy_unavailable',
  reason: 'economy_disabled',
  message: 'The economy is not available yet.',
};

/**
 * MANAGING ONE'S OWN SUBSCRIPTION (customer self-service).
 *
 * THE SUBSCRIBER IS ALWAYS `request.currentUser`. No path, query or body names
 * an account, so neither route can read or cancel somebody else's
 * subscription -- the same rule the rest of the customer API follows.
 *
 * ONLY CANCELLATION IS OFFERED, and that is a statement about the billing
 * system rather than about this page. The subscription engine's `change_plan`
 * moves no money, prorates nothing and keeps the period end, so exposing it
 * would hand out Premium that nobody paid for (annual -> monthly) or upgrades
 * nobody was charged for (monthly -> annual). Until proration and a renewal
 * engine exist, a plan change is not a thing a customer can safely be offered,
 * so it is not offered.
 *
 * NOR IS RESUMING. `subscriptionActions` allows nothing from `cancelled` back
 * to `active`, so there is no un-cancel to expose; inventing one here would be
 * inventing a lifecycle the rest of the system does not have.
 *
 * CANCELLING CALLS NO PROVIDER. Nothing renews a subscription, so there is no
 * future charge to stop: cancelling records that Premium ends when the paid
 * period does, which is entirely our own state. That is also why it works
 * identically with the fake provider and with none at all.
 *
 * GATED WITH THE REST OF THE ECONOMY: 503 while ECONOMY_ENABLED is off, matching
 * `/api/me/commercial-state`, which is where the page learns it is Premium in
 * the first place.
 */
export default async function customerSubscriptionRoutes(
  app: FastifyInstance,
  opts: { db: Db; commerce: Pick<CommerceEnv, 'enabled'> },
) {
  /** True when the request may proceed; otherwise the 503 has already been sent. */
  const ready = (reply: FastifyReply): boolean => {
    if (!opts.commerce.enabled) {
      reply.code(503).send(ECONOMY_UNAVAILABLE);
      return false;
    }
    return true;
  };

  /** The subscription this customer holds, or null. Reads and changes nothing. */
  app.get('/api/me/subscription', { preHandler: app.requireAuth }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    if (!ready(reply)) return reply;
    return { subscription: await readCustomerSubscriptionDetail(opts.db, request.currentUser!.id) };
  });

  /**
   * Cancels at the end of the period already paid for: Premium continues until
   * `currentPeriodEnd` and then expires. The reply is the subscription as it now
   * stands, so the page renders the server's answer rather than its own guess at
   * what cancelling did.
   *
   * A customer who is already cancelled, or has no subscription, is refused by
   * the engine's own state machine (409) -- this route makes no second judgement
   * about what is allowed.
   */
  app.post('/api/me/subscription/cancel', { preHandler: app.requireAuth }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    if (!ready(reply)) return reply;
    const userId = request.currentUser!.id;
    try {
      await cancelOwnSubscription(opts.db, userId, request.id);
    } catch (error) {
      if (error instanceof SubscriptionError) {
        return reply.code(409).send({ error: error.code, message: error.message });
      }
      throw error;
    }
    return { subscription: await readCustomerSubscriptionDetail(opts.db, userId) };
  });
}
