import { describe, it, expect } from 'vitest';
import type { PublicCharacter } from '@over18/shared';
import {
  CATEGORIES,
  FORBIDDEN_AGE_TERMS,
  adultAgeFromBand,
  buildHeroSlides,
  personaBadge,
  personaTags,
} from './lobbyContent';

function character(overrides: Partial<PublicCharacter> = {}): PublicCharacter {
  return {
    id: 'c1',
    name: 'luna',
    displayName: 'Luna',
    profileImage: 'https://img/luna.png',
    shortBio: 'bio',
    personality: 'p',
    interests: [],
    conversationStyle: 's',
    ...overrides,
  };
}

describe('adult-safe categories', () => {
  it('starts with All and contains no minor-coded or ambiguous-age term', () => {
    expect(CATEGORIES[0]).toBe('All');
    for (const category of CATEGORIES) {
      const lower = category.toLowerCase();
      for (const term of FORBIDDEN_AGE_TERMS) {
        expect(lower.includes(term)).toBe(false);
      }
    }
    // The brief's "Teen" example must never be present.
    expect((CATEGORIES as readonly string[]).includes('Teen')).toBe(false);
  });
});

describe('adultAgeFromBand', () => {
  it('maps adult bands to display ages', () => {
    expect(adultAgeFromBand('adult (mid-20s)')).toBe(25);
    expect(adultAgeFromBand('adult (late-20s)')).toBe(28);
    expect(adultAgeFromBand('adult (early-30s)')).toBe(32);
    expect(adultAgeFromBand('adult (mid-30s)')).toBe(35);
  });

  it('falls back to a safe adult default when the band is missing', () => {
    expect(adultAgeFromBand(undefined)).toBe(26);
    expect(adultAgeFromBand(null)).toBe(26);
    expect(adultAgeFromBand('')).toBe(26);
  });

  it('NEVER returns a non-adult age — always clamps to >= 21', () => {
    for (const band of ['18', 'adult (late-10s)', 'adult', 'mid-20s', 'unknown', '', undefined]) {
      expect(adultAgeFromBand(band)).toBeGreaterThanOrEqual(21);
    }
  });
});

describe('personaBadge', () => {
  it('assigns stable HOT/NEW badges by feed position', () => {
    expect(personaBadge(0)).toBe('HOT');
    expect(personaBadge(1)).toBe('NEW');
    expect(personaBadge(2)).toBeNull();
    expect(personaBadge(3)).toBeNull();
    expect(personaBadge(4)).toBe('HOT');
  });
});

describe('personaTags', () => {
  it('always tags Trending and only ever uses adult-safe categories', () => {
    const tags = personaTags(character(), 0);
    expect(tags).toContain('Trending');
    for (const tag of tags) {
      expect((CATEGORIES as readonly string[]).includes(tag)).toBe(true);
    }
  });
});

describe('buildHeroSlides', () => {
  it('leads with a non-persona promo slide, then data-driven persona slides', () => {
    const slides = buildHeroSlides([character({ id: 'a', displayName: 'Aria' }), character({ id: 'b', displayName: 'Bex' })]);
    expect(slides[0]?.kind).toBe('promo');
    expect(slides[0]?.ctaLabel).toBe('Refer a friend');
    expect(slides).toHaveLength(3); // promo + 2 personas
    expect(slides[1]?.kind).toBe('persona');
    expect(slides[1]?.headline).toContain('Aria');
  });

  it('caps persona slides at three', () => {
    const many = Array.from({ length: 6 }, (_, i) => character({ id: `c${i}`, displayName: `C${i}` }));
    expect(buildHeroSlides(many)).toHaveLength(4); // promo + 3
  });
});
