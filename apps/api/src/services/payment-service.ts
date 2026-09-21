import { and, eq, sql } from 'drizzle-orm';
import type { CustomerCheckout, CustomerPaymentView } from '@over18/shared';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { paymentEvents, payments, type PaymentRow } from '../db/schema.js';
import type { PaymentProvider, ParsedPaymentWebhook, WebhookInput } from '../commerce/payment-provider.js';
import { economyNow, resolvePlanVersion } from './economy-resolver.js';
import { changeSubscription, readSubscriptionRecord } from './subscription-service.js';
import { CREDITS_CURRENCY, grantCredits } from './wallet-service.js';

/**
 * PAYMENTS -> COMMERCIAL STATE (P9.1 / P9.2).
 *
 * The one place a payment becomes an entitlement. A checkout is created here, a
 * provider event is ingested here, and a CONFIRMED payment is turned into a
 * subscription and a Credit grant here -- through the services that already own
 * those things, never by writing them directly.
 *
 * ── THE ONE RULE EVERYTHING ELSE FOLLOWS ─────────────────────────────────────
 *
 * ONLY THE PROVIDER CONFIRMS A PAYMENT. Not the browser, not the customer, not
 * a query parameter on a return URL. `startCheckout` creates a PENDING payment
 * and grants nothing whatsoever; the only function that activates Premium or
 * moves Credits is `ingestPaymentEvent`, and it acts only on an event whose
 * signature verified. A customer who closes the tab, edits the return URL, or
 * replays the success page gets exactly nothing.
 *
 * ── STORE FIRST, THEN PROCESS, EXACTLY ONCE ──────────────────────────────────
 *
 * Every delivery is written to `payment_events` verbatim before anything is
 * decided, including ones that fail their signature -- a forged delivery should
 * leave evidence, not silence. `(provider, event_ref)` is unique, so a
 * redelivery loses the race to insert and is answered as a replay having
 * changed nothing. Underneath that, the subscription's history sequence and the
 * wallet's idempotency key make the commercial effects idempotent in their own
 * right, so even a duplicate that somehow got past the event store could not
 * grant twice.
 *
 * ── ONE TRANSACTION FOR THE WHOLE EFFECT ─────────────────────────────────────
 *
 * Activating the plan, granting the Credits and settling the payment happen in
 * a SINGLE transaction. A customer can never be left with the Credits but not
 * the plan, or charged with neither.
 *
 * ── THE PROVIDER IS AN ADAPTER, AND NOTHING HERE KNOWS WHICH ─────────────────
 *
 * This module talks only to `commerce/payment-provider.ts`. It never learns
 * whether the provider is the fake one used to build and review this flow or a
 * real processor, which is what lets the processor be chosen (P9.D1) and
 * changed later without touching subscriptions, the ledger or content access.
 *
 * NOT HERE: card data of any kind, pricing (P1 owns it), what Premium unlocks
 * (P4 owns it), and any notion that a payment is "probably" fine.
 */

/** The wallet class a plan's included allowance lands in. */
const INCLUDED_CLASS = 'included' as const;

export type PaymentErrorCode =
  | 'invalid_request'
  | 'economy_disabled'
  | 'payments_unavailable'
  | 'unknown_plan'
  | 'plan_unavailable'
  | 'payment_not_found'
  | 'already_subscribed';

export class PaymentError extends Error {
  constructor(
    public readonly code: PaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

function invalid(message: string): never {
  throw new PaymentError('invalid_request', message);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{1,63}$/;
const KEY_MAX = 200;

/** What the customer chose before being sent to the provider. A hint, never authority. */
export const PAYMENT_METHODS = ['apple_pay', 'google_pay', 'paypal'] as const;
export type PaymentMethodHint = (typeof PAYMENT_METHODS)[number];

/** How a payment is named on the ledger rows it produces (P2.1 `source_type`). */
export const PAYMENT_SOURCE = 'payment';

const toView = (row: PaymentRow): CustomerPaymentView => ({
  id: row.id,
  status: row.status,
  kind: row.kind,
  productRef: row.productRef,
  amountMinor: row.amountMinor,
  currency: row.currency,
  methodHint: row.methodHint,
  provider: row.provider,
  createdAt: row.createdAt.toISOString(),
  settledAt: row.settledAt?.toISOString() ?? null,
});

/* ------------------------------------------------------------------ *
 * Starting a checkout -- grants nothing
 * ------------------------------------------------------------------ */

export interface StartCheckoutInput {
  userId: string;
  planCode: string;
  methodHint: string;
  /** One key, one checkout, per customer. */
  idempotencyKey: string;
  /** Where the provider returns the customer afterwards. */
  returnUrl: string;
}

function parseStart(input: StartCheckoutInput) {
  if (typeof input.userId !== 'string' || !UUID.test(input.userId)) invalid('userId must be a user id.');
  if (typeof input.planCode !== 'string' || !CODE.test(input.planCode)) invalid('planCode must be a plan code.');
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.methodHint)) {
    invalid(`method must be one of: ${PAYMENT_METHODS.join(', ')}.`);
  }
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.trim() === '' || key.length > KEY_MAX) {
    invalid(`idempotencyKey must be non-blank text of at most ${KEY_MAX} characters.`);
  }
  if (typeof input.returnUrl !== 'string' || input.returnUrl.trim() === '') invalid('returnUrl is required.');
  return { ...input, methodHint: input.methodHint as PaymentMethodHint };
}

