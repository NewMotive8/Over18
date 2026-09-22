import { describe, expect, it } from 'vitest';
import type { CustomerContentAccess } from '@over18/shared';
import { ApiRequestError } from './api';
import {
  ContentAccessUnavailableError,
  accessFor,
  contentAccessStateFromError,
  contentAccessStateFromResponse,
  contentCardLabel,
  contentCardView,
  createHttpContentAccessClient,
  initialContentAccessState,
  pendingContentAccessClient,
} from './contentAccess';

/**
 * P8.1 -- the card state family, as pure logic.
 *
 * The server (P4.2) decides access; this module only carries the decision and
 * puts it into words. Every price and age below is server-shaped test data:
 * nothing here may compute, compare or default one.
 */

const access = (over: Partial<CustomerContentAccess> = {}): CustomerContentAccess => ({
  assetId: 'asset-1',
  state: 'free',
  creditPrice: null,
  ageFloor: null,
  decision: 'open',
  ...over,
});

describe('the card shows exactly what the server decided', () => {
  it('open content is revealed, with no lock and nothing to press', () => {
    const view = contentCardView(access());
    expect(view).toMatchObject({ state: 'open', revealed: true, badge: null, message: null, cta: null });
  });

  it('content the customer bought is revealed and marked Unlocked, with nothing left to buy', () => {
    const view = contentCardView(access({ state: 'credit', creditPrice: 50, decision: 'owned' }));
    expect(view).toEqual({
      state: 'owned',
      revealed: true,
      badge: { label: 'Unlocked', tone: 'credit' },
      message: null,
      cta: null,
    });
  });

  it('still says Unlocked once the price has moved on, because owning it is the point', () => {
    expect(contentCardView(access({ state: 'credit', creditPrice: 500, decision: 'owned' })).badge?.label).toBe('Unlocked');
    expect(contentCardView(access({ state: 'free', creditPrice: null, decision: 'owned' })).revealed).toBe(true);
  });

  it("marks Premium content a subscriber holds as included, without selling them Premium again", () => {
    const view = contentCardView(access({ state: 'premium', decision: 'open' }));
    expect(view).toMatchObject({ revealed: true, badge: { label: 'Included', tone: 'premium' }, cta: null });
  });

  it('Premium content is named and locked, and offers no call to action', () => {
    const view = contentCardView(access({ state: 'premium', decision: 'premium_required' }));
    expect(view).toEqual({
      state: 'premium_required',
      revealed: false,
      badge: { label: 'Premium', tone: 'premium' },
      message: 'Included with Premium.',
      cta: null,
    });
  });

  it("Credit content always carries the server's price, and says unlocking is not open yet", () => {
    const view = contentCardView(access({ state: 'credit', creditPrice: 50, decision: 'credits_required' }));
    expect(view).toMatchObject({
      state: 'credits_required',
      revealed: false,
      badge: { label: '50 Credits', tone: 'credit' },
      message: 'Unlock this with 50 Credits.',
      cta: { label: 'Unlock · 50 Credits', to: null, disabled: true, hint: 'Unlocking is coming soon.' },
    });
    expect(contentCardView(access({ state: 'credit', creditPrice: 1, decision: 'credits_required' })).badge?.label).toBe('1 Credit');
  });

  it('a surface that can carry an unlock gets a live action instead of "coming soon"', () => {
    const view = contentCardView(access({ state: 'credit', creditPrice: 50, decision: 'credits_required' }), { canUnlock: true });
    expect(view.cta).toEqual({ label: 'Unlock · 50 Credits', to: null, action: 'unlock', disabled: false, hint: null });
    // Still the server's price, and still nowhere to navigate to.
    expect(view.badge).toEqual({ label: '50 Credits', tone: 'credit' });
    expect(view.revealed).toBe(false);
  });

  it('only Credit content becomes an action: Premium and age keep exactly what they had', () => {
    // Premium has no CTA to turn into an action, with or without `canUnlock`.
    const premium = contentCardView(access({ state: 'premium', decision: 'premium_required' }), { canUnlock: true });
    expect(premium.cta).toBeNull();
    const age = contentCardView(access({ ageFloor: 21, decision: 'age_restricted' }), { canUnlock: true });
    expect(age.cta?.action).toBeNull();
    expect(age.cta?.disabled).toBe(true);
    const short = contentCardView(access({ state: 'credit', creditPrice: 50, decision: 'insufficient_credits' }), { canUnlock: true });
    expect(short.cta).toEqual({ label: 'Get Credits', to: '/credits', action: null, disabled: false, hint: null });
  });

  it('too few Credits keeps the price and offers Credits -- not Premium', () => {
    const view = contentCardView(access({ state: 'credit', creditPrice: 50, decision: 'insufficient_credits' }));
    expect(view).toMatchObject({
      state: 'insufficient_credits',
      revealed: false,
      badge: { label: '50 Credits', tone: 'credit' },
      message: 'You need 50 Credits to unlock this.',
      cta: { label: 'Get Credits', to: '/credits', disabled: false, hint: null },
    });
  });

  it('an age floor is shown as the age, and its control is not open yet', () => {
    const view = contentCardView(access({ state: 'premium', ageFloor: 21, decision: 'age_restricted' }));
    expect(view).toMatchObject({
      state: 'age_restricted',
      revealed: false,
      badge: { label: '21+', tone: 'neutral' },
      message: 'Confirm your age to view this.',
      cta: { label: 'Confirm age', disabled: true, hint: 'Age confirmation is coming soon.' },
    });
    expect(contentCardView(access({ ageFloor: null, decision: 'age_restricted' })).badge?.label).toBe('Age check');
  });

  it('unavailable content is locked, explained, and offers nothing to press', () => {
    const view = contentCardView(access({ state: 'unavailable', decision: 'unavailable' }));
    expect(view).toMatchObject({ state: 'unavailable', revealed: false, badge: { label: 'Unavailable' }, cta: null });
  });

  it('content the server said nothing about renders as it does today: no state, no lock, no price', () => {
    expect(contentCardView(null)).toEqual({ state: 'unknown', revealed: true, badge: null, message: null, cta: null });
  });

  it('never invents a price the server did not send', () => {
    for (const decision of ['credits_required', 'insufficient_credits'] as const) {
      const view = contentCardView(access({ state: 'credit', creditPrice: null, decision }));
      expect(view.badge?.label, decision).toBe('Credits');
      expect(JSON.stringify(view), decision).not.toMatch(/\b0 Credits\b|NaN|undefined/);
    }
  });

  it('describes a locked tile for assistive technology, and a revealed one by its title', () => {
    expect(contentCardLabel(contentCardView(access()), 'Post 3')).toBe('Post 3');
    expect(contentCardLabel(contentCardView(access({ state: 'premium', decision: 'premium_required' })), 'Post 3')).toBe(
      'Post 3 — locked. Included with Premium.',
    );
  });

  it('speaks no wallet, ledger or held-balance language in any state', () => {
    const decisions = ['open', 'premium_required', 'credits_required', 'insufficient_credits', 'age_restricted', 'unavailable'] as const;
    for (const decision of decisions) {
      const view = contentCardView(access({ state: 'credit', creditPrice: 50, ageFloor: 18, decision }));
      expect(JSON.stringify(view), decision).not.toMatch(/wallet|ledger|held|spendable|balance|entitlement|included credits/i);
    }
  });
});

