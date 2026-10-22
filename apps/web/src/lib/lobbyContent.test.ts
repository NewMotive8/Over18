import { describe, it, expect } from 'vitest';
import { FORBIDDEN_AGE_TERMS, adultAgeFromBand, displayAge } from './lobbyContent';

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

/**
 * THE BUG THIS CLOSES. An identity provisioned automatically -- by
 * quick-create, or by a character's first upload -- carries the bare band
 * `'adult'`. There is no digit in that string, so `adultAgeFromBand` falls to
 * its one fixed default and EVERY such character rendered the same number. A
 * live rail read 26, 26, 26, 26, 28, 26: only the character whose band had
 * been typed by hand ("late-20s") differed from the default.
 */
describe('displayAge: her profile first, her photo second', () => {
  it('shows the stated age instead of the default the bare band produces', () => {
    // The exact shape of the defect: same band, different characters.
    expect(adultAgeFromBand('adult')).toBe(26);
    expect(displayAge(31, 'adult')).toBe(31);
    expect(displayAge(22, 'adult')).toBe(22);
    expect(displayAge(44, 'adult')).toBe(44);
  });

  it('prefers the stated age even when the band would give a different number', () => {
    // The band says how old she LOOKS; the profile says how old she IS.
    expect(adultAgeFromBand('adult (late-20s)')).toBe(28);
    expect(displayAge(35, 'adult (late-20s)')).toBe(35);
  });

  /** Unchanged for anyone without a persona: the band still decides. */
  it('falls back to the band when there is no stated age', () => {
    for (const missing of [null, undefined]) {
      expect(displayAge(missing, 'adult (mid-30s)')).toBe(35);
      expect(displayAge(missing, 'adult')).toBe(26);
      expect(displayAge(missing, null)).toBe(26);
    }
  });

  /**
   * NEVER A MINOR-CODED NUMBER, whatever the row says. This is a public label
   * on an adult product, so an implausible or non-integer value is treated as
   * absent and the band answers instead -- the floor is never crossed by
   * trusting a stored value.
   */
  it('refuses an age that is not a plain adult integer', () => {
    for (const bad of [17, 0, -5, 20, 25.5, Number.NaN] as number[]) {
      expect(displayAge(bad, 'adult (mid-20s)')).toBe(25);
    }
    expect(displayAge(21, 'adult')).toBe(21); // the floor itself is allowed
  });
});
