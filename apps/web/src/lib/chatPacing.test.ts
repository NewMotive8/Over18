import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SendMessageResult } from '@over18/shared';
import {
  createPacedSend,
  replyHoldMs,
  LONG_REPLY_HOLD_MS,
  MEDIA_HOLD_MS,
  SHORT_REPLY_MAX_CHARS,
} from './chatPacing';
import {
  createChatSendController,
  IDLE_SEND_STATE,
  REPLY_REVEAL_FLOOR_MS,
  TYPING_INDICATOR_DELAY_MS,
} from './chatSend';

/**
 * Reply pacing.
 *
 * The contract under test, end to end:
 *
 *     reveal = max(5s, actual response time) + hold
 *
 * with hold = 0 for a short text reply, 2.5s for a longer one, and 3s minimum
 * for any reply carrying media. The 2s typing indicator and the 5s floor are
 * NOT changed by any of this, so the integration tests below drive the real
 * chatSend controller rather than a stand-in — if the wrapper disturbed the
 * controller's timing contract, these would be the tests that noticed.
 *
 * Node environment, fake timers, no DOM: the same reason chatSend.test.ts is
 * shaped this way.
 */

function reply(content: string, media?: 'image' | 'video'): SendMessageResult {
  return {
    userMessage: { id: 'u1', sender: 'user', content: 'hi', createdAt: 'x' },
    characterMessage: {
      id: 'c1',
      sender: 'character',
      content,
      createdAt: 'x',
      ...(media ? { media: { type: media, url: '/api/x' } } : {}),
    },
  };
}

const SHORT = 'a'.repeat(SHORT_REPLY_MAX_CHARS); // exactly at the line
const LONG = 'a'.repeat(SHORT_REPLY_MAX_CHARS + 1); // one over
const VERY_LONG = 'a'.repeat(400);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/* ------------------------------------------------------------------ *
 * The policy itself
 * ------------------------------------------------------------------ */

describe('replyHoldMs — thresholds', () => {
  it('does not slow down a one-liner', () => {
    expect(replyHoldMs(reply('Mm.'))).toBe(0);
  });

  it('treats exactly SHORT_REPLY_MAX_CHARS as short', () => {
    expect(replyHoldMs(reply(SHORT))).toBe(0);
  });

  it('holds one character over the line', () => {
    expect(replyHoldMs(reply(LONG))).toBe(LONG_REPLY_HOLD_MS);
  });

  it('does not scale past the long hold', () => {
    expect(replyHoldMs(reply(VERY_LONG))).toBe(LONG_REPLY_HOLD_MS);
  });

  it('holds an empty reply not at all', () => {
    expect(replyHoldMs(reply(''))).toBe(0);
  });
});

describe('replyHoldMs — media precedence', () => {
  it('holds an image for the media minimum even with a short caption', () => {
    expect(replyHoldMs(reply('Here.', 'image'))).toBe(MEDIA_HOLD_MS);
  });

  it('holds a video the same way', () => {
    expect(replyHoldMs(reply('Here.', 'video'))).toBe(MEDIA_HOLD_MS);
  });

  it('takes the LARGER of the two holds, never the sum', () => {
    const both = replyHoldMs(reply(VERY_LONG, 'video'));
    expect(both).toBe(MEDIA_HOLD_MS);
    expect(both).not.toBe(MEDIA_HOLD_MS + LONG_REPLY_HOLD_MS);
    expect(both).toBe(Math.max(MEDIA_HOLD_MS, LONG_REPLY_HOLD_MS));
  });
});

/* ------------------------------------------------------------------ *
 * The wrapper in isolation
 * ------------------------------------------------------------------ */

