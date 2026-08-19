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
 *  2. The request starts immediately. The 2s delay gates ONLY the typing
 *     indicator — it never delays the network call.
 *  3. A response that arrives before the timer fires cancels it, so a fast
 *     reply never flashes a typing indicator after the fact.
 *  4. Resolve, reject and cancel all clear the timer. There is exactly one
 *     live timer at a time; starting a send clears any previous one.
 *  5. The optimistic message is held OUTSIDE the persisted list, so when the
 *     server's canonical user message arrives it replaces rather than
 *     duplicates it.
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

export interface ChatSendControllerOptions<TResult> {
  /** Performs the actual request. Called immediately, never delayed. */
  send: (content: string) => Promise<TResult>;
  /** Receives every state transition. */
  onState: (state: ChatSendState) => void;
  /** Called once the request succeeds, with the server's result. */
  onResult: (result: TResult) => void;
  /** Called when the request fails. The pending message stays visible. */
  onError: (error: unknown) => void;
  delayMs?: number;
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
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: ChatSendState = { ...IDLE_SEND_STATE };
  /** Guards against a superseded send writing state after a newer one began. */
  let generation = 0;

  function publish(next: Partial<ChatSendState>): void {
    state = { ...state, ...next };
    options.onState(state);
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  async function send(content: string): Promise<void> {
    const mine = ++generation;
    stopTimer(); // a new send must never inherit the previous send's timer

    // Synchronous: the bubble is on screen and the composer is empty before
    // the request is even constructed.
    publish({ pending: content, showTyping: false, sending: true });

    timer = setTimer(() => {
      timer = null;
      if (mine !== generation) return; // superseded — stale timer, ignore
      publish({ showTyping: true });
    }, delayMs);

    try {
      const result = await options.send(content);
      if (mine !== generation) return; // a newer send owns the UI now
      stopTimer();
      publish({ pending: null, showTyping: false, sending: false });
      options.onResult(result);
    } catch (error) {
      if (mine !== generation) return;
      stopTimer();
      // pending stays: the user's words must survive a failure so Retry can
      // resend them. Only the typing indicator goes.
      publish({ showTyping: false, sending: false });
      options.onError(error);
    }
  }

  return {
    send,
    dispose: stopTimer,
    clearPending: () => publish({ pending: null }),
  };
}
