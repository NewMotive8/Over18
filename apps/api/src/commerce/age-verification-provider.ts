import type { WebhookInput } from './payment-provider.js';

/**
 * The age-verification provider interface (PRD v1.2 §7).
 *
 * DATA MINIMISATION IS IN THE TYPE. The vendor holds the evidence; OVER18
 * holds a boolean and a timestamp (§7.2). So no field below can carry a
 * document, an image, a date of birth, a name or an address -- an adapter
 * that receives any of them has nowhere to put it, and must drop it before it
 * returns.
 *
 * The vendor and the re-verification interval are undecided (D-8). `expiresAt`
 * is whatever the vendor or the policy says; this interface does not invent a
 * default.
 */

export interface StartVerificationInput {
  /** Our user id only. */
  customerRef: string;
  returnUrl: string;
  idempotencyKey: string;
}

export interface VerificationSession {
  sessionRef: string;
  redirectUrl: string;
}

export type VerificationOutcome = 'verified' | 'failed' | 'pending';

export interface ParsedVerificationCallback {
  signatureValid: boolean;
  sessionRef: string | null;
  outcome: VerificationOutcome;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  /** A category such as `id_document` or `estimation` -- never the evidence itself. */
  method: string | null;
}

export interface AgeVerificationProvider {
  readonly name: string;
  startVerification(input: StartVerificationInput): Promise<VerificationSession>;
  parseCallback(input: WebhookInput): Promise<ParsedVerificationCallback>;
}
