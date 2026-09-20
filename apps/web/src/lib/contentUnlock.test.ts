import { describe, expect, it, vi } from 'vitest';
import type { CustomerContentUnlock } from '@over18/shared';
import { ApiRequestError } from './api';
import {
  ContentUnlockUnavailableError,
  UnlockAttempt,
  createHttpContentUnlockClient,
  newIdempotencyKey,
  pendingContentUnlockClient,
  unlockFailure,
  type ContentUnlockClient,
} from './contentUnlock';

/**
 * P8.2 (customer side) -- carrying one unlock to the server and back.
 *
 * Nothing here decides whether content may be unlocked, what it costs or
 * whether it is affordable. What is proven is that one intent becomes one
 * purchase, that a refusal is said plainly, and that nothing is ever treated as
 * owned because of something that happened on this side.
 */

const bought: CustomerContentUnlock = {
  assetId: 'a-1',
  entitlementId: 'e-1',
  offerId: 'o-1',
  creditPrice: 50,
  acquiredAt: '2026-09-20T00:00:00.000Z',
  replayed: false,
};

const target = { assetId: 'a-1', title: 'Post 3', creditPrice: 50 };

/** A client that answers only when the test says so. */
function deferred() {
  const calls: Array<{ assetId: string; idempotencyKey: string }> = [];
  let settle!: (outcome: { ok: true } | { ok: false; error: unknown }) => void;
  const client: ContentUnlockClient = {
    kind: 'fixture',
    unlock: (assetId, idempotencyKey) => {
      calls.push({ assetId, idempotencyKey });
      return new Promise((resolve, reject) => {
        settle = (outcome) => (outcome.ok ? resolve(bought) : reject(outcome.error));
      });
    },
  };
  return { client, calls, resolve: () => settle({ ok: true }), reject: (error: unknown) => settle({ ok: false, error }) };
}

const attemptOn = (client: ContentUnlockClient, onUnlocked?: (u: CustomerContentUnlock) => void) =>
  new UnlockAttempt({ client: () => client, onUnlocked });

/* ------------------------------------------------------------------ *
 * The client
 * ------------------------------------------------------------------ */

describe('the production default', () => {
  it('calls nothing and refuses, so nothing can be charged before it is switched on', async () => {
    expect(pendingContentUnlockClient.kind).toBe('pending');
    await expect(pendingContentUnlockClient.unlock('a-1', 'k')).rejects.toBeInstanceOf(ContentUnlockUnavailableError);
  });

  it('sends the asset and the key, and nothing else -- never a price', async () => {
    const unlock = vi.fn().mockResolvedValue(bought);
    await createHttpContentUnlockClient({ unlock }).unlock('a-1', 'key-1');
    expect(unlock).toHaveBeenCalledWith('a-1', { idempotencyKey: 'key-1' });
    expect(JSON.stringify(unlock.mock.calls)).not.toMatch(/price|credit|amount/i);
  });
});

/* ------------------------------------------------------------------ *
 * What a refusal says
 * ------------------------------------------------------------------ */

