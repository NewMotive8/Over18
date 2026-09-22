import { randomUUID } from 'node:crypto';
import type { SimulatedOutcome } from '@over18/shared';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { FAKE_SIGNATURE_HEADER, signFakePayload } from '../commerce/fake-providers.js';
import type { PaymentProvider } from '../commerce/payment-provider.js';
import { PaymentError, ingestPaymentEvent, type IngestOutcome } from './payment-service.js';

/**
 * THE SIMULATED PAYMENT (P9, ahead of P9.D1).
 *
 * The processor is not chosen yet, and choosing one is weeks of underwriting
 * (P9.D1). This module lets the whole customer purchase experience be built and
 * reviewed in the meantime, by producing the ONE thing a real processor would
 * produce: a signed event saying what happened to a payment.
 *
 * ── IT IS A PROVIDER, NOT A SHORTCUT ─────────────────────────────────────────
 *
 * Nothing here activates Premium, grants Credits or writes commercial state. It
 * builds an event, signs it exactly as the fake provider signs one, and hands
 * the raw bytes to `ingestPaymentEvent` -- the same function, with the same
 * signature check, the same store-first rule and the same exactly-once
 * guarantee that a real processor's webhook will call. The commercial logic
 * cannot tell the difference, and that is the point:
 *
 *     simulated event  ─┐
 *                       ├─> ingestPaymentEvent ─> subscription + Credits
 *     real webhook     ─┘
 *
 * Replacing the left-hand side with a real processor is an adapter and a route;
 * it is not a change to subscriptions, the ledger or content access.
 *
 * ── IT CANNOT EXIST IN PRODUCTION ────────────────────────────────────────────
 *
 * It works only while the selected payment provider is the fake one, and
 * `commerce/fake-provider-policy.ts` builds a fake ONLY in an explicit
 * development or test process that is not running on Railway. Two independent
 * locks already enforce that (`loadEnv` and `selectPaymentProvider`); this
 * module adds a third check of its own rather than trusting either.
 */

/** The event a simulated outcome produces. */
const EVENT_TYPE: Record<SimulatedOutcome, 'payment_succeeded' | 'payment_failed'> = {
  success: 'payment_succeeded',
  // A cancellation IS a payment that did not happen. The provider interface has
  // no separate cancelled event, and inventing one here would put a concept in
  // the commercial logic that no real processor would send.
  failure: 'payment_failed',
  cancel: 'payment_failed',
};

const FAILURE_REASON: Record<string, string> = {
  failure: 'Simulated decline.',
  cancel: 'Simulated cancellation by the customer.',
};

export interface SimulateInput {
  checkoutRef: string;
  outcome: SimulatedOutcome;
  amountMinor: number;
  currency: string;
  /** Forces a replay of a specific delivery. Tests use it; the UI does not. */
  eventRef?: string;
}

/**
 * Builds one signed provider event and feeds it through the real ingestion path.
 *
 * `secret` must be the same secret the fake provider verifies with, which is
 * why the caller passes the provider it built alongside it -- a mismatch would
 * be rejected as a bad signature, which is the correct outcome rather than a
 * special case.
 */
export async function simulatePaymentEvent(
  db: Db,
  commerce: Pick<CommerceEnv, 'enabled'>,
  provider: PaymentProvider,
  secret: string,
  input: SimulateInput,
): Promise<IngestOutcome> {
  if (provider.name !== 'fake') {
    throw new PaymentError('payments_unavailable', 'Simulated payments exist only for the fake provider.');
  }
  const type = EVENT_TYPE[input.outcome];
  const body =
    type === 'payment_succeeded'
      ? {
          id: input.eventRef ?? `evt_${input.checkoutRef}_success`,
          type,
          occurredAt: new Date().toISOString(),
          data: {
            checkoutRef: input.checkoutRef,
            transactionRef: `txn_${randomUUID()}`,
            amountMinor: input.amountMinor,
            currency: input.currency,
          },
        }
      : {
          id: input.eventRef ?? `evt_${input.checkoutRef}_${input.outcome}`,
          type,
          occurredAt: new Date().toISOString(),
          data: { checkoutRef: input.checkoutRef, reason: FAILURE_REASON[input.outcome] ?? 'Simulated failure.' },
        };

  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  return ingestPaymentEvent(db, commerce, provider, {
    headers: { [FAKE_SIGNATURE_HEADER]: signFakePayload(secret, rawBody) },
    rawBody,
  });
}
