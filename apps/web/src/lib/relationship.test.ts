import { describe, it, expect } from 'vitest';
import type { PublicCharacter } from '@over18/shared';
import { RELATIONSHIP_TIERS, mockRelationship } from './relationship';

function character(id: string): PublicCharacter {
  return {
    id,
    name: 'x',
    displayName: 'X',
    profileImage: null,
    shortBio: '',
    personality: '',
    interests: [],
    conversationStyle: '',
  };
}

describe('mockRelationship', () => {
  it('is deterministic per character', () => {
    const a = mockRelationship(character('abc-123'));
    const b = mockRelationship(character('abc-123'));
    expect(a).toEqual(b);
  });

  it('always leaves a locked next tier and a valid in-tier progress', () => {
    for (const id of ['a', 'bb', 'ccc', '5f0c6b10-0000-4000-8000-000000000001']) {
      const rel = mockRelationship(character(id));
      expect(rel.tierIndex).toBeGreaterThanOrEqual(0);
      expect(rel.tierIndex).toBeLessThanOrEqual(2);
      expect(rel.current).toBe(RELATIONSHIP_TIERS[rel.tierIndex]);
      expect(rel.next).toBeDefined(); // a locked next tier always exists
      expect(rel.progress).toBeGreaterThan(0);
      expect(rel.progress).toBeLessThanOrEqual(0.95);
    }
  });
});