describe('what a refusal says to the customer', () => {
  const failed = (status: number, code: string) => unlockFailure(new ApiRequestError(status, code, 'server words'));

  it.each([
    ['insufficient_credits', 402, '/credits'],
    ['premium_required', 403, '/subscription'],
  ])('%s points at the screen that resolves it', (code, status, to) => {
    const failure = failed(status, code);
    expect(failure.code).toBe(code);
    expect(failure.action?.to).toBe(to);
    expect(failure.retryable).toBe(false);
  });

  it.each([
    ['unavailable', 404],
    ['age_restricted', 403],
    ['not_purchasable', 409],
  ])('%s is explained, with nowhere to go', (code, status) => {
    const failure = failed(status, code);
    expect(failure.message).toBeTruthy();
    expect(failure.action).toBeNull();
    expect(failure.retryable).toBe(false);
  });

  it.each([
    ['price_changed', 409],
    ['purchase_reversed', 409],
  ])('%s can be tried again', (code, status) => {
    expect(failed(status, code).retryable).toBe(true);
  });

  it('a refusal nobody anticipated is still said plainly, and is retryable', () => {
    const failure = failed(500, 'boom');
    expect(failure.code).toBe('boom');
    expect(failure.message).toMatch(/try again/i);
    expect(failure.retryable).toBe(true);
    expect(unlockFailure(new TypeError('network down')).message).toMatch(/try again/i);
  });

  it('answers "did that take my Credits?" wherever that is the question', () => {
    for (const code of ['insufficient_credits', 'price_changed', 'purchase_reversed', 'boom']) {
      expect(failed(409, code).message, code).toMatch(/nothing was charged/i);
    }
  });

  it('never shows the server sentence or a backend term, and never dresses a signed-out session as a payment failure', () => {
    for (const code of ['insufficient_credits', 'unavailable', 'age_restricted', 'price_changed', 'purchase_reversed', 'boom']) {
      const { message } = failed(409, code);
      expect(message, code).not.toBe('server words');
      expect(message, code).not.toMatch(/wallet|ledger|entitlement|paid_action|offer|held|spendable/i);
    }
    expect(failed(401, 'unauthorized').message).not.toMatch(/charged/i);
  });

  it('treats the pending client as "not available yet", not as a failure', () => {
    expect(unlockFailure(new ContentUnlockUnavailableError()).message).toMatch(/isn't available yet/i);
  });
});

/* ------------------------------------------------------------------ *
 * One attempt, one purchase
 * ------------------------------------------------------------------ */

describe('one attempt, one purchase', () => {
  it('opens a confirmation without sending anything', () => {
    const { client, calls } = deferred();
    const attempt = attemptOn(client);
    attempt.open(target);
    expect(attempt.state).toEqual({ target, busy: false, failure: null });
    expect(calls).toEqual([]);
  });

  it('sends once however many times it is confirmed, and reuses the one key', async () => {
    const { client, calls, resolve } = deferred();
    const onUnlocked = vi.fn();
    const attempt = attemptOn(client, onUnlocked);

    attempt.open(target);
    const key = attempt.idempotencyKey;
    // Three presses, the second and third while the first is still in flight.
    const first = attempt.confirm();
    void attempt.confirm();
    void attempt.confirm();
    expect(calls).toHaveLength(1);
    expect(attempt.state.busy).toBe(true);

    resolve();
    await first;
    expect(calls).toEqual([{ assetId: 'a-1', idempotencyKey: key }]);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(onUnlocked).toHaveBeenCalledWith(bought);
    // Closed, so nothing lingers over content that is now open.
    expect(attempt.state).toEqual({ target: null, busy: false, failure: null });
  });

  it('a retry after a failure carries the SAME key, so it can only replay the one purchase', async () => {
    const { client, calls, reject, resolve } = deferred();
    const attempt = attemptOn(client);

    attempt.open(target);
    const sending = attempt.confirm();
    reject(new ApiRequestError(409, 'price_changed', 'changed'));
    await sending;

    expect(attempt.state.failure?.code).toBe('price_changed');
    // Still open: a failure never closes the confirmation.
    expect(attempt.state.target).toEqual(target);
    expect(attempt.state.busy).toBe(false);

    const again = attempt.confirm();
    resolve();
    await again;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).toBe(calls[1]!.idempotencyKey);
  });

  it('starting again after cancelling is a new intent, and gets a new key', async () => {
    const { client, calls, resolve } = deferred();
    const attempt = attemptOn(client);

    attempt.open(target);
    const first = attempt.confirm();
    resolve();
    await first;

    attempt.open(target);
    const second = attempt.confirm();
    resolve();
    await second;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).not.toBe(calls[1]!.idempotencyKey);
  });

  it('cannot be cancelled out from under a request in flight', async () => {
    const { client, resolve } = deferred();
    const attempt = attemptOn(client);
    attempt.open(target);
    const sending = attempt.confirm();
    attempt.cancel();
    expect(attempt.state.target).toEqual(target);
    resolve();
    await sending;
  });

  it('cancelling an idle confirmation closes it and forgets the failure', async () => {
    const { client, reject } = deferred();
    const attempt = attemptOn(client);
    attempt.open(target);
    const sending = attempt.confirm();
    reject(new ApiRequestError(402, 'insufficient_credits', 'no'));
    await sending;
    attempt.cancel();
    expect(attempt.state).toEqual({ target: null, busy: false, failure: null });
  });

  it('a failure never tells the caller anything was unlocked', async () => {
    const { client, reject } = deferred();
    const onUnlocked = vi.fn();
    const attempt = attemptOn(client, onUnlocked);
    attempt.open(target);
    const sending = attempt.confirm();
    reject(new ApiRequestError(402, 'insufficient_credits', 'no'));
    await sending;

    expect(onUnlocked).not.toHaveBeenCalled();
    expect(attempt.state.failure?.action?.to).toBe('/credits');
    expect(attempt.state.busy).toBe(false);
  });

  it('confirming with nothing open does nothing at all', async () => {
    const { client, calls } = deferred();
    const attempt = attemptOn(client);
    await attempt.confirm();
    expect(calls).toEqual([]);
  });

  it('reports every change to whoever is watching', async () => {
    const { client, resolve } = deferred();
    const seen: Array<{ open: boolean; busy: boolean }> = [];
    const attempt = new UnlockAttempt({
      client: () => client,
      onChange: (state) => seen.push({ open: state.target !== null, busy: state.busy }),
    });
    attempt.open(target);
    const sending = attempt.confirm();
    resolve();
    await sending;
    expect(seen).toEqual([
      { open: true, busy: false },
      { open: true, busy: true },
      { open: false, busy: false },
    ]);
  });

  it('makes a distinct key every time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key.length).toBeGreaterThan(8);
  });
});
