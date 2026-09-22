import type { CustomerCommercialState, CustomerEconomyCatalog } from '@over18/shared';

/**
 * The customer economy read model.
 *
 * Every commercial value comes from the server, in the shared wire types:
 * the catalog from GET /api/economy/catalog, the customer's commercial state
 * from GET /api/me/commercial-state. The browser formats and displays; it
 * never prices, gates, or decides whether anyone can afford anything.
 */

/**
 * Where a paid action is PRESENTED -- not a server action vocabulary. No slot
 * maps to a backend action type or a cost; a quote for a slot can only come
 * from the server. Ordinary text chat is not a paid action and has no slot.
 */
export type CustomerActionSlot = 'voice_call' | 'premium_content';

/**
 * A server-authoritative quote for one action. The browser displays it and
 * never calculates or adjusts it. No endpoint produces quotes yet, so the HTTP
 * adapter supplies none; this is the shape they will arrive in.
 */
export interface CustomerActionQuote {
  availability: 'available' | 'unavailable';
  creditCost: number | null;
  unit: 'per_action' | 'per_minute' | null;
  unavailableReason: string | null;
  quoteId: string | null;
  expiresAt: string | null;
}

export interface CustomerAction {
  slot: CustomerActionSlot;
  title: string;
  description: string;
  quote: CustomerActionQuote;
}

/**
 * The UI aggregate, assembled by an adapter from the two read endpoints. Each
 * commercial fact keeps its server availability: an unavailable balance, tier,
 * subscription or age status stays unavailable, and is never defaulted.
 */
export interface CustomerEconomyOverview {
  commercial: CustomerCommercialState;
  catalog: CustomerEconomyCatalog;
  /** Server quotes, by slot. Empty until a quote contract exists. */
  actions: CustomerAction[];
}

export type CustomerEconomyState =
  | { status: 'loading' }
  /** The backend is not wired to this client yet (the pending adapter). */
  | { status: 'unavailable'; message: string }
  /** The server answered 503 `economy_unavailable`: the economy is switched off. */
  | { status: 'disabled'; message: string }
  /** The server answered 401: there is no session. */
  | { status: 'signed-out'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; overview: CustomerEconomyOverview };
