import { useCallback, useEffect, useState } from 'react';
import type { CustomerCommercialState, CustomerEconomyCatalog } from '@over18/shared';
import { ApiRequestError, economyApi } from './api';
import type { CustomerEconomyOverview, CustomerEconomyState } from './customerEconomy.models';

/**
 * The customer economy client boundary.
 *
 * Three kinds of client, told apart by `kind` -- never by object identity:
 *
 *   pending  the production default until the HTTP client is switched on.
 *            Fails closed: it calls nothing and yields no data at all.
 *   http     reads the two existing read endpoints, and only those.
 *   fixture  explicit test/development data. It lives in
 *            `customerEconomy.fixture.ts`, which no application module
 *            imports and the public module does not re-export.
 */
export interface CustomerEconomyClient {
  readonly kind: 'pending' | 'http' | 'fixture';
  getOverview(): Promise<CustomerEconomyOverview>;
}

export class EconomyBackendUnavailableError extends Error {
  constructor() {
    super('Customer economy backend support is pending.');
    this.name = 'EconomyBackendUnavailableError';
  }
}

export const pendingCustomerEconomyClient: CustomerEconomyClient = {
  kind: 'pending',
  getOverview: () => Promise.reject(new EconomyBackendUnavailableError()),
};

/** The two read endpoints, injectable so the mapping is testable without a network. */
export interface CustomerEconomyEndpoints {
  catalog(): Promise<CustomerEconomyCatalog>;
  commercialState(): Promise<CustomerCommercialState>;
}

/**
 * The HTTP client. The overview is the two server answers side by side, as
 * given: the commercial state's availability is passed through untouched, the
 * catalog is the server's list with nothing added (no "Free" plan), and there
 * are no actions, because no endpoint quotes one yet.
 */
export function createHttpCustomerEconomyClient(endpoints: CustomerEconomyEndpoints = economyApi): CustomerEconomyClient {
  return {
    kind: 'http',
    async getOverview() {
      const [commercial, catalog] = await Promise.all([endpoints.commercialState(), endpoints.catalog()]);
      return { commercial, catalog, actions: [] };
    },
  };
}

/**
 * THE PRODUCTION DEFAULT: pending. Switching it to the HTTP client is a
 * deliberate, separate change -- the backend endpoints are not released yet.
 */
export const customerEconomyClient: CustomerEconomyClient = pendingCustomerEconomyClient;

export const ECONOMY_MESSAGES = {
  pending: 'Backend support pending. Economy details are unavailable right now.',
  disabled: 'Plans and Credits are not available yet.',
  signedOut: 'Sign in to see your plan and Credits.',
  error: "We couldn't load your account benefits.",
} as const;

/* ------------------------------------------------------------------ *
 * State transitions -- pure, so they are tested without a DOM
 * ------------------------------------------------------------------ */

export function initialEconomyState(client: CustomerEconomyClient): CustomerEconomyState {
  return client.kind === 'pending' ? { status: 'unavailable', message: ECONOMY_MESSAGES.pending } : { status: 'loading' };
}

export function economyStateFromOverview(overview: CustomerEconomyOverview): CustomerEconomyState {
  return { status: 'ready', overview };
}

/**
 * Every failure maps to a state that shows nothing commercial. Only the
 * server's own 503 `economy_unavailable` means "switched off"; any other 503
 * is an outage and reads as an error.
 */
export function economyStateFromError(error: unknown): CustomerEconomyState {
  if (error instanceof EconomyBackendUnavailableError) return { status: 'unavailable', message: ECONOMY_MESSAGES.pending };
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return { status: 'signed-out', message: ECONOMY_MESSAGES.signedOut };
    if (error.status === 503 && error.code === 'economy_unavailable') {
      return { status: 'disabled', message: ECONOMY_MESSAGES.disabled };
    }
  }
  return { status: 'error', message: ECONOMY_MESSAGES.error };
}

/**
 * Read hook. With the pending client it never makes a call: the state is
 * `unavailable` from the first render, so no commercial value can appear even
 * briefly. Tests and development inject another client explicitly.
 */
export function useCustomerEconomy(
  client: CustomerEconomyClient = customerEconomyClient,
): [CustomerEconomyState, () => void] {
  const [state, setState] = useState<CustomerEconomyState>(() => initialEconomyState(client));
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (client.kind === 'pending') return;
    let cancelled = false;
    setState({ status: 'loading' });
    client
      .getOverview()
      .then((overview) => {
        if (!cancelled) setState(economyStateFromOverview(overview));
      })
      .catch((error: unknown) => {
        if (!cancelled) setState(economyStateFromError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, client]);

  return [state, retry];
}