describe('reading access from the server', () => {
  it('asks for nothing at all with the pending client -- the production default', () => {
    expect(pendingContentAccessClient.kind).toBe('pending');
    expect(initialContentAccessState(pendingContentAccessClient)).toEqual({ status: 'unavailable' });
    expect(initialContentAccessState(createHttpContentAccessClient({ access: async () => ({ items: [] }) }))).toEqual({ status: 'loading' });
  });

  it('keys the answers by asset, and answers nothing for an asset it was not told about', () => {
    const state = contentAccessStateFromResponse({ items: [access({ assetId: 'a' }), access({ assetId: 'b', decision: 'unavailable', state: 'unavailable' })] });
    expect(accessFor(state, 'a')).toMatchObject({ decision: 'open' });
    expect(accessFor(state, 'b')).toMatchObject({ decision: 'unavailable' });
    expect(accessFor(state, 'never-asked')).toBeNull();
    expect(accessFor({ status: 'loading' }, 'a')).toBeNull();
  });

  it('turns every failure into no access state at all -- never a guessed one', () => {
    expect(contentAccessStateFromError(new ContentAccessUnavailableError())).toEqual({ status: 'unavailable' });
    expect(contentAccessStateFromError(new ApiRequestError(401, 'unauthorized', 'nope'))).toEqual({ status: 'unavailable' });
    expect(contentAccessStateFromError(new ApiRequestError(503, 'economy_unavailable', 'off'))).toEqual({ status: 'unavailable' });
    expect(contentAccessStateFromError(new ApiRequestError(500, 'boom', 'boom'))).toEqual({ status: 'error' });
    expect(contentAccessStateFromError(new Error('offline'))).toEqual({ status: 'error' });
    // A failure grants nothing: every card falls back to the unknown view.
    for (const state of [{ status: 'error' } as const, { status: 'unavailable' } as const]) {
      expect(contentCardView(accessFor(state, 'a'))).toMatchObject({ state: 'unknown', cta: null });
    }
  });

  it('the HTTP client passes the ids straight to the endpoint', async () => {
    const asked: string[][] = [];
    const client = createHttpContentAccessClient({
      access: async (ids) => {
        asked.push([...ids]);
        return { items: [] };
      },
    });
    await client.getAccess(['a', 'b']);
    expect(asked).toEqual([['a', 'b']]);
    expect(client.kind).toBe('http');
  });
});

/* ------------------------------------------------------------------ *
 * Before the answer arrives
 * ------------------------------------------------------------------ */

/**
 * THE PAYWALL USED TO LEAK ON EVERY PAGE LOAD. Tiles render from the clip
 * list; the access decision arrives on a second request. With no answer yet
 * every tile fell through to the open view, so Premium content played in the
 * clear for one round trip and then snapped shut -- plainly visible, and
 * reported from the real app.
 */
describe('a tile whose access is still being fetched', () => {
  it('reveals nothing', () => {
    const view = contentCardView(null, { pending: true });
    expect(view.revealed).toBe(false);
    expect(view.state).toBe('pending');
  });

  it('says nothing either: no lock, no badge, no message, no button', () => {
    const view = contentCardView(null, { pending: true });
    expect(view.badge).toBeNull();
    expect(view.message).toBeNull();
    expect(view.cta).toBeNull();
  });

  /** It may be about to turn out free, so it must not claim to be locked. */
  it('is announced as checking, not as locked', () => {
    expect(contentCardLabel(contentCardView(null, { pending: true }), 'Post 1')).toBe('Post 1 — checking access');
  });

  it('leaves the no-answer-at-all case exactly as it was', () => {
    // `unavailable` / an error still render the app as it is today.
    expect(contentCardView(null).revealed).toBe(true);
    expect(contentCardView(null, { pending: false }).revealed).toBe(true);
  });
});
