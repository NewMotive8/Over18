import { useCallback, useEffect, useState } from 'react';
import type { PublicCharacter } from '@over18/shared';
import { charactersApi } from '../lib/api';

export type CharactersState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; characters: PublicCharacter[] };

/**
 * Loads the character list from the API (single fetch path — no duplicated
 * fetch logic in components) and exposes a `reload` for the Retry action.
 * Plain hook + local state: view logic stays portable to React Native.
 */
export function useCharacters(): { state: CharactersState; reload: () => void } {
  const [state, setState] = useState<CharactersState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    charactersApi
      .list()
      .then((characters) => !cancelled && setState({ status: 'ready', characters }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { state, reload };
}
