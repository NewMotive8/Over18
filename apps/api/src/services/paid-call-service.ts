import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import { economyNow, resolveRuleset } from './economy-resolver.js';
import {
  beginPaidAction,
  capturePaidAction,
  DEFAULT_QUALITY_TIER,
  PaidActionError,
  priceOn,
  runPaidAction,
} from './paid-action-service.js';
import { CREDITS_CURRENCY, readCommercialWallet, WalletError } from './wallet-service.js';

/**
 * CHARGING FOR A LIVE VOICE CALL (`voice_call`), one started minute at a time.
 *
 * PER STARTED MINUTE, PAID IN ADVANCE. A minute is charged when it begins, not
 * when it ends, so a caller always has the minute they are currently speaking.
 * The provider bills a created session whether or not anyone talks and offers
 * no way to cancel one, so the first minute is reserved BEFORE the session
 * exists: a caller who cannot afford to start never creates something we would
 * have to pay for.
 *
 * MINUTE ONE IS RESERVED, NOT SPENT, until the session is really created. If the
 * provider refuses or fails, the reservation is released and the caller keeps
 * their Credit -- they got no call. Every later minute is charged outright,
 * because by then the call is live and the minute has genuinely started.
 *
 * PREMIUM DOES NOT BYPASS THIS. Nothing here reads the subscription: Premium is
 * access, Credits are consumption, so a Premium caller with no Credits cannot
 * start or continue a call.
 *
 * FAIL CLOSED. While the economy is ON, a call that cannot be priced does not
 * happen: no published ruleset, or no enabled `voice_call` cost, both refuse.
 * Missing configuration is never read as "free". While the economy is OFF,
 * calls are not a paid action and run untouched.
 *
 * The price is the ruleset's. `voice_call` is a per-minute cost, so this asks
 * the framework for exactly one minute and the framework multiplies -- this
 * module never states an amount.
 */

export const VOICE_CALL_ACTION = 'voice_call';

/** One minute, as the per-minute price is applied to it. */
export const CALL_MINUTE_SECONDS = 60;

export type CallCreditErrorCode = 'insufficient_credits' | 'not_priced';

export class CallCreditError extends Error {
  constructor(
    public readonly code: CallCreditErrorCode,
    message: string,
    /** The underlying wallet or resolver reason, for logs only. */
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'CallCreditError';
  }
}

export interface CallMinuteInput {
  userId: string;
  callSessionId: string;
  requestId?: string | null;
}

/** One action per minute of one call, so a retry of the same minute cannot double-charge. */
const minuteKey = (callSessionId: string, minute: number) => `call:${callSessionId}:minute:${minute}`;

const request = (input: CallMinuteInput, minute: number) => ({
  userId: input.userId,
  actionType: VOICE_CALL_ACTION,
  durationSeconds: CALL_MINUTE_SECONDS,
  idempotencyKey: minuteKey(input.callSessionId, minute),
  requestId: input.requestId ?? null,
  metadata: { callSessionId: input.callSessionId, minute },
});

/**
 * THE FIRST MINUTE, AROUND CREATING THE PROVIDER SESSION.
 *
 * Reserves a minute, runs `createSession`, and consumes the minute only once the
 * session exists. A refusal throws `CallCreditError` BEFORE `createSession` is
 * called even once -- which is the point: an unaffordable call must never
 * become a billable session upstream.
 */
export async function withFirstCallMinute<T>(
  db: Db,
  commerce: Pick<CommerceEnv, 'enabled'>,
  input: CallMinuteInput,
  createSession: () => Promise<T>,
): Promise<T> {
  if (!commerce.enabled) return createSession();

  let run;
  try {
    run = await runPaidAction(db, commerce, request(input, 1), createSession);
  } catch (error) {
    throw asCallCreditError(error);
  }
  if (run.replayed) {
    // The same call session reconnecting would reuse minute 1's key. Nothing was
    // charged twice, but no session was created either, so the caller is told
    // rather than handed a session that does not exist.
    throw new CallCreditError('insufficient_credits', 'This call has already started.', 'minute_replayed');
  }
  return run.result;
}

export interface CallMinuteOutcome {
  charged: boolean;
  /** Why it was not charged, for the log and the settle reason. */
  reason?: CallCreditErrorCode;
}

/**
 * A LATER MINUTE, charged as it starts.
 *
 * Returns rather than throws for a refusal, because the caller's job when the
 * Credits run out is to end the call cleanly -- not to handle an exception in a
 * timer. A genuine fault still throws: a database outage must not be mistaken
 * for an empty wallet and quietly hang up on someone who has Credits.
 */
