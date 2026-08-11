import type { PublicCharacter } from '@over18/shared';

/**
 * Relationship progression model (US-29) — deterministic mock.
 *
 * The backend has no relationship system (that's the future "Go Steady" work,
 * explicitly out of scope). To render the brief's Relationship Tracker without
 * inventing a backend, this derives a STABLE per-character tier + progress from
 * the character id, so the profile always shows a current tier, in-tier
 * progress, and a next locked tier. Clearly UI-only.
 */
export interface RelationshipTier {
  key: string;
  label: string;
}

export const RELATIONSHIP_TIERS: RelationshipTier[] = [
  { key: 'new', label: 'New' },
  { key: 'flirty', label: 'Flirty' },
  { key: 'close', label: 'Close' },
  { key: 'steady', label: 'Going Steady' },
  { key: 'devoted', label: 'Devoted' },
];

export interface RelationshipState {
  tierIndex: number;
  /** 0..1 progress within the current tier. */
  progress: number;
  current: RelationshipTier;
  /** The next, still-locked tier (undefined only at the max tier). */
  next?: RelationshipTier;
}

export function mockRelationship(character: PublicCharacter): RelationshipState {
  const seed = Array.from(character.id).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  // Land somewhere in the first three tiers so there is always a locked next one.
  const tierIndex = seed % 3;
  const progress = 0.25 + (seed % 60) / 100; // 0.25 .. 0.84
  return {
    tierIndex,
    progress: Math.min(0.95, progress),
    current: RELATIONSHIP_TIERS[tierIndex]!,
    next: RELATIONSHIP_TIERS[tierIndex + 1],
  };
}
