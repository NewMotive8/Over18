import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IDLE_CALL_STATE,
  createCallController,
  type CallController,
  type CallState,
} from '../lib/voiceCall';
import { createBrowserCallAudio, openRelaySocket } from '../lib/voiceCallAudio';

/**
 * Owns one call's lifetime for one conversation.
 *
 * ── WHY THE CONTROLLER IS BUILT LAZILY ───────────────────────────────────────
 *
 * Creating it on mount would create an AudioContext for every chat page anyone
 * opens, and browsers limit how many a tab may have. It is built on the first
 * press and torn down when the call is over, so a person who never calls pays
 * nothing.
 *
 * ── THE CLEANUP IS THE POINT ─────────────────────────────────────────────────
 *
 * The effect's teardown disposes the controller on unmount AND whenever the
 * conversation changes, which is what navigating between chats does. Without
 * that, walking away from a call would leave the microphone open and the socket
 * connected while a different character's chat was on screen.
 */
export function useVoiceCall(conversationId: string) {
  const [state, setState] = useState<CallState>(IDLE_CALL_STATE);
  const controllerRef = useRef<CallController | null>(null);
  /**
   * Guards a state update after unmount. The controller's own `dispose` emits
   * nothing, but a reply already in flight from the relay can still land between
   * the last frame and teardown.
   */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const controller = controllerRef.current;
      controllerRef.current = null;
      // Fire and forget: a React cleanup cannot await, and the work -- stopping
      // tracks, closing the socket, ending the call -- does not need the
      // component to still exist.
      void controller?.dispose();
    };
  }, [conversationId]);

  const start = useCallback(() => {
    if (controllerRef.current === null) {
      controllerRef.current = createCallController({
        conversationId,
        audio: createBrowserCallAudio(),
        openSocket: openRelaySocket,
        onState: (next) => {
          if (mountedRef.current) setState(next);
        },
      });
    }
    // The controller returns the in-flight promise for a repeat press, so a
    // double-click cannot claim a second call.
    void controllerRef.current.start();
  }, [conversationId]);

  const hangUp = useCallback(() => {
    void controllerRef.current?.hangUp();
  }, []);

  /**
   * Dismisses a finished call and discards its controller.
   *
   * A fresh controller per call, on purpose: the next one gets a new
   * AudioContext rather than reusing one whose clock has been running since the
   * last call, which is what made playback scheduling drift.
   */
  const close = useCallback(() => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    void controller?.dispose();
    setState(IDLE_CALL_STATE);
  }, []);

  return { state, start, hangUp, close };
}
