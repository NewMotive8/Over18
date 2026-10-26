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
/**
 * A PUBLIC AGE IS A CONFIRMED AGE, OR NOTHING.
 *
 * Cards used to derive a number from the apparent-age band, which is written
 * as the bare string 'adult' whenever an identity is provisioned
 * automatically -- so a live rail read 26, 26, 26, 26, 28, 26. The fix is not
 * a better fallback: a number beside her name reads as a fact, and neither
 * the band nor a vision model's persona age is one. Null means show none, and
 * a character now needs a confirmed age before she can go live.
 */
describe('displayAge: confirmed, or nothing', () => {
  it('shows an operator-confirmed age', () => {
    expect(displayAge(32)).toBe(32);
    expect(displayAge(18)).toBe(18);
    expect(displayAge(41)).toBe(41);
  });

  it('shows NOTHING when no age is confirmed', () => {
    expect(displayAge(null)).toBeNull();
    expect(displayAge(undefined)).toBeNull();
  });

  it('refuses anything that is not a plain adult integer', () => {
    for (const bad of [17, 0, -5, 25.5, Number.NaN]) {
      expect(displayAge(bad), String(bad)).toBeNull();
    }
  });

  /**
   * The band still parses -- Admin may reasonably show a hedged estimate while
   * an operator decides -- but it no longer reaches a customer-facing label.
   */
  it('keeps the band parser for Admin, with no route to a public number', () => {
    expect(adultAgeFromBand('adult (late-20s)')).toBe(28);
    expect(adultAgeFromBand('adult')).toBe(26);
    // displayAge takes ONE argument now: a band cannot be passed to it at all.
    expect(displayAge.length).toBe(1);
  });
});