/**
 * Creates a checkout for one plan and records a PENDING payment.
 *
 * The price is the P1 plan version's, resolved on the database clock -- never a
 * number from the client. NOTHING is activated or granted: this function exists
 * to send the customer somewhere, and the payment it writes says only that they
 * were sent.
 *
 * A repeated key returns the checkout already created, so a double-tap cannot
 * open two.
 */
export async function startCheckout(
  db: Db,
  commerce: Pick<CommerceEnv, 'enabled'>,
  provider: PaymentProvider,
  input: StartCheckoutInput,
): Promise<CustomerCheckout> {
  if (!commerce.enabled) throw new PaymentError('economy_disabled', 'The economy is switched off: nothing can be purchased yet.');
  const request = parseStart(input);

  const existing = await db
    .select()
    .from(payments)
    .where(and(eq(payments.userId, request.userId), eq(payments.idempotencyKey, request.idempotencyKey)));
  if (existing[0]) {
    return { payment: toView(existing[0]), checkoutRef: existing[0].checkoutRef, redirectUrl: null, replayed: true };
  }

  // Premium is one subscription at a time. A customer who already holds one
  // changes plan through support (P3.5) rather than buying a second.
  const { current } = await readSubscriptionRecord(db, request.userId);
  if (current && current.premium) {
    throw new PaymentError('already_subscribed', 'This account already has an active subscription.');
  }

  const asOf = await economyNow(db);
  const resolved = await resolvePlanVersion(db, request.planCode, asOf);
  if (!resolved.ok) {
    throw resolved.reason === 'unknown_plan'
      ? new PaymentError('unknown_plan', `There is no plan ${request.planCode}.`)
      : new PaymentError('plan_unavailable', `Plan ${request.planCode} has no published version in effect now.`);
  }
  const plan = resolved.value;
  if (!plan.isPurchasable) throw new PaymentError('plan_unavailable', `Plan ${request.planCode} is no longer offered.`);

  const checkout = await provider.createCheckout({
    kind: 'subscription',
    productRef: request.planCode,
    amountMinor: plan.priceMinor,
    currency: plan.currency,
    customerRef: request.userId,
    returnUrl: request.returnUrl,
    idempotencyKey: request.idempotencyKey,
  });

  const [row] = await db
    .insert(payments)
    .values({
      userId: request.userId,
      provider: provider.name,
      kind: 'subscription',
      productRef: request.planCode,
      amountMinor: plan.priceMinor,
      currency: plan.currency,
      status: 'pending',
      checkoutRef: checkout.checkoutRef,
      methodHint: request.methodHint,
      idempotencyKey: request.idempotencyKey,
    })
    .returning();

  return { payment: toView(row!), checkoutRef: checkout.checkoutRef, redirectUrl: checkout.redirectUrl, replayed: false };
}

/* ------------------------------------------------------------------ *
 * Ingesting a provider event -- the only authority
 * ------------------------------------------------------------------ */

export type IngestOutcome =
  /** Stored and applied. */
  | { status: 'processed'; eventRef: string; paymentId: string | null }
  /** Already seen: stored once, applied once, nothing done now. */
  | { status: 'replayed'; eventRef: string }
  /** Stored as evidence, never acted on. */
  | { status: 'rejected'; reason: 'bad_signature' | 'unrecognised' | 'no_event_ref'; eventRef: string | null }
  /** Valid and understood, but nothing for us to do. */
  | { status: 'ignored'; eventRef: string; reason: string };

/**
 * Takes one delivery from a provider and, if it is genuine and new, applies it.
 *
 * The order is deliberate and is the heart of P9.2:
 *   1. parse and verify with the adapter -- it reports, it does not act;
 *   2. store the envelope verbatim, whatever it said;
 *   3. only then, for a valid and previously unseen event, apply the effect.
 *
 * An event with no reference cannot be made idempotent, so it is refused rather
 * than processed once and hoped about.
 */
