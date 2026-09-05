import { describe, it, expect } from 'vitest';
import {
  PRIMARY_DESTINATIONS,
  activeDestinationKey,
  matchesDestination,
} from './destinations';

describe('primary navigation destinations', () => {
  it('exposes exactly Discover, Go Steady, Favourites and Profile with their routes', () => {
    expect(PRIMARY_DESTINATIONS.map((d) => d.key)).toEqual([
      'discover',
      'go-steady',
      'favourites',
      'profile',
    ]);
    expect(PRIMARY_DESTINATIONS.map((d) => d.path)).toEqual([
      '/characters',
      '/go-steady',
      '/favourites',
      '/profile',
    ]);
    expect(PRIMARY_DESTINATIONS.map((d) => d.label)).toEqual([
      'Discover',
      'Go Steady',
      'Favourites',
      'Profile',
    ]);
  });

  /**
   * The bar order is the requirement, not an accident of the array: Favourites
   * goes BETWEEN Get Steady and Profile, and Profile keeps the edge. Asserting
   * the neighbours rather than only the set is what would catch an append.
   */
  it('places Favourites between Go Steady and Profile', () => {
    const keys = PRIMARY_DESTINATIONS.map((d) => d.key);
    expect(keys.indexOf('favourites')).toBe(keys.indexOf('go-steady') + 1);
    expect(keys.indexOf('profile')).toBe(keys.indexOf('favourites') + 1);
  });

  /** The three pre-existing destinations are unchanged by the addition. */
  it('leaves the existing destinations intact', () => {
    const byKey = new Map(PRIMARY_DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.get('discover')!.path).toBe('/characters');
    expect(byKey.get('go-steady')!.path).toBe('/go-steady');
    expect(byKey.get('profile')!.path).toBe('/profile');
  });
});

describe('activeDestinationKey', () => {
  it('marks Discover active for the lobby and character subtree', () => {
    expect(activeDestinationKey('/characters')).toBe('discover');
    expect(activeDestinationKey('/characters/abc-123')).toBe('discover');
  });

  it('marks the matching primary destination active', () => {
    expect(activeDestinationKey('/go-steady')).toBe('go-steady');
    expect(activeDestinationKey('/favourites')).toBe('favourites');
    expect(activeDestinationKey('/profile')).toBe('profile');
  });

  it('returns null for routes outside the primary destinations (no mis-highlight)', () => {
    expect(activeDestinationKey('/subscription')).toBeNull();
    expect(activeDestinationKey('/chat/1')).toBeNull();
    expect(activeDestinationKey('/login')).toBeNull();
    expect(activeDestinationKey('/totally-unknown')).toBeNull();
  });

  it('does not match a sibling that merely shares a prefix string', () => {
    const discover = PRIMARY_DESTINATIONS[0]!;
    expect(matchesDestination('/characters-archive', discover)).toBe(false);
  });
});
