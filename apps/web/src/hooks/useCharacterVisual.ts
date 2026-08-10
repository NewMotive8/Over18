import { useEffect, useState } from 'react';
import type { CharacterVisualIdentityResponse } from '@over18/shared';
import { charactersApi } from '../lib/api';

/**
 * Loads a character's public visual identity (US-16B) for the Discover card.
 *
 * Results are cached per character id for the session so swiping back and forth
 * through the deck doesn't refetch. Visual identity is an ENHANCEMENT: any
 * failure resolves to `null` and the card falls back to `profileImage` — it
 * must never break discovery.
 */
const cache = new Map<string, CharacterVisualIdentityResponse | null>();

export function useCharacterVisual(characterId: string): {
  visual: CharacterVisualIdentityResponse | null;
  loading: boolean;
} {
  const [visual, setVisual] = useState<CharacterVisualIdentityResponse | null>(
    () => cache.get(characterId) ?? null,
  );
  const [loading, setLoading] = useState<boolean>(() => !cache.has(characterId));

  useEffect(() => {
    if (cache.has(characterId)) {
      setVisual(cache.get(characterId) ?? null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    charactersApi
      .visualIdentity(characterId)
      .then((data) => {
        cache.set(characterId, data);
        if (!cancelled) {
          setVisual(data);
          setLoading(false);
        }
      })
      .catch(() => {
        cache.set(characterId, null);
        if (!cancelled) {
          setVisual(null);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [characterId]);

  return { visual, loading };
}
