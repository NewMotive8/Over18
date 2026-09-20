import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomerContentUnlock } from '@over18/shared';
import { ApiRequestError, contentAccessApi } from './api';

/**
 * UNLOCKING CONTENT WITH CREDITS (P8.2, from the customer side).
 *
 * The server does the unlocking. This module carries one intent -- "unlock this
 * one thing" -- from the tile to `POST /api/content/:assetId/unlock`, and turns
 * whatever comes back into words.
 *
 * IT HOLDS NO OWNERSHIP. There is no local "unlocked" flag anywhere: after a
 * successful unlock the caller re-reads `GET /api/content/access` and the tile
 * changes because the SERVER now says `owned`. That is deliberate -- a second
 * source of truth for ownership is exactly how a customer ends up looking at
 * content they did not buy, or being told they own something they do not.
 *
 * IT DECIDES NOTHING COMMERCIAL EITHER. No price is calculated, no balance is
 * compared, and affordability is never judged here: a tile only offers to
 * unlock when the server answered `credits_required`, and a customer whose
 * Credits fall short gets the server's `insufficient_credits` answer and the
 * existing route to the Credits screen.
 *
 * ONE ATTEMPT, ONE KEY. The idempotency key is made once, when the confirmation
 * opens, and reused for every send of that attempt. A double tap, a retry after
 * a dropped connection, an impatient second press -- all carry the same key, so
 * the server replays the one purchase instead of making a second. Cancelling and
 * starting again is a new intent, and gets a new key.
 *
 * The client kinds mirror the access and economy clients, and for the same
 * reason: `pending` is the production default and calls nothing, so nothing can
 * be charged before the endpoint is deliberately switched on.
 */

export interface ContentUnlockClient {
  readonly kind: 'pending' | 'http' | 'fixture';
  unlock(assetId: string, idempotencyKey: string): Promise<CustomerContentUnlock>;
}

export class ContentUnlockUnavailableError extends Error {
  constructor() {
    super('Content unlocking backend support is pending.');
    this.name = 'ContentUnlockUnavailableError';
  }
}

export const pendingContentUnlockClient: ContentUnlockClient = {
  kind: 'pending',
  unlock: () => Promise.reject(new ContentUnlockUnavailableError()),
};

export function createHttpContentUnlockClient(endpoints: Pick<typeof contentAccessApi, 'unlock'> = contentAccessApi): ContentUnlockClient {
  return { kind: 'http', unlock: (assetId, idempotencyKey) => endpoints.unlock(assetId, { idempotencyKey }) };
}

/**
 * THE PRODUCTION DEFAULT: pending. Switching it to the HTTP client is a
 * deliberate, separate change, exactly as for the access and economy clients.
 */
export const contentUnlockClient: ContentUnlockClient = pendingContentUnlockClient;

/* ------------------------------------------------------------------ *
 * What went wrong, said to a customer
 * ------------------------------------------------------------------ */

export interface UnlockFailure {
  /** The server's code, for tests and telemetry. Never shown. */
  code: string;
  message: string;
  /** Somewhere that resolves it, when there is somewhere. */
  action: { label: string; to: string } | null;
  /** Whether sending the same unlock again could succeed. */
  retryable: boolean;
}

const GET_CREDITS = { label: 'Get Credits', to: '/credits' };
const SEE_PREMIUM = { label: 'See Premium', to: '/subscription' };

/**
 * Every refusal the unlock endpoint can give, in the customer's language.
 *
 * NOTHING WAS CHARGED, whichever one it is: an unlock is one database
 * transaction, so a refusal leaves the wallet exactly as it was. Several of
 * these say so, because "did that take my Credits?" is the first thing a
 * customer wonders when a payment screen shows an error.
 */
const FAILURES: Record<string, Omit<UnlockFailure, 'code'>> = {
  insufficient_credits: { message: "You don't have enough Credits to unlock this. Nothing was charged.", action: GET_CREDITS, retryable: false },
  premium_required: { message: 'This one comes with Premium rather than Credits.', action: SEE_PREMIUM, retryable: false },
  not_purchasable: { message: 'This content is already open to you.', action: null, retryable: false },
  unavailable: { message: "This content isn't available any more.", action: null, retryable: false },
  age_restricted: { message: "This content needs age confirmation, which isn't available yet.", action: null, retryable: false },
  price_changed: { message: 'The price changed before this went through. Nothing was charged — check it and try again.', action: null, retryable: true },
  purchase_reversed: { message: 'That purchase was refunded. Nothing was charged now — unlock it again to buy it.', action: null, retryable: true },
  economy_unavailable: { message: "Unlocking isn't available yet.", action: null, retryable: false },
};

const GENERIC: Omit<UnlockFailure, 'code'> = {
  message: "That didn't go through. Nothing was charged — please try again.",
  action: null,
  retryable: true,
};

