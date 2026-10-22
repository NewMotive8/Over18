import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { statedAge } from '../services/home-composition-service.js';

/**
 * HER AGE ON A CARD IS HER OWN, NOT A DEFAULT.
 *
 * Every Home card derived its age from the Visual Identity apparent-age band.
 * That band is written as the bare string `'adult'` whenever an identity is
 * provisioned automatically — quick-create does it, and so does the first
 * upload that gives a character her first version — and a string with no digit
 * in it lands on the browser's one fixed default. So the whole roster rendered
 * the same number: a live Play with me rail read 26, 26, 26, 26, 28, 26, where
 * the only character who differed was the one whose band had been typed by
 * hand as "late-20s".
 *
 * Her persona age is the number an operator actually edits and the one her
 * profile shows, so the card now carries it and prefers it. The band stays as
 * the fallback for a character who has no persona.
 */

const source = readFileSync(
  fileURLToPath(new URL('../services/home-composition-service.ts', import.meta.url)),
  'utf8',
);

describe('the age a card carries', () => {
  it('passes a plain adult integer through, however it arrives from the driver', () => {
    expect(statedAge(31)).toBe(31);
    expect(statedAge('31')).toBe(31);
    expect(statedAge(18)).toBe(18);
    expect(statedAge(72)).toBe(72);
  });

  it('reports no age at all when there is no persona age', () => {
    expect(statedAge(null)).toBeNull();
    expect(statedAge(undefined)).toBeNull();
    expect(statedAge('')).toBeNull();
  });

  /**
   * ABSENT, NOT CLAMPED. The persona validator refuses an age below 18 where
   * personas are written, but this is a public projection on an adult product
   * and it does not get to assume the row it read came through that path.
   * Reporting absence lets the band answer instead; clamping upward would
   * invent an age nobody chose and hide a bad row.
   */
  it('refuses anything that is not a plain adult integer', () => {
    for (const bad of [17, 0, -1, 25.5, Number.NaN, 'twenty', '2e3', '31abc', 121]) {
      expect(statedAge(bad as never), String(bad)).toBeNull();
    }
  });
});

describe('the projection that feeds the rail', () => {
  /**
   * `->>` for the age and `->` for the band, each for its own reason: the band
   * must reach `renderValue` with its stored JSON type intact, while an age is
   * a scalar that is parsed to a number. Getting these the wrong way round is
   * silent — both "work" and one of them prints differently.
   */
  it('reads the age as text and the band as JSON', () => {
    expect(source).toContain("${characterPersonas.persona} ->> 'age'");
    // And her CONFIRMED age comes straight off the character row.
    expect(source).toContain('confirmedAge: characters.age');
    expect(source).toContain("${characterVisualIdentities.visualDna} -> 'apparentAgeBand'");
  });

  /**
   * A LEFT JOIN, or the roster shrinks. A character with no persona row must
   * keep her card and fall back to the band — an inner join would silently
   * drop every character who has never had a persona generated.
   */
  it('joins the persona without being able to drop or multiply a character', () => {
    expect(source).toContain(
      'leftJoin(characterPersonas, eq(characterPersonas.characterId, characters.id))',
    );
    expect(source).not.toMatch(/innerJoin\(\s*characterPersonas/);
  });

  /**
   * The card no longer reads the persona age directly. It asks the resolver,
   * which prefers an operator's confirmed age -- so the number on a card and
   * the number she states in chat come from one rule and cannot diverge.
   */
  /**
   * The card sends her CONFIRMED age or nothing. It used to derive one from
   * the band -- which is how a whole rail read 26 -- and then briefly from the
   * persona, which is a vision model's guess. Neither is a fact, and a number
   * beside her name is read as one.
   */
  it('puts only the confirmed age on the card, never a derived one', () => {
    expect(source).toContain('age: confirmedPublicAge(row.confirmedAge)');
    // Neither older shape may come back.
    expect(source).not.toContain('age: statedAge(row.age)');
    expect(source).not.toContain('resolveCharacterAge(row.confirmedAge');
  });
});
