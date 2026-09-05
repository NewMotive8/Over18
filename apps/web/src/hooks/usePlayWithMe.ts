import { useCallback, useEffect, useState } from 'react';
import { homeApi, type PublicPlayWithMeCard } from '../lib/api';

export type PlayWithMeState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; characters: PublicPlayWithMeCard[] };

/**
 * The Play with me population — the SAME characters Home's rail shows.
 *
 * This replaces `useCharacters` on the Swipe screen. That hook loads
 * `/api/characters`, which is every active character regardless of whether she
 * has published anything; the deck then asked the client to find media for
 * characters the rail had already dropped, and the client obliged with a
 * canonical portrait, a bundled demo clip or a lettered tile. One list, one
 * rule, one server function is the fix.
 *
 * `useCharacters` is untouched, but Swipe was its only caller, so it is now
 * orphaned. It is left in place rather than deleted because it is a correct,
 * general read of the full roster and nothing about it is unsafe — unlike
 * `DiscoverCard`, which was removed because it could reach the placeholder
 * fallback chain. Deleting it is a tidy-up, not part of this change.
 */
export function usePlayWithMe(): { state: PlayWithMeState; reload: () => void } {
  const [state, setState] = useState<PlayWithMeState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    homeApi
      .playWithMe()
      .then((res) => !cancelled && setState({ status: 'ready', characters: res.characters }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { state, reload };
}
