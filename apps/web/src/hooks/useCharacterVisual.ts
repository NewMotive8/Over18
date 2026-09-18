import { useEffect, useState } from 'react';
import type { CharacterVisualIdentityResponse } from '@over18/shared';
import { charactersApi } from '../lib/api';

/**
 * Loads a character's public visual identity (US-16B) for the Discover card.
 *
 * Results are cached per character id for the session so swiping back and forth
 * through the deck doesn't refetch. Visual identity is an ENHANCEMENT: any
 * failure resolves to `null` and the card falls back to the portrait the
 * character payload already carries — it must never break discovery.
 *
 * P0.2: that fallback is no longer a legacy column read by the client. The
 * server resolves `profileImage` from the same canonical reference this hook
 * fetches, so a failed request costs the card its Visual DNA, never its
 * picture.
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
    // No id (e.g. a non-persona hero slide) → nothing to load, no request.
    if (!characterId) {
      setVisual(null);
      setLoading(false);
      return;
    }

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
