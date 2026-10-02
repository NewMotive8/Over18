import { and, eq, sql } from 'drizzle-orm';
import {
  PURCHASE_ORIGIN_ACTIONS,
  PURCHASE_ORIGINS,
  type CreditPackTerms,
  type CustomerCheckout,
  type CustomerPaymentView,
  type PurchaseContext,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { paymentEvents, payments, type PaymentRow } from '../db/schema.js';
import type { PaymentProvider, ParsedPaymentWebhook, WebhookInput } from '../commerce/payment-provider.js';
import { economyNow, resolvePackVersion, resolvePlanVersion } from './economy-resolver.js';
import { effectivePackTerms } from './pack-terms.js';
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
 * ── CREDIT PACKS: TERMS LOCKED AT CHECKOUT ──────────────────────────────────
 *
 * A pack checkout resolves the pack version and the promotion in effect on the
 * database clock (`pack-terms.ts`, the same rule the catalog shows), charges
 * that price, and stores the terms on the payment. A confirmed payment awards
 * exactly those terms -- whatever an operator changes in the meantime -- as
 * TWO ledger entries under one payment: the Credits bought (`purchased`) and
 * any bonus (`bonus`), each keyed by the payment so neither can land twice.
 * A pack is bought on top of any subscription; Premium is never required or
 * re-sold here.
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
  | 'unknown_pack'
  | 'pack_unavailable'
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

/** A pack payment's stored terms, read back. Null when they are not a pack's. */
function packTermsOf(row: Pick<PaymentRow, 'kind' | 'terms'>): CreditPackTerms | null {
  if (row.kind !== 'credit_pack') return null;
  const t = row.terms as Partial<StoredPackTerms>;
  if (typeof t.packCode !== 'string' || !Number.isSafeInteger(t.credits) || !Number.isSafeInteger(t.bonusCredits)) return null;
  return {
    packCode: t.packCode,
    packVersion: Number(t.packVersion),
    displayName: String(t.displayName ?? ''),
    credits: t.credits!,
    bonusCredits: t.bonusCredits!,
    totalCredits: t.credits! + t.bonusCredits!,
  };
}

function contextOf(row: Pick<PaymentRow, 'context'>): PurchaseContext | null {
  const c = row.context as Partial<PurchaseContext>;
  if (!c || Object.keys(c).length === 0) return null;
  return {
    origin: c.origin ?? null,
    originAction: c.originAction ?? null,
    assetId: c.assetId ?? null,
    conversationId: c.conversationId ?? null,
    characterId: c.characterId ?? null,
  };
}

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
  pack: packTermsOf(row),
  context: contextOf(row),
});

/* ------------------------------------------------------------------ *
 * Starting a checkout -- grants nothing
 * ------------------------------------------------------------------ */

export interface StartCheckoutInput {
  userId: string;
  /** A subscription plan's code. Exactly one of `planCode` and `packCode`. */
  planCode?: string | null;
  /** A Credit pack's code. Exactly one of `planCode` and `packCode`. */
  packCode?: string | null;
  methodHint: string;
  /** One key, one checkout, per customer. */
  idempotencyKey: string;
  /**
   * Where the provider returns the customer afterwards: a path inside the app,
   * never another site. A pack checkout always returns to the Credits Store.
   */
  returnUrl: string;
  /** Where the purchase started (`PurchaseContext`), as the client sent it: validated here. */
  context?: unknown;
}

/** What a pack payment stores at checkout -- the terms it will be awarded on. */
type StoredPackTerms = {
  packCode: string;
  packVersion: number;
  packVersionId: string;
  displayName: string;
  credits: number;
  bonusCredits: number;
  priceMinor: number;
  currency: string;
  wasPriceMinor: number | null;
  promotionEndsAt: string | null;
  badge: string | null;
  /** The database instant the terms were resolved at. */
  resolvedAt: string;
};

/** The Credits Store, where every pack checkout comes back to. */
const CREDITS_STORE_PATH = '/credits';

/** A path in this app: one leading slash, no scheme, host or backslash. */
const INTERNAL_PATH = /^\/(?![/\\])[^\s\\]*$/;

