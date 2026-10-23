import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CharacterPersona, PublicCharacter } from '@over18/shared';
import {
  MAXIMUM_PLAUSIBLE_AGE,
  MINIMUM_ADULT_AGE,
  resolveCharacterAge,
  usableAge,
} from '../services/character-age.js';
import { compilePersonaWhoSheIs } from '../services/character-persona-compiler.js';
import { buildCharacterSystemPrompt } from '../services/prompt-builder.js';
import type { ReplyContext } from '../services/character-reply.js';

/**
 * ONE AGE, THREE SOURCES, ONE ORDER.
 *
 * A character can be described by an operator-confirmed age, a persona age a
 * vision model wrote from one photograph, and an apparent-age BAND that says
 * how old she looks. They disagreed in production: cards derived from the band
 * and read 26 for almost the whole roster, while the chat and voice prompts
 * stated the persona's number — so the same character's card said 26 while she
 * told a caller she was 32.
 *
 * These pin the order, and pin that the surfaces cannot drift apart again.
 */

const character = (over: Partial<PublicCharacter> = {}): PublicCharacter => ({
  id: 'c1',
  name: 'nova',
  displayName: 'Nova',
  profileImage: null,
  age: null,
  shortBio: 'A bio.',
  personality: 'Dry and warm.',
  interests: ['pulsars'],
  conversationStyle: 'warm',
  ...over,
});

const context = (over: Partial<ReplyContext> = {}): ReplyContext =>
  ({ character: character(), history: [], priorMessageCount: 0, ...over }) as ReplyContext;

describe('which age wins', () => {
  it('prefers the operator-confirmed age over the persona', () => {
    const r = resolveCharacterAge(32, { age: 27 });
    expect(r.age).toBe(32);
    expect(r.source).toBe('confirmed');
    expect(r.confirmed).toBe(true);
  });

  it('falls back to the persona when nothing is confirmed', () => {
    for (const absent of [null, undefined]) {
      const r = resolveCharacterAge(absent, { age: 27 });
      expect(r.age).toBe(27);
      expect(r.source).toBe('persona');
      // The crucial half: a guess is never reported as confirmed.
      expect(r.confirmed).toBe(false);
    }
  });

  /**
   * Null is a real answer. The band is NOT resolved here on purpose: turning
   * "late 20s" into a number invents precision, which is acceptable on a card
   * label and wrong in a sentence she speaks about herself.
   */
  it('reports nothing when neither exists, rather than inventing a number', () => {
    const r = resolveCharacterAge(null, null);
    expect(r.age).toBeNull();
    expect(r.source).toBeNull();
    expect(r.confirmed).toBe(false);
  });

  it('treats an unusable confirmed age as absent and says so in the source', () => {
    // A corrupt or mistyped row must not masquerade as a confirmed age.
    for (const bad of [17, 0, -5, 25.5, Number.NaN, 999]) {
      const r = resolveCharacterAge(bad, { age: 30 });
      expect(r.age, String(bad)).toBe(30);
      expect(r.source, String(bad)).toBe('persona');
      expect(r.confirmed, String(bad)).toBe(false);
    }
  });

  it('accepts the exact boundaries and refuses just outside them', () => {
    expect(usableAge(MINIMUM_ADULT_AGE)).toBe(18);
    expect(usableAge(MAXIMUM_PLAUSIBLE_AGE)).toBe(120);
    expect(usableAge(MINIMUM_ADULT_AGE - 1)).toBeNull();
    expect(usableAge(MAXIMUM_PLAUSIBLE_AGE + 1)).toBeNull();
  });

  it('reads a numeric string, because the driver hands JSON scalars back as text', () => {
    expect(usableAge('32')).toBe(32);
    expect(usableAge('')).toBeNull();
    expect(usableAge('thirty')).toBeNull();
    expect(usableAge(null)).toBeNull();
  });
});

describe('what she says about her own age', () => {
  const persona: CharacterPersona = { age: 27, occupation: 'nurse' };

  it('states the confirmed age, not the persona one', () => {
    expect(compilePersonaWhoSheIs(persona, 32)).toContain("She's 32.");
    expect(compilePersonaWhoSheIs(persona, 32)).not.toContain("She's 27.");
  });

  /**
   * REVERSED DELIBERATELY. This asserted that she states the PERSONA's age when
   * nothing is confirmed, and that was the behaviour until now.
   *
   * It turned out to be the original defect pointing the other way. The prompt
   * was the only production caller of the resolver's persona fallback, so the
   * guess reached exactly one surface: the sentence she speaks about herself.
   * Her card showed nothing, because the card payload carries only
   * `characters.age`. So an unconfirmed character told a caller she was 27 while
   * her card said nothing at all -- the same card-versus-conversation
   * disagreement that `characters.age` was created to end.
   *
   * An unconfirmed age is a suggestion for an operator to approve. A suggestion
   * is not something she says out loud, so she now says nothing, on both
   * surfaces alike.
   */
  it('says NOTHING about her age when nothing is confirmed, even with a suggestion', () => {
    const facts = compilePersonaWhoSheIs(persona, null);
    expect(facts).not.toContain("She's 27.");
    expect(facts.join(' ')).not.toMatch(/She's \d/);
    // She is still described; only the age is withheld.
    expect(facts.join(' ')).toContain('nurse');
  });

  /** A confirmed age is worth stating even for a character with no persona. */
  it('states a confirmed age even when she has no persona at all', () => {
    expect(compilePersonaWhoSheIs(null, 32)).toEqual(["She's 32."]);
    expect(compilePersonaWhoSheIs(null, null)).toEqual([]);
  });

  it('says nothing about her age when nothing is known', () => {
    const facts = compilePersonaWhoSheIs({ occupation: 'nurse' }, null);
    expect(facts.join(' ')).not.toMatch(/She's \d/);
  });

  /**
   * THE BAND NEVER BECOMES A SPOKEN NUMBER. It stays a separate, hedged line
   * ("Her apparent age is ...") so she cannot claim a precision the record
   * does not have.
   */
  it('never turns the apparent-age band into a stated age', () => {
    const prompt = buildCharacterSystemPrompt(
      context({ character: character({ age: null }), persona: { occupation: 'nurse' } }),
    );
    expect(prompt).not.toMatch(/She's 26\./);
  });
});

describe('every consumer reads the same resolver', () => {
  const source = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('the prompt builder passes the confirmed age into the compiler', () => {
    expect(source('../services/prompt-builder.ts')).toContain(
      'compilePersonaWhoSheIs(context.persona, context.character.age)',
    );
  });

  /**
   * A PUBLIC CARD CARRIES THE CONFIRMED AGE OR NOTHING. The persona's number
   * is a vision model's guess; sending it would put a guess beside her name
   * where it reads as a fact. The prompt still falls back to it, because a
   * character speaking about herself is not the same as a label asserting a
   * number -- which is why the two call different functions here.
   */
  it('the card projection sends only the confirmed age', () => {
    const home = source('../services/home-composition-service.ts');
    expect(home).toContain('confirmedAge: characters.age');
    expect(home).toContain('age: confirmedPublicAge(row.confirmedAge)');
    // The persona age must not reach the public card.
    expect(home).not.toContain('resolveCharacterAge(row.confirmedAge');
  });

  /**
   * `toPublicCharacter` is the one mapper the profile, chat and call paths all
   * go through, so carrying the age there is what keeps them from diverging.
   */
  it('the public character mapper carries the confirmed age', () => {
    expect(source('../services/character-service.ts')).toContain('age: row.age ?? null');
  });
});
