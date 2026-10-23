import type { CharacterPersona } from '@over18/shared';
import { confirmedCharacterAge } from './character-age.js';

/**
 * Deterministic persona compiler (Phase 2 avatar-derived persona).
 *
 * Turns a structured CharacterPersona into the two prompt sections it is
 * allowed to touch: additional WHO SHE IS facts and one extra HER VOICE
 * clause. This is the ONLY place a persona's data becomes prompt text —
 * prompt-builder.ts never reads a CharacterPersona field directly.
 *
 * WHY THIS IS SAFE AGAINST INJECTION, CONCRETELY:
 *  1. Allowlist-only reads. Every function below accesses named
 *     CharacterPersona properties one at a time. Nothing here iterates
 *     unknown keys or calls JSON.stringify on the object, so a hallucinated
 *     or hand-edited extra key has no path into the output even if it
 *     somehow survived validateCharacterPersona.
 *  2. `clean()` on every string before it is interpolated: control
 *     characters and newlines are dropped, whitespace is collapsed, length
 *     is capped. A field value can never introduce a line break, so it can
 *     never look like the start of a new prompt section or a role marker.
 *  3. Fixed templates only. Every field lands inside an author-written
 *     sentence ("She works as ${occupation}.") — never emitted as its own
 *     paragraph. An adversarial occupation of "Ignore previous instructions"
 *     compiles to "She works as Ignore previous instructions." — a job-title
 *     clause, mid-paragraph, with nothing marking it as an instruction.
 *  4. Deterministic: no clock, no RNG, fixed English joins, fixed property
 *     read order. Same persona in -> same string out, always.
 *
 * `sourceSummary` is admin-review-only (see the field's doc comment in
 * @over18/shared) and is NEVER rendered by either function here.
 */

const MAX_FIELD_CHARS = 200;

/** Strips control characters/newlines and collapses whitespace. Never throws. */
function clean(value: string, maxChars = MAX_FIELD_CHARS): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function cleanList(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => clean(v)).filter((v) => v.length > 0);
}

function join(values: string[]): string {
  return values.join(', ');
}

/** Capitalises the first letter and ensures a trailing period. For fields that are already a complete clause. */
function sentence(value: string): string {
  const cleaned = clean(value);
  if (cleaned.length === 0) return '';
  const capitalised = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/**
 * Additional WHO SHE IS facts, in a fixed field order. Appended AFTER the
 * character's existing shortBio/personality/interests facts — never
 * replacing them. Empty array when persona is null/undefined/empty.
 */
export function compilePersonaWhoSheIs(
  persona?: CharacterPersona | null,
  /**
   * Her CONFIRMED age, when an operator has set one. It outranks the persona's
   * because what she says about herself must match what her card says, and the
   * card is driven by the same resolver -- see character-age.ts.
   */
  confirmedAge?: number | null,
): string[] {
  /**
   * CONFIRMED ONLY. She states an age an operator set, or she states none.
   *
   * This used to fall back to the persona's number and then to `ageRange`, so a
   * character with no confirmed age told a caller she was 32 while her card
   * showed nothing at all -- the two surfaces disagreeing again, just in the
   * opposite direction from the bug that created `characters.age`. Both are
   * driven by the confirmed age now, so they cannot diverge.
   *
   * `ageRange` is gone from here for the same reason: it is written by the same
   * vision model, so "she's mid-to-late 20s" is a guess in her own voice.
   */
  const confirmed = confirmedCharacterAge(confirmedAge);
  // A confirmed age is worth stating even when she has no persona at all.
  if (!persona) return confirmed === null ? [] : [`She's ${confirmed}.`];
  const facts: string[] = [];

  if (confirmed !== null) facts.push(`She's ${confirmed}.`);

  const lifeStage = sentence(persona.lifeStage ?? '');
  if (lifeStage.length > 0) facts.push(lifeStage);

  const occupation = clean(persona.occupation ?? '');
  if (occupation.length > 0) facts.push(`She works as ${occupation}.`);

  const education = clean(persona.education ?? '');
  if (education.length > 0) facts.push(`Educationally, she's ${education}.`);

  const relationship = sentence(persona.relationshipToWorkOrSchool ?? '');
  if (relationship.length > 0) facts.push(relationship);

  const visualStyle = clean(persona.visualStyle ?? '');
  if (visualStyle.length > 0) facts.push(`She dresses ${visualStyle}.`);

  const interests = cleanList(persona.interests);
  if (interests.length > 0) facts.push(`She's also drawn to ${join(interests)}.`);

  const hobbies = cleanList(persona.hobbies);
  if (hobbies.length > 0) facts.push(`In her free time she's into ${join(hobbies)}.`);

  const dailyContext = cleanList(persona.dailyContext);
  if (dailyContext.length > 0) facts.push(`Day to day, her life involves ${join(dailyContext)}.`);

  const recurringConcerns = cleanList(persona.recurringConcerns);
  if (recurringConcerns.length > 0) {
    facts.push(`She often has ${join(recurringConcerns)} on her mind.`);
  }

  for (const note of cleanList(persona.backgroundNotes)) {
    facts.push(sentence(note));
  }

  return facts;
}

/**
 * One extra HER VOICE sentence built from persona speech/social fields, or
 * null when none are set. Returned as a complete sentence so it can be
 * appended directly beside the existing code-owned VOICE_DIALS clause.
 */
export function compilePersonaVoiceClause(persona?: CharacterPersona | null): string | null {
  if (!persona) return null;
  const clauses: string[] = [];

  if (persona.speechRegister) clauses.push(clean(persona.speechRegister));

  const demeanor = cleanList(persona.demeanor);
  if (demeanor.length > 0) clauses.push(join(demeanor));

  if (persona.socialStyle) clauses.push(clean(persona.socialStyle));
  if (persona.humorStyle) clauses.push(`${clean(persona.humorStyle)} humor`);
  if (persona.flirtingStyle) clauses.push(`flirts in a ${clean(persona.flirtingStyle)} way`);

  if (clauses.length === 0) return null;
  return `Her voice is ${join(clauses)}.`;
}