function parseContext(value: unknown): PurchaseContext | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) invalid('context must be an object.');
  const raw = value as Record<string, unknown>;
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | null => {
    const v = raw[key];
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) invalid(`context.${key} must be one of: ${allowed.join(', ')}.`);
    return v as T;
  };
  const id = (key: string): string | null => {
    const v = raw[key];
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !UUID.test(v)) invalid(`context.${key} must be an id.`);
    return v.toLowerCase();
  };
  const context: PurchaseContext = {
    origin: pick('origin', PURCHASE_ORIGINS),
    originAction: pick('originAction', PURCHASE_ORIGIN_ACTIONS),
    assetId: id('assetId'),
    conversationId: id('conversationId'),
    characterId: id('characterId'),
  };
  // Only the fields above are ever kept: anything else the client sent is dropped.
  return Object.values(context).some((v) => v !== null) ? context : null;
}

function parseStart(input: StartCheckoutInput) {
  if (typeof input.userId !== 'string' || !UUID.test(input.userId)) invalid('userId must be a user id.');
  const planCode = input.planCode ?? null;
  const packCode = input.packCode ?? null;
  if ((planCode === null) === (packCode === null)) invalid('Name exactly one of planCode and packCode.');
  if (planCode !== null && (typeof planCode !== 'string' || !CODE.test(planCode))) invalid('planCode must be a plan code.');
  if (packCode !== null && (typeof packCode !== 'string' || !CODE.test(packCode))) invalid('packCode must be a pack code.');
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.methodHint)) {
    invalid(`method must be one of: ${PAYMENT_METHODS.join(', ')}.`);
  }
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.trim() === '' || key.length > KEY_MAX) {
    invalid(`idempotencyKey must be non-blank text of at most ${KEY_MAX} characters.`);
  }
  // A pack always comes back to the Credits Store, so whatever the client sent
  // for it is ignored; a plan's return must be a path inside the app.
  if (packCode === null && (typeof input.returnUrl !== 'string' || !INTERNAL_PATH.test(input.returnUrl) || input.returnUrl.length > 300)) {
    invalid('returnUrl must be a path inside the app.');
  }
  return {
    userId: input.userId,
    planCode,
    packCode,
    methodHint: input.methodHint as PaymentMethodHint,
    idempotencyKey: key,
    returnUrl: packCode !== null ? CREDITS_STORE_PATH : input.returnUrl,
    context: parseContext(input.context),
  };
}

