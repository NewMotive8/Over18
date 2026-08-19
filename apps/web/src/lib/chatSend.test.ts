import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChatSendController, IDLE_SEND_STATE, TYPING_INDICATOR_DELAY_MS } from './chatSend';

/**
 * Timing behaviour of the chat composer. These run in the repo's existing
 * node test environment (no DOM, no browser stack) because the controller is
 * deliberately React-free — which is the only reason the 2s indicator delay,
 * timer cancellation and multi-send staleness are testable at all.
 */

/** Collects every published state so ordering can be asserted, not just the end. */
function harness(overrides: Partial<Parameters<typeof createChatSendController>[0]> = {}) {
  const states: Array<{ pending: string | null; showTyping: boolean; sending: boolean }> = [];
  const results: unknown[] = [];
  const errors: unknown[] = [];
  let resolveSend!: (v: unknown) => void;
  let rejectSend!: (e: unknown) => void;
  const sendCalls: string[] = [];

  const controller = createChatSendController({
    send: (content: string) => {
      sendCalls.push(content);
      return new Promise((res, rej) => {
        resolveSend = res;
        rejectSend = rej;
      });
    },
    onState: (s) => states.push({ ...s }),
    onResult: (r) => results.push(r),
    onError: (e) => errors.push(e),
    ...overrides,
  });

  return {
    controller,
    states,
    results,
    errors,
    sendCalls,
    resolve: (v: unknown = { ok: true }) => resolveSend(v),
    reject: (e: unknown = new Error('boom')) => rejectSend(e),
    last: () => states[states.length - 1]!,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('chat send lifecycle', () => {
  it('(a) publishes the optimistic user message before the API responds', async () => {
    const h = harness();
    void h.controller.send('hi there');

    // Synchronously after send() — nothing awaited, nothing resolved.
    expect(h.last()).toEqual({ pending: 'hi there', showTyping: false, sending: true });
    expect(h.results).toHaveLength(0);
    // And the request went out immediately: it is NOT delayed by the timer.
    expect(h.sendCalls).toEqual(['hi there']);
  });

  it('(b) shows the typing indicator after ~2s while the request is still pending', async () => {
    const h = harness();
    void h.controller.send('hi');

    expect(h.last().showTyping).toBe(false);
    vi.advanceTimersByTime(TYPING_INDICATOR_DELAY_MS - 1);
    expect(h.last().showTyping).toBe(false); // not a millisecond early

    vi.advanceTimersByTime(1);
    expect(h.last()).toEqual({ pending: 'hi', showTyping: true, sending: true });
  });

  it('(c) a fast response never shows the typing indicator, even later', async () => {
    const h = harness();
    const p = h.controller.send('hi');

    h.resolve({ ok: true });
    await p;

    expect(h.states.some((s) => s.showTyping)).toBe(false);

    // The timer must have been cancelled: advancing well past it changes nothing.
    vi.advanceTimersByTime(TYPING_INDICATOR_DELAY_MS * 5);
    expect(h.states.some((s) => s.showTyping)).toBe(false);
    expect(h.last()).toEqual(IDLE_SEND_STATE);
  });

  it('(d) a slow response removes the typing indicator when it arrives', async () => {
    const h = harness();
    const p = h.controller.send('hi');

    vi.advanceTimersByTime(TYPING_INDICATOR_DELAY_MS);
    expect(h.last().showTyping).toBe(true);

    h.resolve({ ok: true });
    await p;

    expect(h.last()).toEqual(IDLE_SEND_STATE);
    expect(h.results).toHaveLength(1);
  });

  it('(e) a failed request clears the typing state and keeps the message visible', async () => {
    const h = harness();
    const p = h.controller.send('hi');

    vi.advanceTimersByTime(TYPING_INDICATOR_DELAY_MS);
    expect(h.last().showTyping).toBe(true);

    h.reject(new Error('502'));
    await p;

    // No permanent typing indicator, and the user's words survive for Retry.
    expect(h.last()).toEqual({ pending: 'hi', showTyping: false, sending: false });
    expect(h.errors).toHaveLength(1);

    vi.advanceTimersByTime(TYPING_INDICATOR_DELAY_MS * 5);
    expect(h.last().showTyping).toBe(false);
  });

  it('(f) the optimistic message is dropped exactly once on success, never duplicated', async () => {
    const h = harness();
    const p = h.controller.send('hello');
    h.resolve({ ok: true });
    await p;

    // pending returns to null in the SAME transition that reports the result,
    // so the caller appends the canonical rows while the bubble disappears.
    expect(h.last().pending).toBeNull();
    expect(h.results).toHaveLength(1);
    expect(h.states.filter((s) => s.pending === 'hello')).toHaveLength(1);
  });

  it('a second send never inherits the first send timer', async () => {
    const h = harness();
    void h.controller.send('first');
    vi.advanceTimersByTime(TYPING_INDICATOR_DELAY_MS - 10);

    void h.controller.send('second'); // supersedes; timer restarts
    vi.advanceTimersByTime(10); // would have fired the FIRST timer
    expect(h.last().showTyping).toBe(false);

    vi.advanceTimersByTime(TYPING_INDICATOR_DELAY_MS - 10);
    expect(h.last()).toEqual({ pending: 'second', showTyping: true, sending: true });
  });

  it('a superseded send cannot write state when it finally settles', async () => {
    const h = harness();
    void h.controller.send('first');
    const p2 = h.controller.send('second'); // resolve/reject now target #2

    h.resolve({ ok: 'second' });
    await p2;

    expect(h.last()).toEqual(IDLE_SEND_STATE);
    expect(h.results).toEqual([{ ok: 'second' }]);
  });

  it('dispose() cancels a live timer so it cannot fire after unmount', async () => {
    const h = harness();
    void h.controller.send('hi');

    h.controller.dispose();
    vi.advanceTimersByTime(TYPING_INDICATOR_DELAY_MS * 5);

    expect(h.states.some((s) => s.showTyping)).toBe(false);
  });

  it('clearPending() drops the optimistic message after a dismissed failure', async () => {
    const h = harness();
    const p = h.controller.send('hi');
    h.reject(new Error('502'));
    await p;

    expect(h.last().pending).toBe('hi');
    h.controller.clearPending();
    expect(h.last().pending).toBeNull();
  });
});