describe('createPacedSend', () => {
  function pacedHarness(result: SendMessageResult) {
    const timers: number[] = [];
    let settle!: (v: SendMessageResult) => void;
    let fail!: (e: unknown) => void;
    const raw = vi.fn(
      () =>
        new Promise<SendMessageResult>((res, rej) => {
          settle = res;
          fail = rej;
        }),
    );
    const paced = createPacedSend({
      send: raw,
      setTimer: (fn, ms) => {
        timers.push(ms);
        return setTimeout(fn, ms);
      },
    });
    return { paced, raw, timers, settle: () => settle(result), fail: (e: unknown) => fail(e) };
  }

  it('fires the request immediately — the hold never gates the network call', () => {
    const h = pacedHarness(reply(LONG));
    void h.paced('hi');
    expect(h.raw).toHaveBeenCalledTimes(1);
    expect(h.raw).toHaveBeenCalledWith('hi');
  });

  it('schedules nothing at all when the hold is zero', async () => {
    const h = pacedHarness(reply(SHORT));
    const p = h.paced('hi');
    await vi.advanceTimersByTimeAsync(1000);
    h.settle();
    await expect(p).resolves.toEqual(reply(SHORT));
    // The untouched fast path: the controller's own floor still does the work.
    expect(h.timers).toEqual([]);
  });

  it('settles a long reply at floor + 2.5s', async () => {
    const h = pacedHarness(reply(LONG));
    const p = h.paced('hi');
    let done = false;
    void p.then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(1000);
    h.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    // Arrived at 1s → waits out the floor (4s) then the hold (2.5s).
    expect(h.timers).toEqual([REPLY_REVEAL_FLOOR_MS - 1000 + LONG_REPLY_HOLD_MS]);

    await vi.advanceTimersByTimeAsync(6499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true); // t = 7500
  });

  it('settles a media reply at floor + 3s', async () => {
    const h = pacedHarness(reply('Here.', 'image'));
    void h.paced('hi');
    await vi.advanceTimersByTimeAsync(1000);
    h.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.timers).toEqual([REPLY_REVEAL_FLOOR_MS - 1000 + MEDIA_HOLD_MS]); // → t = 8000
  });

  it('adds the hold on top of a SLOW response instead of overlapping it', async () => {
    const h = pacedHarness(reply(LONG));
    void h.paced('hi');
    await vi.advanceTimersByTimeAsync(7000); // already well past the floor
    h.settle();
    await vi.advanceTimersByTimeAsync(0);
    // No floor left to wait out — just the hold.
    expect(h.timers).toEqual([LONG_REPLY_HOLD_MS]); // → t = 9500
  });

  it('does not delay a slow response that came back short', async () => {
    const h = pacedHarness(reply(SHORT));
    const p = h.paced('hi');
    await vi.advanceTimersByTimeAsync(7000);
    h.settle();
    await expect(p).resolves.toBeDefined();
    expect(h.timers).toEqual([]);
  });

  it('never holds a failure — it rejects the moment it happens', async () => {
    const h = pacedHarness(reply(LONG));
    const p = h.paced('hi');
    const boom = new Error('boom');
    await vi.advanceTimersByTimeAsync(500);
    h.fail(boom);
    await expect(p).rejects.toBe(boom);
    expect(h.timers).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Against the REAL send controller
 * ------------------------------------------------------------------ */

describe('paced sends through the real chatSend controller', () => {
  function e2e() {
    const states: Array<{ pending: string | null; showTyping: boolean; sending: boolean }> = [];
    const results: SendMessageResult[] = [];
    const errors: unknown[] = [];
    let settle!: (v: SendMessageResult) => void;
    let fail!: (e: unknown) => void;

    const controller = createChatSendController<SendMessageResult>({
      send: createPacedSend<SendMessageResult>({
        send: () =>
          new Promise<SendMessageResult>((res, rej) => {
            settle = res;
            fail = rej;
          }),
      }),
      onState: (s) => states.push({ ...s }),
      onResult: (r) => results.push(r),
      onError: (e) => errors.push(e),
    });

    return {
      controller,
      states,
      results,
      errors,
      settle: (r: SendMessageResult) => settle(r),
      fail: (e: unknown) => fail(e),
      last: () => states[states.length - 1]!,
    };
  }

  it('reveals a short reply at exactly 5s — unchanged from before pacing', async () => {
    const h = e2e();
    void h.controller.send('hi');

    await vi.advanceTimersByTimeAsync(1000);
    h.settle(reply(SHORT));

    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS - 1000 - 1);
    expect(h.results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toHaveLength(1);
    expect(h.last()).toEqual(IDLE_SEND_STATE);
  });

  it('reveals a long reply at 7.5s', async () => {
    const h = e2e();
    void h.controller.send('hi');

    await vi.advanceTimersByTimeAsync(1000);
    h.settle(reply(LONG));

    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS - 1000); // t = 5000
    expect(h.results).toHaveLength(0); // would have revealed here before
    await vi.advanceTimersByTimeAsync(LONG_REPLY_HOLD_MS - 1);
    expect(h.results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toHaveLength(1); // t = 7500
  });

  it('reveals a media reply at 8s', async () => {
    const h = e2e();
    void h.controller.send('send me a picture');

    await vi.advanceTimersByTimeAsync(1000);
    h.settle(reply('Here.', 'image'));

    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS - 1000 + MEDIA_HOLD_MS - 1);
    expect(h.results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toHaveLength(1); // t = 8000
  });

  it('keeps the 2s typing indicator, and keeps it up throughout the hold', async () => {
    const h = e2e();
    void h.controller.send('hi');

    await vi.advanceTimersByTimeAsync(TYPING_INDICATOR_DELAY_MS - 1);
    expect(h.last().showTyping).toBe(false); // not a millisecond early
    await vi.advanceTimersByTimeAsync(1);
    expect(h.last().showTyping).toBe(true);

    h.settle(reply('Here.', 'video'));

    // Still typing at 5s, where it used to reveal, and right up to 8s.
    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS - TYPING_INDICATOR_DELAY_MS);
    expect(h.last().showTyping).toBe(true);
    expect(h.results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(MEDIA_HOLD_MS - 1);
    expect(h.last().showTyping).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.results).toHaveLength(1);
    expect(h.last()).toEqual(IDLE_SEND_STATE);
  });

  it('a slow reply is revealed when it lands, with no floor padding', async () => {
    const h = e2e();
    void h.controller.send('hi');

    await vi.advanceTimersByTimeAsync(7000);
    expect(h.results).toHaveLength(0);
    h.settle(reply(SHORT));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.results).toHaveLength(1); // t = 7000, exactly as before
  });

  it('surfaces a failure immediately — never held by the floor or the hold', async () => {
    const h = e2e();
    void h.controller.send('hi');

    await vi.advanceTimersByTimeAsync(500);
    h.fail(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.errors).toHaveLength(1);
    expect(h.results).toHaveLength(0);
    // The user's words survive so Retry can resend them.
    expect(h.last()).toEqual({ pending: 'hi', showTyping: false, sending: false });
  });

  it('a send superseded DURING its hold can never publish', async () => {
    const h = e2e();
    void h.controller.send('first');

    await vi.advanceTimersByTimeAsync(1000);
    const firstResult = reply(LONG);
    h.settle(firstResult); // will not settle its promise until t = 7500

    // A new send starts while the first is still being held back.
    await vi.advanceTimersByTimeAsync(1000);
    void h.controller.send('second');
    expect(h.last().pending).toBe('second');

    // The first send's hold elapses — and is ignored entirely.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.results).toHaveLength(0);
    expect(h.results).not.toContainEqual(firstResult);

    const secondResult = reply(SHORT);
    h.settle(secondResult);
    await vi.advanceTimersByTimeAsync(REPLY_REVEAL_FLOOR_MS);
    expect(h.results).toEqual([secondResult]);
  });

  it('leaving the screen before the floor publishes nothing at all', async () => {
    const h = e2e();
    void h.controller.send('hi');

    await vi.advanceTimersByTimeAsync(1000);
    h.settle(reply('Here.', 'image')); // held until t = 8000

    h.controller.dispose(); // unmount at t = 1000, before the 5s floor
    await vi.advanceTimersByTimeAsync(20_000);

    // dispose() cleared the floor timer, so floorElapsed never became true and
    // the late result is buffered rather than revealed. Nothing reaches the
    // screen — which is what we want on unmount.
    expect(h.results).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
  });

  it('CHARACTERISES the known post-dispose window (pre-existing, widened by the hold)', async () => {
    const h = e2e();
    void h.controller.send('hi');

    await vi.advanceTimersByTimeAsync(1000);
    h.settle(reply('Here.', 'image')); // held until t = 8000

    // Unmount AFTER the floor has already elapsed.
    await vi.advanceTimersByTimeAsync(5000); // t = 6000, floor passed at 5000
    h.controller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);

    // The in-flight promise still resolves and still reveals. This window
    // already existed for any request slower than 5s; the hold widens it by up
    // to MEDIA_HOLD_MS. Closing it would mean changing chatSend.ts, which is
    // deliberately out of scope — if that ever changes, update this test.
    expect(h.results).toHaveLength(1);
  });
});
