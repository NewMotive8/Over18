import { useCallback, useState } from 'react';
import type { CustomerCheckout, CustomerPaymentView, PaymentMethod, SimulatedOutcome, SimulatedPaymentResult } from '@over18/shared';
import { ApiRequestError, paymentsApi } from './api';

/**
 * BUYING PREMIUM, FROM THE CUSTOMER'S SIDE (P9.1).
 *
 * Starting a checkout and asking what happened to it. That is all.
 *
 * NOTHING HERE GRANTS ANYTHING, and nothing here believes the browser. The
 * server records a PENDING payment when a checkout starts, and only a signed
 * provider event turns that into Premium and Credits. So this module never
 * reports success of its own: after a payment it re-reads the customer's
 * commercial state and shows whatever the SERVER now says. A refreshed page, a
 * hand-edited URL or a replayed request produces exactly nothing.
 *
 * NO PRICE IS SENT. A checkout names a plan code; what it costs is the
 * server's to resolve from the published P1 catalogue.
 */

export type CheckoutState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'failed'; message: string }
  | { status: 'started'; checkout: CustomerCheckout };

const MESSAGES: Record<string, string> = {
  economy_unavailable: 'Purchases are not available yet.',
  payments_unavailable: 'No payment method is available yet.',
  already_subscribed: 'This account already has an active subscription.',
  plan_unavailable: 'That plan is no longer offered.',
  unknown_plan: 'That plan is no longer offered.',
};

export function checkoutMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return 'Please sign in again.';
    return MESSAGES[error.code] ?? 'That could not be started. Please try again.';
  }
  return 'That could not be started. Please try again.';
}

/** A key for one purchase attempt, so a double-tap cannot open two checkouts. */
export function newCheckoutKey(planCode: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${planCode}:${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`}`;
}

/** Starts one checkout at a time, and never twice at once. */
export function useCheckout(): {
  state: CheckoutState;
  start(planCode: string, method: PaymentMethod): Promise<CustomerCheckout | null>;
  reset(): void;
} {
  const [state, setState] = useState<CheckoutState>({ status: 'idle' });

  const start = useCallback(
    async (planCode: string, method: PaymentMethod): Promise<CustomerCheckout | null> => {
      setState((current) => (current.status === 'starting' ? current : { status: 'starting' }));
      try {
        const checkout = await paymentsApi.startCheckout({
          planCode,
          method,
          idempotencyKey: newCheckoutKey(planCode),
          returnUrl: '/subscription',
        });
        setState({ status: 'started', checkout });
        return checkout;
      } catch (error) {
        setState({ status: 'failed', message: checkoutMessage(error) });
        return null;
      }
    },
    [],
  );

  return { state, start, reset: useCallback(() => setState({ status: 'idle' }), []) };
}

/* ------------------------------------------------------------------ *
 * The simulated payment screen
 * ------------------------------------------------------------------ */

export type SimulationState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; payment: CustomerPaymentView }
  | { status: 'sending'; payment: CustomerPaymentView }
  | { status: 'settled'; payment: CustomerPaymentView };

export const readCheckout = (checkoutRef: string): Promise<CustomerPaymentView> => paymentsApi.readCheckout(checkoutRef);

export const simulate = (checkoutRef: string, outcome: SimulatedOutcome): Promise<SimulatedPaymentResult> =>
  paymentsApi.simulate({ checkoutRef, outcome });