export function unlockFailure(error: unknown): UnlockFailure {
  if (error instanceof ContentUnlockUnavailableError) {
    return { code: 'unavailable_client', ...FAILURES.economy_unavailable! };
  }
  if (error instanceof ApiRequestError) {
    // A signed-out customer is not shown a payment error; the app's own session
    // handling is what should answer that.
    if (error.status === 401) return { code: 'unauthenticated', ...FAILURES.economy_unavailable! };
    const known = FAILURES[error.code];
    if (known) return { code: error.code, ...known };
    return { code: error.code, ...GENERIC };
  }
  return { code: 'unknown', ...GENERIC };
}

/* ------------------------------------------------------------------ *
 * One unlock attempt
 * ------------------------------------------------------------------ */

/** What the confirmation is about. Every value here came from the server. */
export interface UnlockTarget {
  assetId: string;
  /** What the customer is looking at, as the surface names it. */
  title: string;
  /** The server's price. Null only when the server sent none. */
  creditPrice: number | null;
}

/** What the surface shows: an open confirmation, whether it is sending, and why it last failed. */
export interface UnlockState {
  target: UnlockTarget | null;
  /** True while a request is in flight: the confirmation cannot be sent twice. */
  busy: boolean;
  failure: UnlockFailure | null;
}

export const IDLE_UNLOCK: UnlockState = { target: null, busy: false, failure: null };

export interface UnlockController extends UnlockState {
  open(target: UnlockTarget): void;
  cancel(): void;
  confirm(): void;
}

/** A key for one attempt. `randomUUID` where there is one, random text otherwise. */
export function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `unlock-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * ONE CONFIRMATION, DRIVEN. Deliberately a plain object rather than a hook's
 * innards: the rules that matter here -- send once, keep the key, never report
 * success that did not happen -- are worth asserting directly, without a
 * renderer standing in the way. `useContentUnlock` is a thin wrapper over it.
 */
export class UnlockAttempt {
  private attempt: (UnlockTarget & { idempotencyKey: string }) | null = null;
  private inFlight = false;
  private failure: UnlockFailure | null = null;

  constructor(
    private readonly deps: {
      client: () => ContentUnlockClient;
      onUnlocked?: (unlocked: CustomerContentUnlock) => void;
      onChange?: (state: UnlockState) => void;
    },
  ) {}

  get state(): UnlockState {
    const { assetId, title, creditPrice } = this.attempt ?? {};
    return {
      target: this.attempt ? { assetId: assetId!, title: title!, creditPrice: creditPrice ?? null } : null,
      busy: this.inFlight,
      failure: this.failure,
    };
  }

  /** The key this attempt carries. For tests and telemetry; never sent anywhere else. */
  get idempotencyKey(): string | null {
    return this.attempt?.idempotencyKey ?? null;
  }

  private publish(): void {
    this.deps.onChange?.(this.state);
  }

  open(target: UnlockTarget): void {
    this.failure = null;
    this.attempt = { ...target, idempotencyKey: newIdempotencyKey() };
    this.publish();
  }

  /** A request in flight is never abandoned into a state nobody can see the end of. */
  cancel(): void {
    if (this.inFlight) return;
    this.attempt = null;
    this.failure = null;
    this.publish();
  }

  async confirm(): Promise<void> {
    const attempt = this.attempt;
    // The guard is a field, not React state: two presses in one tick would both
    // read a stale flag, and the second must still not send.
    if (!attempt || this.inFlight) return;
    this.inFlight = true;
    this.failure = null;
    this.publish();
    try {
      const unlocked = await this.deps.client().unlock(attempt.assetId, attempt.idempotencyKey);
      // Closed first, so nothing lingers over content that is now open. The
      // tile only changes once the caller has re-read the server's answer.
      this.attempt = null;
      this.inFlight = false;
      this.publish();
      this.deps.onUnlocked?.(unlocked);
    } catch (error: unknown) {
      // The confirmation stays open, saying what happened. Nothing is treated
      // as unlocked, and the caller is not told anything was.
      this.failure = unlockFailure(error);
      this.inFlight = false;
      this.publish();
    }
  }
}

/**
 * Drives one confirmation at a time. `onUnlocked` is called after the server
 * confirms, and is where the caller re-reads access and the balance -- this
 * hook changes nothing about what the customer may see.
 */
export function useContentUnlock({
  client = contentUnlockClient,
  onUnlocked,
}: {
  client?: ContentUnlockClient;
  onUnlocked?: (unlocked: CustomerContentUnlock) => void;
} = {}): UnlockController {
  const [state, setState] = useState<UnlockState>(IDLE_UNLOCK);
  // The current client and callback, so a re-render with new ones is picked up
  // without rebuilding the attempt and losing its key.
  const latest = useRef({ client, onUnlocked });
  useEffect(() => {
    latest.current = { client, onUnlocked };
  }, [client, onUnlocked]);

  const attempt = useRef<UnlockAttempt>();
  if (!attempt.current) {
    attempt.current = new UnlockAttempt({
      client: () => latest.current.client,
      onUnlocked: (unlocked) => latest.current.onUnlocked?.(unlocked),
      onChange: setState,
    });
  }
  const controller = attempt.current;

  const open = useCallback((target: UnlockTarget) => controller.open(target), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);
  const confirm = useCallback(() => void controller.confirm(), [controller]);

  return { ...state, open, cancel, confirm };
}
