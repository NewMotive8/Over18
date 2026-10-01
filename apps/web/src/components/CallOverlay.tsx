import { IDLE_CALL_STATE, type CallState } from '../lib/voiceCall';

/**
 * The call, as a person sees it.
 *
 * A PURE RENDER OF ONE STATE OBJECT. Every browser concern -- the microphone,
 * the socket, the audio clock -- is behind `createCallController`, so this file
 * holds no effects and no refs and can be static-rendered in the node test
 * environment this repo uses. Changing what the call looks like never risks
 * what the call does.
 *
 * NOTHING THE SERVER SAYS IS SHOWN VERBATIM. `state.message` is always one of
 * our own sentences from `messageForReason`; the relay's slugs and the
 * provider's error codes never reach the screen.
 */

export interface CallOverlayProps {
  state: CallState;
  characterName: string;
  onStart: () => void;
  onHangUp: () => void;
  /** Dismisses the overlay once a call is over. */
  onClose: () => void;
}

/** mm:ss, because 780 seconds means nothing to anybody. */
export function formatRemaining(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

/** The line under the character's name, by phase. */
export function statusLine(state: CallState, characterName: string): string {
  switch (state.phase) {
    case 'permission':
      return 'Allow microphone access to start the call…';
    case 'connecting':
      return `Calling ${characterName}…`;
    case 'active':
      if (state.characterSpeaking) return `${characterName} is speaking…`;
      if (state.userSpeaking) return 'Listening…';
      return 'Connected';
    case 'ending':
      return 'Ending the call…';
    case 'ended':
      return 'Call ended';
    case 'error':
      return 'Call failed';
    case 'idle':
      return `Call ${characterName}`;
  }
}

/**
 * The button that starts a call.
 *
 * Disabled for every phase except the three a call can legitimately start from.
 * The controller refuses a duplicate start anyway, and the server refuses a
 * duplicate claim after that -- but a button that looks pressable and does
 * nothing is its own small lie, so the disabled state is here as well.
 */
export function CallButton({
  state,
  characterName,
  onStart,
}: {
  state: CallState;
  characterName: string;
  onStart: () => void;
}) {
  const busy = state.phase !== 'idle' && state.phase !== 'ended' && state.phase !== 'error';
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={busy}
      aria-label={`Call ${characterName}`}
      className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-rose-500/60 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {busy ? 'On a call' : 'Call'}
    </button>
  );
}

export default function CallOverlay({
  state,
  characterName,
  onStart,
  onHangUp,
  onClose,
}: CallOverlayProps) {
  // Idle is not an overlay: the call button lives in the chat header.
  if (state.phase === 'idle') return null;

  const live = state.phase === 'permission' || state.phase === 'connecting' || state.phase === 'active';
  const over = state.phase === 'ended' || state.phase === 'error';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${characterName}`}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-zinc-950/95 px-6"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-xl font-semibold text-zinc-100">{characterName}</h2>
        <p aria-live="polite" className="text-sm text-zinc-400">
          {statusLine(state, characterName)}
        </p>
        {state.secondsRemaining !== null && state.phase === 'active' && (
          <p className="font-mono text-xs text-zinc-500">
            {formatRemaining(state.secondsRemaining)} left
          </p>
        )}
      </div>

      {/* Speaking indicator. Deliberately not a waveform: this reflects the
          provider's own turn detection, which is the thing that decides whose
          turn it is, rather than a local volume meter that could disagree. */}
      {state.phase === 'active' && (
        <div
          aria-hidden="true"
          className={`h-16 w-16 rounded-full border-2 transition ${
            state.characterSpeaking
              ? 'animate-pulse border-rose-500 bg-rose-500/20'
              : state.userSpeaking
                ? 'border-emerald-500 bg-emerald-500/10'
                : 'border-zinc-700'
          }`}
        />
      )}

      {state.message !== null && (
        <p role="alert" className="max-w-sm text-center text-sm text-amber-300">
          {state.message}
        </p>
      )}

      {state.transcript.length > 0 && (
        <ul className="max-h-48 w-full max-w-sm overflow-y-auto text-sm">
          {state.transcript.slice(-8).map((line, index) => (
            <li
              key={`${index}-${line.speaker}`}
              className={line.speaker === 'character' ? 'text-rose-200' : 'text-zinc-300'}
            >
              <span className="text-xs uppercase tracking-wide text-zinc-600">
                {line.speaker === 'character' ? characterName : 'You'}
              </span>{' '}
              {line.text}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        {live && (
          <button
            type="button"
            onClick={onHangUp}
            className="rounded-full bg-rose-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500"
          >
            End call
          </button>
        )}
        {over && (
          <>
            <button
              type="button"
              onClick={onStart}
              className="rounded-full border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-200 transition hover:border-rose-500/60"
            >
              Call again
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-5 py-2.5 text-sm text-zinc-400 transition hover:text-zinc-200"
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Exported for the chat page's initial state, so it need not import both. */
export { IDLE_CALL_STATE };
