import { useCallback, useEffect, useState } from 'react';
import type { CustomerContentAccess, CustomerContentAccessResponse } from '@over18/shared';
import { ApiRequestError, contentAccessApi } from './api';

/**
 * CONTENT ACCESS, AS THE SERVER DECIDED IT (P4.2 -> P8.1).
 *
 * `GET /api/content/access` answers, for each piece of content, what this
 * customer may do with it. This module carries that answer to the card and
 * turns it into words; it decides NOTHING. There is no price, no balance
 * comparison, no tier check and no entitlement rule here -- a state the server
 * did not send cannot appear, and `unknown` renders the tile exactly as the app
 * renders it today.
 *
 * The client kinds mirror the customer economy client, and for the same reason:
 * `pending` is the production default and calls nothing, so no access state can
 * appear before the endpoint is released.
 */

export interface ContentAccessClient {
  readonly kind: 'pending' | 'http' | 'fixture';
  getAccess(assetIds: string[]): Promise<CustomerContentAccessResponse>;
}

export class ContentAccessUnavailableError extends Error {
  constructor() {
    super('Content access backend support is pending.');
    this.name = 'ContentAccessUnavailableError';
  }
}

export const pendingContentAccessClient: ContentAccessClient = {
  kind: 'pending',
  getAccess: () => Promise.reject(new ContentAccessUnavailableError()),
};

export function createHttpContentAccessClient(endpoints: Pick<typeof contentAccessApi, 'access'> = contentAccessApi): ContentAccessClient {
  return { kind: 'http', getAccess: (assetIds) => endpoints.access(assetIds) };
}

/**
 * THE PRODUCTION DEFAULT IS NOW THE HTTP CLIENT (P9).
 *
 * It was `pending` while no endpoint existed. The endpoint exists, and the
 * gate that matters is the SERVER's. A pending client on top of that gated
 * nothing extra and made the purchase flow impossible to build or review -- so
 * the real client is used, and the server stays the only thing deciding
 * whether anyone may see or buy anything.
 *
 * THIS ENDPOINT ANSWERS WITH THE ECONOMY OFF, unlike the unlock and the
 * economy reads beside it. An operator can mark a clip Free or Premium before
 * anything is for sale, and the server enforces exactly that decision and
 * nothing else -- so `unavailable` below now means a session problem or a
 * failure, rather than the production default. Nothing here decides access:
 * the server's answer is rendered as given.
 */
export const contentAccessClient: ContentAccessClient = createHttpContentAccessClient();

export type ContentAccessState =
  | { status: 'loading' }
  /** The endpoint is not wired to this client yet, or the economy is off. */
  | { status: 'unavailable' }
  | { status: 'error' }
  | { status: 'ready'; byAsset: Map<string, CustomerContentAccess> };

export function initialContentAccessState(client: ContentAccessClient): ContentAccessState {
  return client.kind === 'pending' ? { status: 'unavailable' } : { status: 'loading' };
}

export function contentAccessStateFromResponse(response: CustomerContentAccessResponse): ContentAccessState {
  return { status: 'ready', byAsset: new Map(response.items.map((item) => [item.assetId, item])) };
}

/**
 * Every failure shows the app as it is today rather than a guess: no access
 * state, no price, no lock. Nothing is granted by a failure either -- the
 * server serves the media, and this module never unlocks anything.
 */
export function contentAccessStateFromError(error: unknown): ContentAccessState {
  if (error instanceof ContentAccessUnavailableError) return { status: 'unavailable' };
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return { status: 'unavailable' };
    if (error.status === 503 && error.code === 'economy_unavailable') return { status: 'unavailable' };
  }
  return { status: 'error' };
}

/** The server's answer for one asset, or null while there is none. */
export function accessFor(state: ContentAccessState, assetId: string): CustomerContentAccess | null {
  return state.status === 'ready' ? (state.byAsset.get(assetId) ?? null) : null;
}

/* ------------------------------------------------------------------ *
 * What a card shows -- pure, from the server's decision only
 * ------------------------------------------------------------------ */

export type ContentCardState = CustomerContentAccess['decision'] | 'unknown';

export interface ContentCardCta {
  label: string;
  /** Where it goes, when it goes anywhere. */
  to: string | null;
  /** Something the surface does, rather than a place to go (P8.2). */
  action: 'unlock' | null;
  /** True while the capability behind it does not exist yet. */
  disabled: boolean;
  /** Why it is disabled, said plainly. */
  hint: string | null;
}

export interface ContentCardView {
  state: ContentCardState;
  /** Whether the media itself may be shown. Locked content is never revealed. */
  revealed: boolean;
  /** The chip on the tile: what kind of access this content needs. */
  badge: { label: string; tone: 'premium' | 'credit' | 'neutral' } | null;
  /** One line explaining the state. */
  message: string | null;
  cta: ContentCardCta | null;
}

