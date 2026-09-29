/**
 * Does her PUBLIC profile still describe the same person her CHAT persona does?
 *
 * ── WHY THIS CAN DRIFT AT ALL ────────────────────────────────────────────────
 *
 * They are separate records written by separate actions, and neither updates the
 * other. The About tab renders `characters.short_bio` / `personality` /
 * `interests` / `conversation_style`. Chat reads `character_personas.persona`
 * and compiles it into the system prompt; nothing of it is ever sent to a
 * customer. So an operator can regenerate a persona, decline the profile
 * rewrite -- or hand-edit the persona, which offers no rewrite at all -- and
 * leave a character whose page says one thing while she says another in chat.
 * Nothing in the product notices.
 *
 * Measured on the live roster: 9 of 19 characters with a persona had an
 * occupation their public bio did not mention. Not nine mistakes -- most were
 * bios accepted under an older generation prompt, with personas regenerated
 * later and never re-accepted. But "Bollywood actress" against a bio reading
 * "marketing coordinator" is worth an operator's attention either way.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ────────────────────────────────────────────
 *
 * Not a classifier, and not a judgement about whether a character is "correct".
 * It compares ONE field pair and reports what it sees. Divergence is allowed:
 * some characters are meant to present differently in chat than on their page,
 * and this never asserts otherwise -- it says the two differ, shows both, and
 * leaves the decision where it belongs.
 *
 * SHARED, so the Admin list and the Admin detail view cannot disagree about the
 * same character. A second copy of this rule is exactly how the count on one
 * screen starts contradicting the banner on another.
 */

export type ProfileDivergenceStatus =
  /** Both sides describe an occupation and they do not overlap. */
  | 'diverged'
  /** Both sides describe an occupation and they share meaningful wording. */
  | 'consistent'
  /** One side has nothing to compare. Not a contradiction. */
  | 'incomplete';

export interface ProfileDivergence {
  status: ProfileDivergenceStatus;
  /** The persona's occupation, verbatim, or null when it has none. */
  personaOccupation: string | null;
  /** The public text that was searched, or null when there is none. */
  publicText: string | null;
  /** Which public fields were searched. Empty when there was nothing to search. */
  publicFields: readonly ('shortBio' | 'personality')[];
  /** Occupation words found on both sides. Evidence for 'consistent'. */
  sharedWords: readonly string[];
  /** Why this status, in a sentence an operator can act on. */
  summary: string;
}

/**
 * Words that carry no occupational meaning on their own.
 *
 * Two kinds, and both matter. Grammar ("at", "the") would match almost any
 * prose. Workplace nouns ("agency", "clinic", "studio") are the other half of
 * the problem: a bio mentioning "a small studio" would otherwise vouch for a
 * persona reading "copywriter at a small studio" while saying nothing about
 * whether she is a copywriter.
 */
const IGNORED = new Set([
  'a', 'an', 'the', 'at', 'in', 'of', 'for', 'and', 'or', 'with', 'on', 'to', 'from',
  'her', 'she', 'his', 'he', 'they', 'their', 'who', 'that', 'this', 'its',
  'small', 'large', 'mid', 'size', 'sized', 'local', 'regional', 'national', 'busy',
  'neighbourhood', 'neighborhood', 'high', 'street', 'city', 'town', 'central',
  'company', 'office', 'agency', 'studio', 'clinic', 'firm', 'practice', 'centre',
  'center', 'shop', 'store', 'chain', 'group', 'team', 'department', 'branch',
  'work', 'works', 'working', 'job', 'role', 'career', 'full', 'time', 'part',
  'minute', 'minutes', 'walk', 'ride', 'commute', 'away', 'near', 'nearby', 'flat',
  'home', 'most', 'days', 'weekdays', 'year', 'years', 'old',
]);

/** The employer clause is not the job: "nurse at a big hospital" is about nurse. */
const EMPLOYER_CLAUSE = / at | for | with | in | of | working | based /;

/** Lowercased alphabetic words of four letters or more, minus the ignore list. */
function significantWords(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((word) => word.length >= 4 && !IGNORED.has(word));
}

/**
 * The occupation's own words, with the employer clause removed.
 *
 * "graphic designer at a mid-size advertising agency a short train ride from
 * her flat" reduces to graphic + designer. Keeping the tail would let the word
 * "advertising" in a bio vouch for a job title that is not in it.
 */
function occupationWords(occupation: string): string[] {
  return significantWords(occupation.split(EMPLOYER_CLAUSE)[0] ?? occupation);
}

const blank = (value: string | null | undefined): boolean => !value || value.trim() === '';

/**
 * Compare the persona's occupation against the public profile prose.
 *
 * ONE FIELD PAIR, ON PURPOSE. Personality, interests and tone differ in wording
 * between these two records almost everywhere, legitimately -- comparing them
 * would flag every character on the roster and the warning would be ignored
 * within a day. Occupation is the one field where a difference is concrete
 * enough to be worth a second look.
 *
 * MATCHING IS DELIBERATELY GENEROUS. A single shared significant word is enough
 * to call it consistent, because the two texts are written to different briefs:
 * one is a job title, the other is prose about her life. "physiotherapist"
 * inside "Camila is a physiotherapist at a neighbourhood clinic" is the shape
 * agreement actually takes. Being strict here would manufacture contradictions
 * out of phrasing, which is the failure mode that makes a warning useless.
 */
export function compareProfileAndPersona(input: {
  shortBio: string | null | undefined;
  personality: string | null | undefined;
  personaOccupation: string | null | undefined;
}): ProfileDivergence {
  const occupation = blank(input.personaOccupation) ? null : input.personaOccupation!.trim();

  const fields: ('shortBio' | 'personality')[] = [];
  if (!blank(input.shortBio)) fields.push('shortBio');
  if (!blank(input.personality)) fields.push('personality');
  const publicText = fields.length
    ? [input.shortBio, input.personality].filter((v) => !blank(v)).join(' ').trim()
    : null;

  // MISSING IS NOT CONFLICTING. A character with no persona, or with a persona
  // that never named an occupation, is simply not comparable -- saying so is
  // more useful than implying agreement or raising an alarm.
  if (!occupation || !publicText) {
    return {
      status: 'incomplete',
      personaOccupation: occupation,
      publicText,
      publicFields: fields,
      sharedWords: [],
      summary: !occupation
        ? 'Her chat persona does not state an occupation, so there is nothing to compare.'
        : 'Her public profile has no bio or personality text, so there is nothing to compare.',
    };
  }

  const words = occupationWords(occupation);
  const haystack = publicText.toLowerCase();

  // An occupation made entirely of ignored words leaves nothing to test.
  if (words.length === 0) {
    return {
      status: 'incomplete',
      personaOccupation: occupation,
      publicText,
      publicFields: fields,
      sharedWords: [],
      summary:
        'Her chat persona names an occupation, but not in words specific enough to compare.',
    };
  }

  const shared = words.filter((word) => haystack.includes(word));

  if (shared.length > 0) {
    return {
      status: 'consistent',
      personaOccupation: occupation,
      publicText,
      publicFields: fields,
      sharedWords: shared,
      summary: `Her public profile mentions ${shared.join(', ')}, which matches her chat persona.`,
    };
  }

  return {
    status: 'diverged',
    personaOccupation: occupation,
    publicText,
    publicFields: fields,
    sharedWords: [],
    summary:
      `Her chat persona says she is ${occupation}. Her public ` +
      `${fields.length === 2 ? 'bio and personality do' : fields[0] === 'shortBio' ? 'bio does' : 'personality does'} not mention that.`,
  };
}