/**
 * Creates a checkout for one plan or one Credit pack and records a PENDING
 * payment.
 *
 * The price is the P1 version's, resolved on the database clock -- never a
 * number from the client. NOTHING is activated or granted: this function exists
 * to send the customer somewhere, and the payment it writes says only that they
 * were sent (and, for a pack, on exactly which terms).
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

  const asOf = await economyNow(db);
  const product = request.packCode !== null
    ? await packProduct(db, request.packCode, asOf)
    : await planProduct(db, request.userId, request.planCode!, asOf);

  const checkout = await provider.createCheckout({
    kind: product.kind,
    productRef: product.code,
    amountMinor: product.priceMinor,
    currency: product.currency,
    customerRef: request.userId,
    returnUrl: request.returnUrl,
    idempotencyKey: request.idempotencyKey,
  });

  const [row] = await db
    .insert(payments)
    .values({
      userId: request.userId,
      provider: provider.name,
      kind: product.kind,
      productRef: product.code,
      amountMinor: product.priceMinor,
      currency: product.currency,
      status: 'pending',
      checkoutRef: checkout.checkoutRef,
      methodHint: request.methodHint,
      idempotencyKey: request.idempotencyKey,
      terms: product.terms ?? {},
      context: request.context ? { ...request.context } : {},
    })
    .returning();

  return { payment: toView(row!), checkoutRef: checkout.checkoutRef, redirectUrl: checkout.redirectUrl, replayed: false };
}

interface CheckoutProduct {
  kind: 'subscription' | 'credit_pack';
  code: string;
  priceMinor: number;
  currency: string;
  terms: StoredPackTerms | null;
}

async function planProduct(db: Db, userId: string, planCode: string, asOf: Awaited<ReturnType<typeof economyNow>>): Promise<CheckoutProduct> {
  // Premium is one subscription at a time. A customer who already holds one
  // changes plan through support (P3.5) rather than buying a second.
  const { current } = await readSubscriptionRecord(db, userId);
  if (current && current.premium) {
    throw new PaymentError('already_subscribed', 'This account already has an active subscription.');
  }
  const resolved = await resolvePlanVersion(db, planCode, asOf);
  if (!resolved.ok) {
    throw resolved.reason === 'unknown_plan'
      ? new PaymentError('unknown_plan', `There is no plan ${planCode}.`)
      : new PaymentError('plan_unavailable', `Plan ${planCode} has no published version in effect now.`);
  }
  const plan = resolved.value;
  if (!plan.isPurchasable) throw new PaymentError('plan_unavailable', `Plan ${planCode} is no longer offered.`);
  return { kind: 'subscription', code: planCode, priceMinor: plan.priceMinor, currency: plan.currency, terms: null };
}

/** A pack on the terms in effect at `asOf` -- the same price the catalog shows then. */
async function packProduct(db: Db, packCode: string, asOf: Awaited<ReturnType<typeof economyNow>>): Promise<CheckoutProduct> {
  const resolved = await resolvePackVersion(db, packCode, asOf);
  if (!resolved.ok) {
    throw resolved.reason === 'unknown_pack'
      ? new PaymentError('unknown_pack', `There is no Credit pack ${packCode}.`)
      : new PaymentError('pack_unavailable', `Credit pack ${packCode} has no published version in effect now.`);
  }
  const pack = resolved.value;
  if (!pack.isPurchasable) throw new PaymentError('pack_unavailable', `Credit pack ${packCode} is no longer offered.`);
  const terms = effectivePackTerms(pack, asOf.iso);
  return {
    kind: 'credit_pack',
    code: packCode,
    priceMinor: terms.priceMinor,
    currency: pack.currency,
    terms: {
      packCode,
      packVersion: pack.ref.version,
      packVersionId: pack.ref.id,
      displayName: pack.displayName,
      credits: terms.credits,
      bonusCredits: terms.bonusCredits,
      priceMinor: terms.priceMinor,
      currency: pack.currency,
      wasPriceMinor: terms.wasPriceMinor,
      promotionEndsAt: terms.promotionEndsAt,
      badge: pack.badge,
      resolvedAt: asOf.iso,
    },
  };
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

    if (payment.kind === 'credit_pack') {
      await awardPack(tx, payment);
      await tx
        .update(payments)
        .set({ status: 'succeeded', transactionRef, settledAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(payments.id, payment.id));
      return payment.id;
    }

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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * A confirmed Credit pack: the terms LOCKED AT CHECKOUT are awarded, never the
 * catalog's current ones -- an operator changing or retiring the pack after the
 * customer paid changes nothing about what they paid for.
 *
 * Two ledger entries, one payment: the Credits bought as `purchase` /
 * `purchased`, and the bonus, when there is one, as `grant` / `bonus`. Both are
 * keyed by the payment and both are written in the caller's transaction, under
 * the payment's lock -- so the award is all or nothing, and a redelivered event
 * finds the payment settled and adds neither.
 */
async function awardPack(tx: Tx, payment: PaymentRow): Promise<void> {
  const terms = packTermsOf(payment);
  if (!terms || terms.credits < 1 || terms.bonusCredits < 0) {
    // Money taken against terms that cannot be read: left pending for a human.
    throw new PaymentError('pack_unavailable', `Payment ${payment.id} has no readable Credit pack terms; it needs review.`);
  }
  const source = { type: PAYMENT_SOURCE, id: payment.id };
  const metadata = { packCode: terms.packCode, packVersion: terms.packVersion };
  await grantCredits(tx, {
    userId: payment.userId,
    currency: CREDITS_CURRENCY,
    amount: terms.credits,
    creditClass: 'purchased',
    entryType: 'purchase',
    idempotencyKey: `payment:${payment.id}:purchased`,
    source,
    reason: `Bought: ${terms.displayName}.`,
    metadata,
  });
  if (terms.bonusCredits > 0) {
    await grantCredits(tx, {
      userId: payment.userId,
      currency: CREDITS_CURRENCY,
      amount: terms.bonusCredits,
      creditClass: 'bonus',
      idempotencyKey: `payment:${payment.id}:bonus`,
      source,
      reason: `Bonus with ${terms.displayName}.`,
      metadata,
    });
  }
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
