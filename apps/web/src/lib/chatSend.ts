/**
 * Send lifecycle for the chat composer.
 *
 * Extracted from ChatPage as a plain state machine with no React and no DOM,
 * because the timing rules are the part that actually breaks: a typing
 * indicator that outlives its request, a timer from send #1 firing during
 * send #2, an indicator left spinning after an error. Those are all
 * unobservable in a static render, and the repo's web tests are node-only
 * (`react-dom/server`, effects never run). As a plain module it is directly
 * testable with fake timers.
 *
 * The rules, in one place:
 *
 *  1. The optimistic user message is published SYNCHRONOUSLY on send, before
 *     the request is awaited. The composer clears at the same moment.
 *  2. The request starts immediately. NEITHER delay below ever gates the
 *     network call — they gate only what is on screen.
 *  3. At 2s the typing indicator appears, if the reply has not been revealed.
 *  4. The reply is never revealed before 5s from send. A reply that arrives
 *     earlier is BUFFERED and revealed at the 5s mark; a reply that arrives
 *     later is revealed the moment it lands. So the pacing is
 *     reveal = max(5s, response time), which keeps a fast model from feeling
 *     mechanical.
 *  5. Both timers are cleared on reveal, on failure, and on dispose. Starting
 *     a send clears any previous send's timers, and a superseded send can
 *     neither fire a timer nor publish state.
 *  6. The optimistic message is held OUTSIDE the persisted list, so when the
 *     server's canonical user message arrives it replaces rather than
 *     duplicates it.
 *
 * A failure is surfaced immediately and is NOT held back to 5s: an error is
 * not a reply, and making someone wait to be told it broke helps nobody.
 */

export interface ChatSendState {
  /** The user's message, shown optimistically. Null when nothing is in flight. */
  pending: string | null;
  /** True once the delay has elapsed and the reply is still outstanding. */
  showTyping: boolean;
  /** True from send until the request settles. Drives composer disabling. */
  sending: boolean;
}

export const IDLE_SEND_STATE: ChatSendState = {
  pending: null,
  showTyping: false,
  sending: false,
};

/** Milliseconds the user's own message is alone on screen before "typing…". */
export const TYPING_INDICATOR_DELAY_MS = 2000;

/**
 * Minimum milliseconds from send to the reply appearing. A reply that arrives
 * sooner waits here; one that arrives later is not delayed at all.
 */
export const REPLY_REVEAL_FLOOR_MS = 5000;

export interface ChatSendControllerOptions<TResult> {
  /** Performs the actual request. Called immediately, never delayed. */
  send: (content: string) => Promise<TResult>;
  /** Receives every state transition. */
  onState: (state: ChatSendState) => void;
  /** Called once the request succeeds, with the server's result. */
  onResult: (result: TResult) => void;
  /** Called when the request fails. The pending message stays visible. */
  onError: (error: unknown) => void;
  /** Typing-indicator delay. Defaults to TYPING_INDICATOR_DELAY_MS. */
  delayMs?: number;
  /** Earliest the reply may be revealed. Defaults to REPLY_REVEAL_FLOOR_MS. */
  revealFloorMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ChatSendController {
  /** Starts a send. Returns a promise that settles when the request does. */
  send: (content: string) => Promise<void>;
  /** Clears any live timer. Call on unmount. Safe to call repeatedly. */
  dispose: () => void;
  /** Drops the optimistic message — used after a failure is dismissed. */
  clearPending: () => void;
}

export function createChatSendController<TResult>(
  options: ChatSendControllerOptions<TResult>,
): ChatSendController {
  const delayMs = options.delayMs ?? TYPING_INDICATOR_DELAY_MS;
  const revealFloorMs = options.revealFloorMs ?? REPLY_REVEAL_FLOOR_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));

  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let floorTimer: ReturnType<typeof setTimeout> | null = null;
  let state: ChatSendState = { ...IDLE_SEND_STATE };
  /** Guards against a superseded send writing state after a newer one began. */
  let generation = 0;
  /** True once the 5s floor has elapsed for the current send. */
  let floorElapsed = false;
  /** A reply that arrived before the floor, waiting to be revealed. */
  let buffered: { result: TResult } | null = null;

  function publish(next: Partial<ChatSendState>): void {
    state = { ...state, ...next };
    options.onState(state);
  }

  function stopTimers(): void {
    if (typingTimer !== null) {
      clearTimer(typingTimer);
      typingTimer = null;
    }
    if (floorTimer !== null) {
      clearTimer(floorTimer);
      floorTimer = null;
    }
  }

  /** Publishes the reply and returns to idle. The only path that reveals. */
  function reveal(result: TResult): void {
    stopTimers();
    buffered = null;
    publish({ pending: null, showTyping: false, sending: false });
    options.onResult(result);
  }

  async function send(content: string): Promise<void> {
    const mine = ++generation;
    stopTimers(); // a new send must never inherit the previous send's timers
    floorElapsed = false;
    buffered = null;

    // Synchronous: the bubble is on screen and the composer is empty before
    // the request is even constructed.
    publish({ pending: content, showTyping: false, sending: true });

    typingTimer = setTimer(() => {
      typingTimer = null;
      if (mine !== generation) return; // superseded — stale timer, ignore
      // Deliberately fires even when a reply is already buffered: the reply is
      // not on screen yet, so the indicator is what should be showing.
      publish({ showTyping: true });
    }, delayMs);

    floorTimer = setTimer(() => {
      floorTimer = null;
      if (mine !== generation) return;
      floorElapsed = true;
      if (buffered) reveal(buffered.result);
    }, revealFloorMs);

    try {
      const result = await options.send(content);
      if (mine !== generation) return; // a newer send owns the UI now
      if (floorElapsed) reveal(result);
      else buffered = { result }; // hold it; the floor timer will reveal it
    } catch (error) {
      if (mine !== generation) return;
      // Failures are NOT floored — see the header note.
      stopTimers();
      // pending stays: the user's words must survive a failure so Retry can
      // resend them. Only the typing indicator goes.
      publish({ showTyping: false, sending: false });
      options.onError(error);
    }
  }

  return {
    send,
    dispose: stopTimers,
    clearPending: () => publish({ pending: null }),
  };
}
