import type { EconomyUnavailableResponse, SimulatedOutcome } from '@over18/shared';
import { SIMULATED_OUTCOMES } from '@over18/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import type { PaymentProvider } from '../commerce/payment-provider.js';
import {
  PaymentError,
  readPayment,
  readPaymentByCheckout,
  startCheckout,
  type PaymentErrorCode,
} from '../services/payment-service.js';
import { simulatePaymentEvent } from '../services/simulated-payment.js';

const ECONOMY_UNAVAILABLE: EconomyUnavailableResponse = {
  error: 'economy_unavailable',
  reason: 'economy_disabled',
  message: 'The economy is not available yet.',
};

const PAYMENTS_UNAVAILABLE = {
  error: 'payments_unavailable',
  message: 'No payment provider is configured.',
};

const STATUS: Partial<Record<PaymentErrorCode, number>> = {
  invalid_request: 400,
  unknown_plan: 404,
  plan_unavailable: 409,
  already_subscribed: 409,
  payment_not_found: 404,
  economy_disabled: 503,
  payments_unavailable: 503,
};

/**
 * The customer payment API (P9.1) -- start a checkout, see what happened, and,
 * while the processor is undecided, drive a SIMULATED payment.
 *
 * EVERY ROUTE REQUIRES A SESSION, and the customer is always
 * `request.currentUser`: nothing in a path or body can buy for another account.
 * No price is ever read from the client -- the plan code is, and the server
 * resolves what it costs.
 *
 * NOTHING HERE GRANTS ANYTHING. Starting a checkout records a pending payment.
 * Premium and Credits come only from `ingestPaymentEvent`, which acts on a
 * signed provider event; a browser return, a refreshed success page or a
 * hand-edited URL produces nothing at all.
 *
 * DARK UNTIL SWITCHED ON, twice over: every route answers 503 while
 * ECONOMY_ENABLED is off, and again when no payment provider is configured.
 * The simulation route additionally exists only for the fake provider, which
 * cannot be built in production (commerce/fake-provider-policy.ts).
 */
export default async function customerPaymentRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    commerce: Pick<CommerceEnv, 'enabled'>;
    /** Null when no provider is configured -- then every route is 503. */
    provider: PaymentProvider | null;
    /** The secret the fake provider signs with. Only used to simulate. */
    fakeSecret: string;
  },
) {
  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof PaymentError) {
      return reply.code(STATUS[error.code] ?? 400).send({ error: error.code, message: error.message });
    }
    throw error;
  };

  /** Available only when the economy is on AND a provider exists. */
  const ready = (reply: FastifyReply): PaymentProvider | null => {
    if (!opts.commerce.enabled) {
      reply.code(503).send(ECONOMY_UNAVAILABLE);
      return null;
    }
    if (!opts.provider) {
      reply.code(503).send(PAYMENTS_UNAVAILABLE);
      return null;
    }
    return opts.provider;
  };

  /**
   * Starts a checkout for one plan. Records a PENDING payment and returns
   * where to pay; activates nothing.
   */
  app.post<{ Body: { planCode?: unknown; method?: unknown; idempotencyKey?: unknown; returnUrl?: unknown } }>(
    '/api/payments/checkout',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const provider = ready(reply);
      if (!provider) return reply;
      try {
        return await startCheckout(opts.db, opts.commerce, provider, {
          userId: request.currentUser!.id,
          planCode: String(request.body?.planCode ?? ''),
          methodHint: String(request.body?.method ?? ''),
          idempotencyKey: typeof request.body?.idempotencyKey === 'string' ? request.body.idempotencyKey : '',
          returnUrl: typeof request.body?.returnUrl === 'string' ? request.body.returnUrl : '/subscription',
        });
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /** One of this customer's payments, so the app can show what happened. */
  app.get<{ Params: { paymentId: string } }>('/api/payments/:paymentId', { preHandler: app.requireAuth }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    if (!opts.commerce.enabled) return reply.code(503).send(ECONOMY_UNAVAILABLE);
    try {
      const payment = await readPayment(opts.db, request.currentUser!.id, request.params.paymentId);
      return payment ?? reply.code(404).send({ error: 'payment_not_found', message: 'No such payment.' });
    } catch (error) {
      return failed(reply, error);
    }
  });

  /** The payment behind a checkout reference, for the simulated checkout screen. */
  app.get<{ Params: { checkoutRef: string } }>(
    '/api/payments/checkout/:checkoutRef',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (!opts.commerce.enabled) return reply.code(503).send(ECONOMY_UNAVAILABLE);
      try {
        const payment = await readPaymentByCheckout(opts.db, request.currentUser!.id, request.params.checkoutRef);
        return payment ?? reply.code(404).send({ error: 'payment_not_found', message: 'No such checkout.' });
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /**
   * SIMULATES a provider confirming, declining or losing a payment.
   *
   * TEST ONLY, and structurally impossible in production: it requires the fake
   * provider, which is built only in an explicit development/test process off
   * Railway. It produces a signed event and feeds it through the SAME ingestion
   * a real webhook will use -- so what it exercises is the real path, not a
   * shortcut around it.
   */
  app.post<{ Body: { checkoutRef?: unknown; outcome?: unknown; eventRef?: unknown } }>(
    '/api/payments/simulate',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const provider = ready(reply);
      if (!provider) return reply;
      if (provider.name !== 'fake') {
        return reply.code(503).send({ error: 'payments_unavailable', message: 'Simulated payments are not available.' });
      }

      const checkoutRef = typeof request.body?.checkoutRef === 'string' ? request.body.checkoutRef : '';
      const outcome = request.body?.outcome as SimulatedOutcome;
      if (!(SIMULATED_OUTCOMES as readonly string[]).includes(outcome)) {
        return reply.code(400).send({ error: 'invalid_request', message: `outcome must be one of: ${SIMULATED_OUTCOMES.join(', ')}.` });
      }

      try {
        // The customer may only simulate against their OWN checkout.
        const payment = await readPaymentByCheckout(opts.db, request.currentUser!.id, checkoutRef);
        if (!payment) return reply.code(404).send({ error: 'payment_not_found', message: 'No such checkout.' });

        const result = await simulatePaymentEvent(opts.db, opts.commerce, provider, opts.fakeSecret, {
          checkoutRef,
          outcome,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          eventRef: typeof request.body?.eventRef === 'string' ? request.body.eventRef : undefined,
        });
        return { status: result.status, payment: await readPayment(opts.db, request.currentUser!.id, payment.id) };
      } catch (error) {
        return failed(reply, error);
      }
    },
  );
}
