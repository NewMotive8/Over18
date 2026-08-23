import { describe, it, expect } from 'vitest';
import { FORBIDDEN_AGE_TERMS, adultAgeFromBand } from './lobbyContent';

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

describe('the adults-only guardrail survives the US-102.4 rewrite', () => {
  it('still names every forbidden term', () => {
    // The category list this used to police is gone — categories are CMS data
    // now — but the vocabulary must not be, because it is what the safety guard
    // checks operator-authored names against.
    expect(FORBIDDEN_AGE_TERMS.length).toBeGreaterThan(0);
    for (const term of FORBIDDEN_AGE_TERMS) expect(term).toBe(term.toLowerCase());
  });
});