export async function chargeCallMinute(
  db: Db,
  commerce: Pick<CommerceEnv, 'enabled'>,
  input: CallMinuteInput,
  minute: number,
): Promise<CallMinuteOutcome> {
  if (!commerce.enabled) return { charged: true };

  let started;
  try {
    started = await beginPaidAction(db, commerce, request(input, minute));
  } catch (error) {
    const mapped = asCallCreditError(error);
    if (mapped instanceof CallCreditError) return { charged: false, reason: mapped.code };
    throw mapped;
  }
  // Already charged for this minute (a redelivered tick): the minute is paid for
  // and the call carries on.
  if (started.replayed) return { charged: true };
  await capturePaidAction(db, commerce, { actionId: started.action.id });
  return { charged: true };
}

/**
 * The two refusals a caller can do something about, told apart from faults.
 * Anything else propagates unchanged.
 */
function asCallCreditError(error: unknown): unknown {
  if (error instanceof WalletError) {
    if (error.code === 'insufficient_credits' || error.code === 'wallet_not_found') {
      return new CallCreditError('insufficient_credits', 'Not enough Credits for this call.', error.code);
    }
    return error;
  }
  if (error instanceof PaidActionError && (error.code === 'not_priced' || error.code === 'configuration_changed')) {
    return new CallCreditError('not_priced', 'Calls are not available right now.', error.reason ?? error.code);
  }
  return error;
}

/* ------------------------------------------------------------------ *
 * Telling someone BEFORE they press Call
 * ------------------------------------------------------------------ */

export type CallAffordability =
  | { ok: true }
  /** With the price, so the caller can say what it costs rather than guessing. */
  | { ok: false; reason: CallCreditErrorCode; creditsRequired: number | null };

/**
 * CAN THIS PERSON AFFORD TO START A CALL? Read-only, and advisory.
 *
 * WHY THIS EXISTS AT ALL. Without it a caller with no Credits pressed Call, a
 * `call_sessions` row was claimed, the socket opened, and only then did the
 * first-minute reservation refuse them -- so they were shown "the call ended
 * unexpectedly", which is true of a fault and wrong here. Nothing failed. They
 * simply cannot pay, and that is answerable before anything is created.
 *
 * IT IS NOT THE GUARD. `withFirstCallMinute` still reserves the first minute
 * inside the call socket and still fails closed, and it is the only thing that
 * actually moves Credits. This narrows the window and improves the message; it
 * does not replace the thing that makes the rule true. Between this read and
 * that reservation a caller can spend their last Credit elsewhere, and when
 * they do, the reservation refuses them exactly as it did before.
 *
 * SAME PRICE, SAME SOURCE. The amount comes from the published ruleset through
 * `priceOn` -- the function `beginPaidAction` uses -- so the preflight and the
 * charge can never disagree about what a minute costs.
 *
 * PREMIUM IS NOT CONSULTED, here as everywhere else in this module: Premium is
 * access, Credits are consumption.
 */
export async function canStartCall(
  db: Db,
  commerce: Pick<CommerceEnv, 'enabled'>,
  userId: string,
): Promise<CallAffordability> {
  // Calls are not a paid action while the economy is off: nothing to afford.
  if (!commerce.enabled) return { ok: true };

  const resolved = await resolveRuleset(db, await economyNow(db));
  // Fail closed, and say why: an unpriced call does not happen, and telling
  // somebody they are short of Credits when the configuration is missing would
  // send them to buy Credits that would not help.
  if (!resolved.ok) return { ok: false, reason: 'not_priced', creditsRequired: null };

  const priced = priceOn(resolved.value, {
    actionType: VOICE_CALL_ACTION,
    qualityTier: DEFAULT_QUALITY_TIER,
    durationSeconds: CALL_MINUTE_SECONDS,
  });
  if (!priced.ok) return { ok: false, reason: 'not_priced', creditsRequired: null };

  // No wallet is the same as an empty one: somebody who has never held a Credit
  // cannot pay for a minute.
  const wallet = await readCommercialWallet(db, userId, CREDITS_CURRENCY);
  const spendable = wallet?.spendable ?? 0;
  if (spendable < priced.amount) {
    return { ok: false, reason: 'insufficient_credits', creditsRequired: priced.amount };
  }
  return { ok: true };
}