const OPEN_VIEW: ContentCardView = { state: 'unknown', revealed: true, badge: null, message: null, cta: null };

/**
 * Premium and Credits are never the same offer: rose for one, amber for the
 * other.
 *
 * `canUnlock` is the SURFACE saying it can carry an unlock through -- it has a
 * confirmation to open and somewhere to send it. It is off by default, so a
 * surface that cannot do that still shows the Credit price and says unlocking
 * is not open there, rather than offering a button that would do nothing.
 */
export function contentCardView(
  access: CustomerContentAccess | null,
  options: { canUnlock?: boolean } = {},
): ContentCardView {
  if (!access) return OPEN_VIEW;
  switch (access.decision) {
    case 'owned':
      return {
        state: 'owned',
        revealed: true,
        // Bought and kept: said once, quietly, so it reads differently from free content.
        badge: { label: 'Unlocked', tone: 'credit' },
        message: null,
        cta: null,
      };
    case 'open':
      return {
        state: 'open',
        revealed: true,
        // Premium content a subscriber holds says so, quietly; free content says nothing.
        badge: access.state === 'premium' ? { label: 'Included', tone: 'premium' } : null,
        message: null,
        cta: null,
      };
    /**
     * PREMIUM CONTENT CARRIES NO BUTTON.
     *
     * The tile still says everything it needs to: the real preview behind the
     * lock, the Premium chip, and one line naming what would open it. What it
     * no longer does is ask. A grid where most tiles are Premium -- which is
     * what P4.D2's default makes it -- turned into a wall of identical rose
     * buttons all pointing at the same page, which reads as pressure rather
     * than information.
     *
     * Premium stays reachable the way it always was: the Profile hub, the
     * Credits pill, and the character's own Premium action. Nothing here
     * removes a route to it; this removes the nagging.
     *
     * Credit content keeps its CTA, and deliberately: its button names a PRICE,
     * which is information the customer cannot get anywhere else on the tile.
     */
    case 'premium_required':
      return {
        state: 'premium_required',
        revealed: false,
        badge: { label: 'Premium', tone: 'premium' },
        message: 'Included with Premium.',
        cta: null,
      };
    case 'credits_required': {
      const unlock = `Unlock · ${creditLabel(access.creditPrice)}`;
      return {
        state: 'credits_required',
        revealed: false,
        badge: { label: creditLabel(access.creditPrice), tone: 'credit' },
        message: `Unlock this with ${creditLabel(access.creditPrice)}.`,
        cta: options.canUnlock
          ? { label: unlock, to: null, action: 'unlock', disabled: false, hint: null }
          : { label: unlock, to: null, action: null, disabled: true, hint: 'Unlocking is coming soon.' },
      };
    }
    case 'insufficient_credits':
      return {
        state: 'insufficient_credits',
        revealed: false,
        badge: { label: creditLabel(access.creditPrice), tone: 'credit' },
        message: `You need ${creditLabel(access.creditPrice)} to unlock this.`,
        cta: { label: 'Get Credits', to: '/credits', action: null, disabled: false, hint: null },
      };
    case 'age_restricted':
      return {
        state: 'age_restricted',
        revealed: false,
        badge: { label: access.ageFloor === null ? 'Age check' : `${access.ageFloor}+`, tone: 'neutral' },
        message: 'Confirm your age to view this.',
        cta: { label: 'Confirm age', to: null, action: null, disabled: true, hint: 'Age confirmation is coming soon.' },
      };
    case 'unavailable':
      return {
        state: 'unavailable',
        revealed: false,
        badge: { label: 'Unavailable', tone: 'neutral' },
        message: "This content isn't available.",
        cta: null,
      };
  }
}

/** "50 Credits", or just "Credits" when the server sent no price. */
function creditLabel(price: number | null): string {
  return price === null ? 'Credits' : `${price} ${price === 1 ? 'Credit' : 'Credits'}`;
}

/** What assistive technology is told about a tile. */
export function contentCardLabel(view: ContentCardView, title: string): string {
  if (view.revealed) return title;
  return `${title} — locked. ${view.message ?? ''}`.trim();
}

/**
 * Reads access for the assets on screen. With the pending client it never
 * calls, so the tiles render exactly as they do today.
 */
export function useContentAccess(
  assetIds: string[],
  client: ContentAccessClient = contentAccessClient,
): [ContentAccessState, () => void] {
  const [state, setState] = useState<ContentAccessState>(() => initialContentAccessState(client));
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // The identity of the list, so a re-render with the same ids does not re-ask.
  const key = assetIds.join(',');

  useEffect(() => {
    if (client.kind === 'pending' || key === '') return;
    let cancelled = false;
    setState({ status: 'loading' });
    client
      .getAccess(key.split(','))
      .then((response) => {
        if (!cancelled) setState(contentAccessStateFromResponse(response));
      })
      .catch((error: unknown) => {
        if (!cancelled) setState(contentAccessStateFromError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, client, key]);

  return [state, retry];
}
