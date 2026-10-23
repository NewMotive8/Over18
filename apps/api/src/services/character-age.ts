import type { CharacterPersona } from '@over18/shared';

/**
 * WHICH AGE IS HERS, AND HOW WELL IT IS KNOWN.
 *
 * Three numbers can describe a character and they are not equal in standing:
 *
 *   confirmed  `characters.age`, set by an operator. A statement of fact.
 *   persona    `character_personas.persona.age`, written by a vision model
 *              from one photograph. A plausible guess.
 *   band       the apparent-age band on her visual identity, which describes
 *              how old she LOOKS, not how old she is.
 *
 * They disagreed in production. Cards derived from the band and read 26 for
 * the whole roster, because the band is written as the bare string 'adult'
 * whenever an identity is provisioned automatically; meanwhile the chat and
 * voice prompts stated the persona's number. The same character's card said
 * 26 while she told a caller she was 32.
 *
 * So the precedence lives HERE, in one function, and every surface asks it
 * rather than deciding for itself.
 *
 * THE BAND IS NOT RESOLVED HERE, on purpose. Turning "late 20s" into a number
 * is a DISPLAY fallback: it invents precision the record does not have, which
 * is fine for a label on a card and wrong in a sentence the character speaks
 * about herself. This returns null when nothing is known, and each caller
 * decides what that means -- the card falls back to the band, and the prompt
 * simply says nothing about her age.
 */

/** The floor the database also enforces (`characters_age_adult`). */
export const MINIMUM_ADULT_AGE = 18;

/**
 * Above any age a person plausibly has. A value beyond it is a typo or a
 * corrupt row, and is treated as unknown rather than printed.
 */
export const MAXIMUM_PLAUSIBLE_AGE = 120;

export type AgeSource = 'confirmed' | 'persona';

export interface ResolvedCharacterAge {
  /** The age to use, or null when nothing usable is known. */
  age: number | null;
  /** Where it came from. Null when `age` is null. */
  source: AgeSource | null;
  /**
   * True ONLY for an operator-set age.
   *
   * Admin reads this to avoid showing a model's guess as though a person had
   * confirmed it -- the whole reason the two are kept apart.
   */
  confirmed: boolean;
}

/** A plain adult integer, or null. Everything else is treated as unknown. */
export function usableAge(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (typeof raw !== 'number' && (raw === null || raw === undefined || raw === '')) return null;
  if (!Number.isInteger(value)) return null;
  if (value < MINIMUM_ADULT_AGE || value > MAXIMUM_PLAUSIBLE_AGE) return null;
  return value;
}

/**
 * The one precedence rule: confirmed, then persona, then nothing.
 *
 * An unusable confirmed age does NOT fall through silently to the persona's --
 * it falls through, but the caller can see from `source` which number it got,
 * so a bad row shows up as "persona" rather than masquerading as confirmed.
 */
export function resolveCharacterAge(
  confirmed: number | null | undefined,
  persona?: CharacterPersona | null,
): ResolvedCharacterAge {
  const operator = usableAge(confirmed);
  if (operator !== null) return { age: operator, source: 'confirmed', confirmed: true };

  const generated = usableAge(persona?.age);
  if (generated !== null) return { age: generated, source: 'persona', confirmed: false };

  return { age: null, source: null, confirmed: false };
}

/**
 * The only age a surface the customer can see may state.
 *
 * ── WHY THIS EXISTS BESIDE `resolveCharacterAge` ─────────────────────────────
 *
 * `resolveCharacterAge` falls back to the persona's guess, and for a while its
 * ONLY production caller was the chat and voice prompt -- so the guess reached
 * exactly one surface: the sentence the character speaks about herself. Her card
 * meanwhile showed nothing, because the card payload carries only
 * `characters.age`. That is the same defect the resolver was written to end,
 * pointing the other way: the card said nothing while she told a caller she was
 * 32.
 *
 * So the rule is now explicit rather than implied by which function a caller
 * happened to reach for. An unconfirmed age is a suggestion for an operator to
 * approve, and a suggestion is not something she says out loud.
 *
 * SAYING NOTHING IS THE CORRECT BEHAVIOUR, not a gap. A character with no
 * confirmed age states no age, on her card and in her own voice alike, and that
 * is consistent. Stating a number nobody confirmed would make her card and her
 * conversation disagree, which is worse than silence and much harder to notice.
 */
export function confirmedCharacterAge(confirmed: number | null | undefined): number | null {
  return usableAge(confirmed);
}

/**
 * The model's guess, for Admin review ONLY.
 *
 * Named so that a caller cannot reach it by accident while meaning "her age":
 * every use is a place where an operator is being shown something to approve.
 * It must never reach a prompt, a card, a profile or any API response the
 * customer can read.
 */
export function suggestedCharacterAge(persona?: CharacterPersona | null): number | null {
  return usableAge(persona?.age);
}
