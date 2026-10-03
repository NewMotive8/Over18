import { useCallback, useEffect, useState } from 'react';
import { commercialTier, useCustomerEconomy, type CustomerEconomyState } from './customerEconomy';

/**
 * THE FREE-CHARACTER ALLOWANCE (Premium feed gate).
 *
 * A Free customer meets up to FREE_CHARACTER_LIMIT different characters on a
 * surface (Home's companion feed, Swipe Mode); trying to continue to the next
 * NEW one opens the Premium funnel. Characters already met stay open -- the
 * allowance is "ten characters", not "ten cards".
 *
 * WHAT COUNTS. No view tracking existed on either surface, so the unit is the
 * one each surface already has: Swipe's current card, and the character behind
 * a clip shown in Home's feed. A character is counted once, by id, in a SET --
 * re-renders, navigation, remounts and refreshes add nothing.
 *
 * WHO IS GATED. Only a signed-in customer the server says is on the Free tier.
 * Premium is never gated; nor is anyone while the tier is unknown (loading,
 * signed out, economy off), because a gate that might be wrong must not block.
 *
 * WHAT IT IS NOT. A conversion moment, not an entitlement: the allowance lives
 * in this browser (per customer, per surface). Premium content stays protected
 * by the server's own rules, exactly as before.
 */

export const FREE_CHARACTER_LIMIT = 10;

export type GateSurface = 'home_feed' | 'swipe';

/** Whether a character may be shown: already met, or there is room for one more. */
export function canMeet(seen: ReadonlySet<string>, characterId: string, limit = FREE_CHARACTER_LIMIT): boolean {
  return seen.has(characterId) || seen.size < limit;
}

/** `seen` plus whichever of `ids` still fit, in order. Returns the SAME set when nothing changes. */
export function admit(seen: ReadonlySet<string>, ids: readonly string[], limit = FREE_CHARACTER_LIMIT): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of ids) {
    const current = next ?? seen;
    if (current.has(id) || current.size >= limit) continue;
    next ??= new Set(seen);
    next.add(id);
  }
  return next ?? seen;
}

/**
 * Home's feed under the allowance: clips in feed order, up to the first clip
 * of a character beyond it. `admitted` are the new characters this window
 * shows (to be remembered); `gated` says there is more behind the gate.
 */
export function feedWindow<T extends { characterId: string }>(
  clips: readonly T[],
  seen: ReadonlySet<string>,
  limit = FREE_CHARACTER_LIMIT,
): { visible: T[]; admitted: string[]; gated: boolean } {
  const allowed = new Set(seen);
  const admitted: string[] = [];
  const visible: T[] = [];
  for (const clip of clips) {
    if (!allowed.has(clip.characterId)) {
      if (allowed.size >= limit) return { visible, admitted, gated: true };
      allowed.add(clip.characterId);
      admitted.push(clip.characterId);
    }
    visible.push(clip);
  }
  return { visible, admitted, gated: false };
}

/* ------------------------------------------------------------------ *
 * Remembered per customer and per surface, in this browser
 * ------------------------------------------------------------------ */

const KEY = (surface: GateSurface, userId: string) => `over18.premiumGate.${surface}.${userId}`;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metCharacters = {
  read(surface: GateSurface, userId: string): string[] {
    try {
      const value: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY(surface, userId)) ?? '[]');
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && ID.test(id)).slice(0, FREE_CHARACTER_LIMIT) : [];
    } catch {
      return [];
    }
  },
  write(surface: GateSurface, userId: string, ids: Iterable<string>): void {
    try {
      globalThis.localStorage?.setItem(KEY(surface, userId), JSON.stringify([...ids].slice(0, FREE_CHARACTER_LIMIT)));
    } catch {
      /* storage refused (private mode, quota): the gate simply restarts its count */
    }
  },
};

export interface PremiumGate {
  /** True only for a signed-in Free customer whose allowance has been read. */
  enforced: boolean;
  /** Not yet known whether the gate applies: the surface should wait rather than show too much. */
  pending: boolean;
  /** The characters already met on this surface. */
  seen: ReadonlySet<string>;
  /** Remember characters as met (only those that fit; never twice). */
  record(ids: readonly string[]): void;
}

/**
 * Who the gate applies to, from the customer-economy state: a signed-in
 * customer the server says is on the Free tier, once their allowance is read.
 * Premium, signed out, economy off or failing: never gated. Still loading, or
 * Free with the allowance not yet read: pending (the surface waits).
 */
export function gateStatus(
  economy: CustomerEconomyState,
  loadedFor: string | null,
): { free: boolean; userId: string | null; enforced: boolean; pending: boolean } {
  const overview = economy.status === 'ready' ? economy.overview : null;
  const free = commercialTier(overview) === 'free';
  const userId = overview?.commercial?.viewer?.userId ?? null;
  const enforced = free && userId !== null && loadedFor === userId;
  const pending = economy.status === 'loading' || (free && userId !== null && !enforced);
  return { free, userId, enforced, pending };
}

export function usePremiumGate(surface: GateSurface): PremiumGate {
  const [economy] = useCustomerEconomy();
  const [loaded, setLoaded] = useState<{ userId: string; seen: ReadonlySet<string> } | null>(null);
  const { free, userId, enforced, pending } = gateStatus(economy, loaded?.userId ?? null);

  useEffect(() => {
    if (!free || !userId) return;
    setLoaded({ userId, seen: new Set(metCharacters.read(surface, userId)) });
  }, [free, userId, surface]);

  const record = useCallback(
    (ids: readonly string[]) => {
      setLoaded((current) => {
        if (!current) return current;
        const next = admit(current.seen, ids);
        if (next === current.seen) return current;
        metCharacters.write(surface, current.userId, next);
        return { userId: current.userId, seen: next };
      });
    },
    [surface],
  );

  return { enforced, pending, seen: enforced ? loaded!.seen : EMPTY, record };
}

const EMPTY: ReadonlySet<string> = new Set();
