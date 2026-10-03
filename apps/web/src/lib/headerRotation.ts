import { useEffect, useMemo, useState } from 'react';
import { homeApi, type PublicClip, type PublicPlayWithMeCard } from './api';

/**
 * THE ROTATING HEADER (Credits Store hero, Premium funnel offer).
 *
 * Six characters' clips play one after another -- 1, 2 ... 6, then 1 again --
 * picked at random ONCE PER BROWSER SESSION, so both headers show the same six
 * until the tab is closed.
 *
 * WHERE THEY COME FROM. The "Play with me" characters (`/api/play-with-me`):
 * the same public list Home renders, filtered server-side so nothing explicit
 * ever reaches it. Only characters with a VIDEO clip are eligible.
 */

export const HEADER_ROTATION_SIZE = 6;
const KEY = 'over18.headerRotation';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The characters a header may show: those with a video clip. */
function eligible(cards: readonly PublicPlayWithMeCard[]): PublicPlayWithMeCard[] {
  return cards.filter((card) => card.clip?.mediaType === 'video');
}

/**
 * The six for this session: the remembered ones while they are all still
 * eligible, otherwise a fresh random six (fewer when fewer exist). Pure --
 * `random` is injectable so the choice can be tested.
 */
export function pickRotation(
  cards: readonly PublicPlayWithMeCard[],
  remembered: readonly string[] | null,
  random: () => number = Math.random,
  size = HEADER_ROTATION_SIZE,
): string[] {
  const pool = eligible(cards);
  const ids = new Set(pool.map((card) => card.id));
  const want = Math.min(size, pool.length);
  if (remembered && remembered.length === want && new Set(remembered).size === want && remembered.every((id) => ids.has(id))) {
    return [...remembered];
  }
  // Fisher-Yates over the eligible ids, then the first `want`.
  const shuffled = pool.map((card) => card.id);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, want);
}

/** After the last, the first: 1 -> 2 ... -> n -> 1. */
export function nextIndex(index: number, count: number): number {
  return count <= 0 ? 0 : (index + 1) % count;
}

/** The chosen ids for this session, in this browser tab. */
export const sessionRotation = {
  read(): string[] | null {
    try {
      const value: unknown = JSON.parse(globalThis.sessionStorage?.getItem(KEY) ?? 'null');
      return Array.isArray(value) && value.every((id) => typeof id === 'string' && ID.test(id)) ? (value as string[]) : null;
    } catch {
      return null;
    }
  },
  write(ids: readonly string[]): void {
    try {
      globalThis.sessionStorage?.setItem(KEY, JSON.stringify(ids));
    } catch {
      /* storage refused: the next page simply picks again */
    }
  },
};

/**
 * The session's six clips, in rotation order; empty while loading or if none
 * are available. Nothing is fetched until `enabled` is first true (a funnel
 * that never opens costs nothing).
 */
export function useHeaderRotation(enabled = true): PublicClip[] {
  const [cards, setCards] = useState<PublicPlayWithMeCard[] | null>(null);
  useEffect(() => {
    if (!enabled || cards !== null) return;
    let cancelled = false;
    homeApi
      .playWithMe()
      .then((res) => !cancelled && setCards(res.characters))
      .catch(() => !cancelled && setCards([]));
    return () => {
      cancelled = true;
    };
  }, [enabled, cards]);

  return useMemo(() => {
    if (!cards) return [];
    const ids = pickRotation(cards, sessionRotation.read());
    sessionRotation.write(ids);
    const byId = new Map(cards.map((card) => [card.id, card.clip]));
    return ids.map((id) => byId.get(id)).filter((clip): clip is PublicClip => clip != null);
  }, [cards]);
}
