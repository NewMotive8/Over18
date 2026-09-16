import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  AgeVerificationProvider,
  ParsedVerificationCallback,
  VerificationOutcome,
} from './age-verification-provider.js';
import type {
  ParsedPaymentWebhook,
  PaymentEvent,
  PaymentProvider,
  WebhookInput,
} from './payment-provider.js';

/**
 * Fake payment and age-verification providers.
 *
 * WHY FAKES EXIST BEFORE ANY VENDOR DOES. Processor underwriting takes weeks
 * (§6.2) and the age-verification vendor is undecided (§29 D-8). Every phase
 * up to real checkout -- the ledger, grants, lifecycle, the return-to-action
 * flow, the age gate's ordering -- has to be buildable and browser-verifiable
 * before either exists. These let it be, through the SAME interface a real
 * adapter implements.
 *
 * THEY SIGN WHAT THEY SEND, AND CHECK IT. A fake that accepted any webhook
 * would let the signature path go untested until a real processor arrived,
 * which is the worst moment to find it broken. Callbacks are HMAC-SHA256 over
 * the exact bytes, compared in constant time.
 *
 * NEVER IN PRODUCTION. `loadEnv` will not select one there, and
 * `select-providers` refuses independently.
 */

export const FAKE_SIGNATURE_HEADER = 'x-over18-fake-signature';

export function signFakePayload(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function signatureValid(secret: string, input: WebhookInput): boolean {
  const header = input.headers[FAKE_SIGNATURE_HEADER];
  const presented = Array.isArray(header) ? header[0] : header;
  if (!presented || !/^[0-9a-f]{64}$/i.test(presented)) return false;
  const expected = Buffer.from(signFakePayload(secret, input.rawBody), 'hex');
  const actual = Buffer.from(presented, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Deterministic: the same idempotency key always yields the same reference. */
function refFor(prefix: string, idempotencyKey: string): string {
  return `${prefix}_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;
}

function parseJson(rawBody: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(rawBody.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);
const date = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

function toPaymentEvent(type: unknown, data: Record<string, unknown>): PaymentEvent {
  const amountMinor = int(data.amountMinor);
  const currency = str(data.currency);
  switch (type) {
    case 'payment_succeeded': {
      const checkoutRef = str(data.checkoutRef);
      const transactionRef = str(data.transactionRef);
      if (checkoutRef && transactionRef && amountMinor !== null && currency) {
        return { type, checkoutRef, transactionRef, amountMinor, currency };
      }
      break;
    }
    case 'payment_failed': {
      const checkoutRef = str(data.checkoutRef);
      if (checkoutRef) return { type, checkoutRef, reason: str(data.reason) };
      break;
    }
    case 'subscription_renewed': {
      const subscriptionRef = str(data.subscriptionRef);
      const transactionRef = str(data.transactionRef);
      if (subscriptionRef && transactionRef && amountMinor !== null && currency) {
        return { type, subscriptionRef, transactionRef, amountMinor, currency };
      }
      break;
    }
    case 'subscription_renewal_failed': {
      const subscriptionRef = str(data.subscriptionRef);
      if (subscriptionRef) return { type, subscriptionRef, reason: str(data.reason) };
      break;
    }
    case 'subscription_cancelled': {
      const subscriptionRef = str(data.subscriptionRef);
      const effectiveAt = str(data.effectiveAt);
      if (subscriptionRef && effectiveAt) return { type, subscriptionRef, effectiveAt };
      break;
    }
    case 'subscription_expired': {
      const subscriptionRef = str(data.subscriptionRef);
      if (subscriptionRef) return { type, subscriptionRef };
      break;
    }
    case 'refunded':
    case 'chargeback': {
      const transactionRef = str(data.transactionRef);
      if (transactionRef && amountMinor !== null && currency) {
        return { type, transactionRef, amountMinor, currency };
      }
      break;
    }
  }
  // Malformed or unknown: reported as such, never coerced into a real event.
  return { type: 'unrecognised' };
}

export function createFakePaymentProvider(options: {
  secret: string;
  checkoutBaseUrl: string;
}): PaymentProvider & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    name: 'fake',
    cancelled,
    async createCheckout(input) {
      if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
        throw new Error('amountMinor must be a positive integer number of minor units.');
      }
      if (!/^[A-Z]{3}$/.test(input.currency)) {
        throw new Error('currency must be an upper-case ISO 4217 code.');
      }
      const checkoutRef = refFor('chk', input.idempotencyKey);
      const url = new URL(`/fake-checkout/${checkoutRef}`, options.checkoutBaseUrl);
      url.searchParams.set('return', input.returnUrl);
      return { checkoutRef, redirectUrl: url.toString() };
    },
    async parseWebhook(input): Promise<ParsedPaymentWebhook> {
      const valid = signatureValid(options.secret, input);
      const body = parseJson(input.rawBody);
      if (!body) {
        return { signatureValid: valid, eventRef: null, occurredAt: null, event: { type: 'unrecognised' } };
      }
      const data =
        body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {};
      return {
        signatureValid: valid,
        eventRef: str(body.id),
        occurredAt: date(body.occurredAt),
        event: toPaymentEvent(body.type, data),
      };
    },
    async cancelSubscription(subscriptionRef) {
      cancelled.push(subscriptionRef);
    },
  };
}

const OUTCOMES: readonly VerificationOutcome[] = ['verified', 'failed', 'pending'];

export function createFakeAgeVerificationProvider(options: {
  secret: string;
  verifyBaseUrl: string;
}): AgeVerificationProvider {
  return {
    name: 'fake',
    async startVerification(input) {
      const sessionRef = refFor('avs', input.idempotencyKey);
      const url = new URL(`/fake-age-verification/${sessionRef}`, options.verifyBaseUrl);
      url.searchParams.set('return', input.returnUrl);
      return { sessionRef, redirectUrl: url.toString() };
    },
    async parseCallback(input): Promise<ParsedVerificationCallback> {
      const valid = signatureValid(options.secret, input);
      const body = parseJson(input.rawBody) ?? {};
      const outcome = OUTCOMES.find((o) => o === body.outcome) ?? 'failed';
      // Only the whitelisted fields are read. Anything else a callback carries
      // -- a name, a date of birth, a document image -- is never copied out.
      return {
        signatureValid: valid,
        sessionRef: str(body.sessionRef),
        outcome,
        verifiedAt: outcome === 'verified' ? date(body.verifiedAt) : null,
        expiresAt: outcome === 'verified' ? date(body.expiresAt) : null,
        method: str(body.method),
      };
    },
  };
}
