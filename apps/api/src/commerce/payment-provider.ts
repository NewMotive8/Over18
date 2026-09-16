/**
 * The payment provider interface (PRD v1.2 §6.2).
 *
 * PROVIDER-AGNOSTIC BY CONSTRUCTION. The processor is not chosen (D-4), the PRD
 * expects it to change at least once, and Stripe is ruled out for this
 * category (§6.1). So nothing a specific processor calls a "price point",
 * "FlexForm", "subaccount" or "postback" appears here, and no processor type
 * may leak past an adapter into product code.
 *
 * WEBHOOKS ARE PARSED, NOT TRUSTED. `parseWebhook` reports whether the
 * signature was valid; it does not act. The caller stores the raw envelope
 * verbatim first (§18 "payment event") and only then processes a valid event,
 * idempotently, keyed on `eventRef` -- which is what makes a purchase grant
 * Credits exactly once however many times a processor redelivers (§19.2).
 *
 * AMOUNTS ARE INTEGER MINOR UNITS. Never a float, anywhere money is carried.
 */

export type CheckoutKind = 'subscription' | 'credit_pack';

export interface CreateCheckoutInput {
  kind: CheckoutKind;
  /** Our own product/version identifier; the adapter maps it to the processor's. */
  productRef: string;
  amountMinor: number;
  /** ISO 4217, upper case. */
  currency: string;
  /** Our user id. Adapters must not send an email or any other identifier. */
  customerRef: string;
  /** Where the processor returns the user -- back to the action they started. */
  returnUrl: string;
  /** The same key must return the same checkout, never a second one. */
  idempotencyKey: string;
}

export interface CheckoutSession {
  checkoutRef: string;
  redirectUrl: string;
}

export type PaymentEvent =
  | {
      type: 'payment_succeeded';
      checkoutRef: string;
      transactionRef: string;
      amountMinor: number;
      currency: string;
    }
  | { type: 'payment_failed'; checkoutRef: string; reason: string | null }
  | { type: 'subscription_renewed'; subscriptionRef: string; transactionRef: string; amountMinor: number; currency: string }
  | { type: 'subscription_renewal_failed'; subscriptionRef: string; reason: string | null }
  | { type: 'subscription_cancelled'; subscriptionRef: string; effectiveAt: string }
  | { type: 'subscription_expired'; subscriptionRef: string }
  | { type: 'refunded'; transactionRef: string; amountMinor: number; currency: string }
  | { type: 'chargeback'; transactionRef: string; amountMinor: number; currency: string }
  | { type: 'unrecognised' };

export interface ParsedPaymentWebhook {
  signatureValid: boolean;
  /** The processor's unique id for this delivery's event -- the idempotency key. */
  eventRef: string | null;
  occurredAt: Date | null;
  event: PaymentEvent;
}

export interface WebhookInput {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The exact bytes received. Signatures are computed over these, not a re-serialisation. */
  rawBody: Buffer;
}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  parseWebhook(input: WebhookInput): Promise<ParsedPaymentWebhook>;
  cancelSubscription(subscriptionRef: string): Promise<void>;
}
