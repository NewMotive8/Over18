import type { SendMessageResult } from '@over18/shared';
import { REPLY_REVEAL_FLOOR_MS } from './chatSend';

/**
 * Reply pacing: how long a reply is held back BEYOND the existing reveal floor.
 *
 * WHY THIS IS NOT IN chatSend.ts. The send controller already owns a complete,
 * well-tested timing contract — the 2s typing indicator, the 5s reveal floor,
 * per-send timer cancellation, and the generation guard that stops a superseded
 * send publishing anything. None of that needs to change, and all of it is the
 * part that breaks when touched. What we actually want is for a reply to take
 * slightly longer to arrive, which is indistinguishable, from the controller's
 * point of view, from the request itself having taken slightly longer.
 *
 * So this module wraps the SEND FUNCTION rather than the controller. The
 * controller's rule is untouched:
 *
 *     reveal = max(5s, time the send promise took to settle)
 *
 * and by making the promise settle later we get the intended rule for free:
 *
 *     reveal = max(5s, actual response time) + hold
 *
 * The network request still starts immediately and is never gated — the hold
 * happens strictly AFTER the response has landed. The typing indicator is
 * already on screen by 2s and simply stays up through the hold, which is the
 * whole point: the extra time reads as the character composing (or taking the
 * photo), not as lag.
 *
 * FAILURES ARE NEVER HELD. Only a resolved send waits. An error propagates the
 * instant it happens, exactly as before — an error is not a reply.
 *
 * KNOWN WINDOW (pre-existing, slightly widened). Leaving the chat mid-send
 * already allows a response to land after the screen is gone; the hold extends
 * that window by up to MEDIA_HOLD_MS. The controller's generation guard still
 * prevents a SUPERSEDED send from publishing, which is the correctness-relevant
 * case. Cancellation on unmount would need a change to the controller, which is
 * deliberately out of scope here.
 */

/**
 * A reply at or below this length is treated as a quick one-liner and is not
 * slowed down at all. Anything longer plausibly took a moment to type.
 */
export const SHORT_REPLY_MAX_CHARS = 70;

/** Extra hold for a reply longer than SHORT_REPLY_MAX_CHARS. */
export const LONG_REPLY_HOLD_MS = 2500;

/**
 * Minimum extra hold when the reply carries an image or a video, so sending
 * media reads as a deliberate act rather than an instant reflex.
 */
export const MEDIA_HOLD_MS = 3000;

/**
 * How much longer this reply should be held back.
 *
 * Media takes the LARGER of the two holds, never the sum: a video with a
 * chatty caption is one deliberate act, not two, and +5.5s would read as a
 * stall rather than as intent.
 */
export function replyHoldMs(result: SendMessageResult): number {
  const reply = result.characterMessage;
  const textHold = reply.content.length > SHORT_REPLY_MAX_CHARS ? LONG_REPLY_HOLD_MS : 0;
  return reply.media ? Math.max(textHold, MEDIA_HOLD_MS) : textHold;
}

export interface PacedSendOptions<TResult> {
  /** The real request. Called immediately; the hold only ever follows it. */
  send: (content: string) => Promise<TResult>;
  /** Hold policy. Defaults to replyHoldMs. */
  holdMsFor?: (result: TResult) => number;
  /** The controller's reveal floor. Injected only so tests can shorten it. */
  floorMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

/**
 * Wraps a send function so its promise settles at
 * `max(floorMs, elapsed) + hold` instead of at `elapsed`.
 *
 * When the hold is zero — every short, media-free reply — it returns without
 * scheduling anything at all, so the quick path is byte-for-byte the behaviour
 * that shipped: the controller buffers the result and its own floor timer
 * reveals it at 5s, exactly as it does today.
 */
export function createPacedSend<TResult>(
  options: PacedSendOptions<TResult>,
): (content: string) => Promise<TResult> {
  const holdMsFor = options.holdMsFor ?? (replyHoldMs as unknown as (r: TResult) => number);
  const floorMs = options.floorMs ?? REPLY_REVEAL_FLOOR_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));

  return async (content: string): Promise<TResult> => {
    const startedAt = now();
    // Not wrapped in try/catch on purpose: a rejection must pass straight
    // through, unheld and unmodified.
    const result = await options.send(content);

    const hold = holdMsFor(result);
    if (hold <= 0) return result; // untouched fast path

    const elapsed = now() - startedAt;
    // Wait out whatever remains of the floor, then the hold on top of it.
    const wait = Math.max(floorMs - elapsed, 0) + hold;
    await new Promise<void>((resolve) => setTimer(() => resolve(), wait));
    return result;
  };
}