export async function ingestPaymentEvent(
  db: Db,
  commerce: Pick<CommerceEnv, 'enabled'>,
  provider: PaymentProvider,
  delivery: WebhookInput,
): Promise<IngestOutcome> {
  const parsed: ParsedPaymentWebhook = await provider.parseWebhook(delivery);
  const payload = safeJson(delivery.rawBody);

  if (!parsed.eventRef) {
    return { status: 'rejected', reason: 'no_event_ref', eventRef: null };
  }

  // Stored before anything is decided -- including a forgery.
  const [stored] = await db
    .insert(paymentEvents)
    .values({
      provider: provider.name,
      eventRef: parsed.eventRef,
      type: parsed.event.type,
      signatureValid: parsed.signatureValid,
      occurredAt: parsed.occurredAt,
      payload,
    })
    .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.eventRef] })
    .returning();
  if (!stored) return { status: 'replayed', eventRef: parsed.eventRef };

  if (!parsed.signatureValid) return { status: 'rejected', reason: 'bad_signature', eventRef: parsed.eventRef };
  if (parsed.event.type === 'unrecognised') return { status: 'rejected', reason: 'unrecognised', eventRef: parsed.eventRef };
  if (!commerce.enabled) return { status: 'ignored', eventRef: parsed.eventRef, reason: 'economy_disabled' };

  const event = parsed.event;
  if (event.type === 'payment_succeeded') {
    const paymentId = await applySuccess(db, event.checkoutRef, event.transactionRef, stored.id);
    return { status: 'processed', eventRef: parsed.eventRef, paymentId };
  }
  if (event.type === 'payment_failed') {
    const paymentId = await settleUnsuccessful(db, event.checkoutRef, 'failed', event.reason, stored.id);
    return { status: 'processed', eventRef: parsed.eventRef, paymentId };
  }
  // Renewals, cancellations, refunds and chargebacks are P9.2's remaining work
  // and P9.D1's rules; recorded now, deliberately not acted on.
  return { status: 'ignored', eventRef: parsed.eventRef, reason: `unhandled_${event.type}` };
}

function safeJson(rawBody: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(rawBody.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A CONFIRMED payment, applied: the plan is activated, the included Credits are
 * granted, and the payment is settled -- all in one transaction.
 *
 * The payment row is locked first and its status checked, so two deliveries
 * racing each other cannot both apply. Everything downstream is idempotent
 * anyway: the subscription's history sequence refuses a second change claiming
 * the same version, and the Credit grant's idempotency key is derived from the
 * payment.
 */
async function applySuccess(db: Db, checkoutRef: string, transactionRef: string, eventId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.checkoutRef, checkoutRef)).for('update');
    if (!payment) return null;
    await tx.update(paymentEvents).set({ paymentId: payment.id, processedAt: sql`now()` }).where(eq(paymentEvents.id, eventId));
    // Already applied: the effect happened once, and happens no more.
    if (payment.status !== 'pending') return payment.id;

    const { version } = await readSubscriptionRecord(tx as unknown as Db, payment.userId);
    const asOf = await economyNow(tx);
    const resolved = await resolvePlanVersion(tx, payment.productRef, asOf);
    if (!resolved.ok || !resolved.value.isPurchasable) {
      // Money took, plan gone. Left pending deliberately: this needs a human,
      // and pretending it succeeded would be worse than saying nothing.
      throw new PaymentError('plan_unavailable', `Plan ${payment.productRef} is no longer live; payment ${payment.id} needs review.`);
    }
    const plan = resolved.value;

    await changeSubscription(tx, {
      userId: payment.userId,
      action: 'assign',
      planCode: payment.productRef,
      expectedVersion: version,
      source: 'payment',
      actorUserId: null,
      reason: `Payment ${payment.id} confirmed by ${payment.provider}.`,
      reference: payment.id,
      requestId: null,
    });

    if (plan.monthlyIncludedCredits > 0) {
      await grantCredits(tx, {
        userId: payment.userId,
        currency: CREDITS_CURRENCY,
        amount: plan.monthlyIncludedCredits,
        creditClass: INCLUDED_CLASS,
        // Derived from the payment: one payment, one grant, whatever is redelivered.
        idempotencyKey: `payment:${payment.id}:included`,
        source: { type: PAYMENT_SOURCE, id: payment.id },
        reason: `Included with ${plan.ref.code}.`,
      });
    }

    await tx
      .update(payments)
      .set({ status: 'succeeded', transactionRef, settledAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(payments.id, payment.id));
    return payment.id;
  });
}

/** A payment that did not succeed. Nothing is activated and nothing is granted. */
async function settleUnsuccessful(
  db: Db,
  checkoutRef: string,
  status: 'failed' | 'cancelled',
  reason: string | null,
  eventId: string,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.checkoutRef, checkoutRef)).for('update');
    if (!payment) return null;
    await tx.update(paymentEvents).set({ paymentId: payment.id, processedAt: sql`now()` }).where(eq(paymentEvents.id, eventId));
    if (payment.status !== 'pending') return payment.id;
    await tx
      .update(payments)
      .set({ status, failureReason: reason, settledAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(payments.id, payment.id));
    return payment.id;
  });
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** One of this customer's payments. Never another customer's. */
export async function readPayment(db: Db, userId: string, paymentId: string): Promise<CustomerPaymentView | null> {
  if (typeof paymentId !== 'string' || !UUID.test(paymentId)) invalid('paymentId must be a payment id.');
  const [row] = await db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.userId, userId)));
  return row ? toView(row) : null;
}

/** A payment by its checkout reference, for the simulated checkout screen. */
export async function readPaymentByCheckout(db: Db, userId: string, checkoutRef: string): Promise<CustomerPaymentView | null> {
  if (typeof checkoutRef !== 'string' || checkoutRef.trim() === '') invalid('checkoutRef is required.');
  const [row] = await db.select().from(payments).where(and(eq(payments.checkoutRef, checkoutRef), eq(payments.userId, userId)));
  return row ? toView(row) : null;
}
