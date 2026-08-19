import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createChatSendController,
  IDLE_SEND_STATE,
  TYPING_INDICATOR_DELAY_MS,
  REPLY_REVEAL_FLOOR_MS,
} from './chatSend';

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

  it('(c) a response before 2s still shows typing at 2s, and reveals at 5s', async () => {
    const h = harness();
    const p = h.controller.send('hi');

    vi.advanceTimersByTime(1000);
    h.resolve({ ok: true });
    await p;

    // Buffered, not revealed: 1s in, the reply must not be on screen.
    expect(h.results).toHaveLength(0);
    expect(h.last().pending).toBe('hi');

    // The indicator still appears on schedule at 2s.
    await vi.advanceTimersByTimeAsync(TYPING_INDICATOR_DELAY_MS - 1000);
    expect(h.last().showTyping).toBe(true);
    expect(h.results).toHaveLength(0);

    // Revealed exactly at the 5s floor.
    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS - TYPING_INDICATOR_DELAY_MS - 1);
    expect(h.results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toHaveLength(1);
    expect(h.last()).toEqual(IDLE_SEND_STATE);
  });

  it('(d) a slow response reveals when it lands, with no extra delay', async () => {
    const h = harness();
    const p = h.controller.send('hi');

    await vi.advanceTimersByTimeAsync(TYPING_INDICATOR_DELAY_MS);
    expect(h.last().showTyping).toBe(true);

    // Past the floor with nothing to reveal — the indicator stays up.
    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS - TYPING_INDICATOR_DELAY_MS + 2000);
    expect(h.last().showTyping).toBe(true);
    expect(h.results).toHaveLength(0);

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

  it('(f) the optimistic message is dropped exactly once on reveal, never duplicated', async () => {
    const h = harness();
    const p = h.controller.send('hello');
    h.resolve({ ok: true });
    await p;
    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS); // reveal is floored

    // pending returns to null in the SAME transition that reports the result,
    // so the caller appends the canonical rows while the bubble disappears.
    expect(h.last().pending).toBeNull();
    expect(h.results).toHaveLength(1);

    // The bubble text is only ever this one message (never a second copy),
    // and it is cleared exactly once — counting transitions would be wrong,
    // since `pending` legitimately persists across the typing transition.
    const pendings = h.states.map((s) => s.pending);
    expect(pendings.filter((p) => p !== null)).toEqual(pendings.filter((p) => p === 'hello'));
    const clears = pendings.filter((p, i) => p === null && pendings[i - 1] === 'hello');
    expect(clears).toHaveLength(1);
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
    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS);

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

  it('the request is issued at once, never gated by either delay', async () => {
    const h = harness();
    void h.controller.send('immediate');
    // Zero timers advanced: the network call has already been made.
    expect(h.sendCalls).toEqual(['immediate']);
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

describe('reply reveal floor (never before 5s)', () => {
  it('response at 1s is held until 5s', async () => {
    const h = harness();
    const p = h.controller.send('hi');
    await vi.advanceTimersByTimeAsync(1000);
    h.resolve({ ok: true });
    await p;

    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS - 1000 - 1);
    expect(h.results).toHaveLength(0); // 4999ms: still hidden
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toHaveLength(1); // 5000ms: revealed
  });

  it('response at 4s is held until 5s', async () => {
    const h = harness();
    const p = h.controller.send('hi');
    await vi.advanceTimersByTimeAsync(4000);
    h.resolve({ ok: true });
    await p;

    expect(h.results).toHaveLength(0);
    expect(h.last().showTyping).toBe(true); // typing still up at 4s
    await vi.advanceTimersByTimeAsync(999);
    expect(h.results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toHaveLength(1);
  });

  it('response at 7s appears at 7s, not later', async () => {
    const h = harness();
    const p = h.controller.send('hi');
    await vi.advanceTimersByTimeAsync(7000);
    expect(h.results).toHaveLength(0);
    expect(h.last().showTyping).toBe(true);

    h.resolve({ ok: true });
    await p;
    expect(h.results).toHaveLength(1); // immediately, no extra wait
    expect(h.last()).toEqual(IDLE_SEND_STATE);
  });

  it('the typing indicator disappears in the same transition that reveals', async () => {
    const h = harness();
    const p = h.controller.send('hi');
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.last().showTyping).toBe(true);
    h.resolve({ ok: true });
    await p;
    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS - 2500);

    expect(h.last().showTyping).toBe(false);
    expect(h.last().pending).toBeNull();
    expect(h.results).toHaveLength(1);
  });

  it('a failure is surfaced immediately and is not held to 5s', async () => {
    const h = harness();
    const p = h.controller.send('hi');
    await vi.advanceTimersByTimeAsync(1000);
    h.reject(new Error('502'));
    await p;

    expect(h.errors).toHaveLength(1); // at 1s, not 5s
    expect(h.last()).toEqual({ pending: 'hi', showTyping: false, sending: false });

    // No floor or typing timer may fire afterwards.
    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS * 2);
    expect(h.last().showTyping).toBe(false);
    expect(h.results).toHaveLength(0);
  });

  it('a buffered reply from a superseded send can never be revealed', async () => {
    const h = harness();
    void h.controller.send('first');
    await vi.advanceTimersByTimeAsync(1000);

    const p2 = h.controller.send('second'); // supersedes; floor restarts
    h.resolve({ ok: 'second' });
    await p2;

    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS);
    expect(h.results).toEqual([{ ok: 'second' }]); // exactly one, the newer one
    expect(h.last()).toEqual(IDLE_SEND_STATE);
  });

  it('dispose() cancels the floor timer too', async () => {
    const h = harness();
    const p = h.controller.send('hi');
    h.resolve({ ok: true });
    await p;

    h.controller.dispose();
    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS * 2);
    expect(h.results).toHaveLength(0); // never revealed after unmount
  });
});
