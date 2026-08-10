import { describe, it, expect } from 'vitest';
import {
  PRIMARY_DESTINATIONS,
  activeDestinationKey,
  matchesDestination,
} from './destinations';

describe('primary navigation destinations', () => {
  it('exposes exactly Discover, Go Steady, and Profile with their routes', () => {
    expect(PRIMARY_DESTINATIONS.map((d) => d.key)).toEqual(['discover', 'go-steady', 'profile']);
    expect(PRIMARY_DESTINATIONS.map((d) => d.path)).toEqual(['/characters', '/go-steady', '/profile']);
    expect(PRIMARY_DESTINATIONS.map((d) => d.label)).toEqual(['Discover', 'Go Steady', 'Profile']);
  });
});

describe('activeDestinationKey', () => {
  it('marks Discover active for the lobby and character subtree', () => {
    expect(activeDestinationKey('/characters')).toBe('discover');
    expect(activeDestinationKey('/characters/abc-123')).toBe('discover');
  });

  it('marks the matching primary destination active', () => {
    expect(activeDestinationKey('/go-steady')).toBe('go-steady');
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
