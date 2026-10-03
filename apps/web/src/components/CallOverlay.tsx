import { IDLE_CALL_STATE, type CallState } from '../lib/voiceCall';
import { PhoneIcon } from './icons';

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
  /** Her portrait, full screen behind the call; a dark screen without one. */
  characterImage?: string | null;
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
  characterImage = null,
  onStart,
  onHangUp,
  onClose,
}: CallOverlayProps) {
  // Idle is not an overlay: the call button lives in the chat header.
  if (state.phase === 'idle') return null;

  const live = state.phase === 'permission' || state.phase === 'connecting' || state.phase === 'active';
  const over = state.phase === 'ended' || state.phase === 'error';
  const round = 'flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full text-white shadow-lg transition';

  // A phone's call screen: her portrait fills it, her name and the status sit
  // at the top, and the only control while the call is live is the red button.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${characterName}`}
      data-testid="call-screen"
      className="fixed inset-0 z-50 flex justify-center bg-black"
    >
      {/* Phone-shaped on a wide screen, full bleed on a phone. */}
      <div className="relative h-full w-full max-w-md overflow-hidden bg-gradient-to-b from-zinc-800 to-zinc-950">
        {characterImage && (
          <img
            src={characterImage}
            alt=""
            aria-hidden
            data-testid="call-portrait"
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        )}
        {/* Legibility: darker at the top for the name, at the bottom for the button. */}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent via-35% to-black/70" />

        <div className="relative flex h-full flex-col items-center justify-between px-6 pb-[max(env(safe-area-inset-bottom),3rem)] pt-[max(env(safe-area-inset-top),3.5rem)] text-center">
          <div className="flex flex-col items-center gap-1.5">
            <h2 className="text-3xl font-semibold text-white drop-shadow-md">{characterName}</h2>
            {/* Who is speaking comes from the provider's own turn detection, in words. */}
            <p aria-live="polite" className="text-sm text-white/85 drop-shadow">
              {statusLine(state, characterName)}
            </p>
            {state.secondsRemaining !== null && state.phase === 'active' && (
              <p className="font-mono text-xs text-white/70 drop-shadow">
                {formatRemaining(state.secondsRemaining)} left
              </p>
            )}
          </div>

          <div className="flex flex-col items-center gap-5">
            {state.message !== null && (
              <p role="alert" className="max-w-sm rounded-xl bg-black/55 px-4 py-2 text-sm text-amber-300 backdrop-blur">
                {state.message}
              </p>
            )}

            {live && (
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={onHangUp}
                  aria-label="End call"
                  data-testid="call-end"
                  className={`${round} bg-red-600 hover:bg-red-500`}
                >
                  <PhoneIcon className="h-8 w-8 rotate-[135deg]" />
                </button>
                <span aria-hidden className="text-sm font-medium text-white drop-shadow">End call</span>
              </div>
            )}

            {over && (
              <div className="flex items-start gap-16">
                <div className="flex flex-col items-center gap-2">
                  <button type="button" onClick={onClose} aria-label="Close" className={`${round} bg-zinc-700/80 backdrop-blur hover:bg-zinc-600`}>
                    <span aria-hidden className="text-3xl leading-none">&times;</span>
                  </button>
                  <span aria-hidden className="text-sm font-medium text-white drop-shadow">Close</span>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <button type="button" onClick={onStart} aria-label="Call again" className={`${round} bg-emerald-500 hover:bg-emerald-400`}>
                    <PhoneIcon className="h-8 w-8" />
                  </button>
                  <span aria-hidden className="text-sm font-medium text-white drop-shadow">Call again</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Exported for the chat page's initial state, so it need not import both. */
export { IDLE_CALL_STATE };
