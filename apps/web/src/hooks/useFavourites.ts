import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, favouritesApi, type PublicPlayWithMeCard } from '../lib/api';
import { applyAction, type FavouriteAction } from '../lib/favourites';

export type FavouritesStatus = 'loading' | 'ready' | 'signed-out' | 'error';

export interface FavouritesHook {
  status: FavouritesStatus;
  /**
   * The persisted relationship — every character id this user has saved,
   * whether or not she currently has renderable content. The heart reads this.
   */
  favourited: ReadonlySet<string>;
  /** Gallery cards, as the server composed them. `clip` may be null. */
  cards: PublicPlayWithMeCard[];
  /**
   * Apply an action decided by `swipeAction` / `heartAction`. Resolves to what
   * the server ended up holding, so a caller can report honestly.
   */
  run: (characterId: string, action: FavouriteAction) => Promise<'saved' | 'removed' | 'unchanged' | 'signed-out' | 'failed'>;
  reload: () => void;
}

/**
 * The user's favourites, read from and written to the server.
 *
 * NO LOCAL SOURCE OF TRUTH. There is no localStorage here and no seeded
 * initial state: the set starts empty, is replaced by what `/api/favourites`
 * returns, and every mutation is confirmed against the server. That is what
 * makes a favourite survive a refresh — the page has nothing of its own to
 * survive with.
 *
 * OPTIMISTIC, THEN CORRECTED. The heart flips immediately so the deck feels
 * like a deck, and a failed request rolls the set back to what it was rather
 * than leaving a fill the database does not agree with. The rollback restores
 * the previous set rather than inverting the action, so two overlapping taps
 * cannot leave the UI in a state neither request produced.
 *
 * SIGNED OUT IS A STATE, NOT AN ERROR. A 401 from the list means "no account",
 * which is a perfectly ordinary way to browse Swipe: the deck still works, the
 * heart is simply not something this visitor can use yet. Distinguishing it
 * from a network failure is what lets the page say "sign in to save" instead of
 * "something went wrong".
 */
export function useFavourites(): FavouritesHook {
  const [status, setStatus] = useState<FavouritesStatus>('loading');
  const [favourited, setFavourited] = useState<ReadonlySet<string>>(() => new Set());
  const [cards, setCards] = useState<PublicPlayWithMeCard[]>([]);
  const [attempt, setAttempt] = useState(0);
  // Read inside `run` so a mutation always rolls back to the CURRENT set, not
  // the one captured when the callback was created.
  const favouritedRef = useRef<ReadonlySet<string>>(favourited);
  favouritedRef.current = favourited;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    favouritesApi
      .list()
      .then((res) => {
        if (cancelled) return;
        setFavourited(new Set(res.characterIds));
        setCards(res.favourites);
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setFavourited(new Set());
        setCards([]);
        setStatus(err instanceof ApiRequestError && err.status === 401 ? 'signed-out' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const run = useCallback<FavouritesHook['run']>(async (characterId, action) => {
    // 'none' is a real outcome, not a no-op to be tidied away: it is what a
    // right swipe on an already-saved character produces, and it must reach the
    // server as nothing at all rather than as a toggle.
    if (action === 'none') return 'unchanged';

    const previous = favouritedRef.current;
    setFavourited(applyAction(previous, characterId, action));
    try {
      if (action === 'add') await favouritesApi.add(characterId);
      else await favouritesApi.remove(characterId);
      return action === 'add' ? 'saved' : 'removed';
    } catch (err) {
      setFavourited(previous);
      if (err instanceof ApiRequestError && err.status === 401) {
        setStatus('signed-out');
        return 'signed-out';
      }
      return 'failed';
    }
  }, []);

  return { status, favourited, cards, run, reload };
}
