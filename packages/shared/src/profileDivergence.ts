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

/**
 * ROLE NOUNS THAT CARRY NO IDENTITY ON THEIR OWN.
 *
 * "manager" is load-bearing for grammar and empty for identity: a marketing
 * manager and a hotel manager share it and do different jobs. Treating that
 * overlap as agreement is exactly how the first version of this reported
 * "marketing manager" and "hotel manager" as consistent.
 *
 * DELIBERATELY ABSENT: teacher, nurse, chef, baker, dentist, pharmacist. Those
 * name a profession by themselves, and listing them here would make them
 * permanently unconfirmable -- every teacher would read as ambiguous forever.
 */
const GENERIC_ROLE_NOUNS = new Set([
  'manager', 'director', 'coordinator', 'specialist', 'consultant', 'assistant',
  'officer', 'executive', 'associate', 'representative', 'supervisor',
  'administrator', 'adviser', 'advisor', 'agent', 'designer', 'analyst',
  'engineer', 'technician', 'operator', 'planner', 'lead', 'head',
  'professional', 'worker', 'staff',
]);

/**
 * Occupations that are the same job under different words.
 *
 * SMALL ON PURPOSE. Every entry here excuses a difference, so a long list of
 * half-true equivalences would quietly start hiding real contradictions -- worse
 * than a false alarm, which an operator can dismiss by looking. These six are
 * the ones where the two words genuinely name one job.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['lawyer', 'solicitor', 'barrister', 'attorney'],
  ['doctor', 'physician'],
  ['chef', 'cook'],
  ['hairdresser', 'hairstylist'],
  ['developer', 'programmer'],
  ['physiotherapist', 'physio'],
];

const SYNONYMS = new Map<string, readonly string[]>();
for (const group of SYNONYM_GROUPS) for (const word of group) SYNONYMS.set(word, group);

/** The word itself, plus anything that means the same job. */
function equivalents(word: string): readonly string[] {
  return SYNONYMS.get(word) ?? [word];
}

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

/**
 * WORDS, NOT SUBSTRINGS. The first version asked `text.includes(word)`, which
 * makes "head" match "ahead" and "lead" match "leading" -- nonsense agreements
 * from words that happen to share letters.
 *
 * The `startsWith` arm is deliberate and bounded: it lets "garden" match
 * "gardens" and "event" match "events" without a stemmer, and the five-character
 * floor keeps short words from reaching across meanings.
 */
function tokensOf(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
}

function findTerm(tokens: readonly string[], word: string): string | null {
  for (const candidate of equivalents(word)) {
    const hit = tokens.find(
      (token) => token === candidate || (candidate.length >= 5 && token.startsWith(candidate)),
    );
    if (hit) return hit;
  }
  return null;
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
  const tokens = tokensOf(publicText);

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

  /**
   * THE TWO CLASSES DECIDE DIFFERENT THINGS.
   *
   * A specific word is evidence about WHO SHE IS: "marketing", "hotel",
   * "physiotherapist". A generic role noun is evidence about sentence shape and
   * nothing else. So a specific match can confirm agreement, and a generic match
   * can only fail to rule it out.
   */
  const specific = words.filter((word) => !GENERIC_ROLE_NOUNS.has(word));
  const generic = words.filter((word) => GENERIC_ROLE_NOUNS.has(word));

  // Report the word found in HER PROFILE, not the persona's -- with synonyms the
  // two differ, and the operator is reading the profile.
  const matchedSpecific = specific
    .map((word) => findTerm(tokens, word))
    .filter((hit): hit is string => hit !== null);

  if (matchedSpecific.length > 0) {
    return {
      status: 'consistent',
      personaOccupation: occupation,
      publicText,
      publicFields: fields,
      sharedWords: matchedSpecific,
      summary: `Her public profile mentions ${matchedSpecific.join(', ')}, which matches her chat persona.`,
    };
  }

  const matchedGeneric = generic
    .map((word) => findTerm(tokens, word))
    .filter((hit): hit is string => hit !== null);

  /**
   * AMBIGUOUS, AND SAID SO RATHER THAN GUESSED.
   *
   * Both sides use the same role noun and agree on nothing else: "marketing
   * manager" against "hotel manager", or "graphic designer" against a bio that
   * just says "designer". The first is a real difference and the second is not,
   * and from here they are indistinguishable -- proving the first would mean
   * parsing which qualifier belongs to which noun, which is a great deal of
   * machinery to get wrong in a feature whose only value is being trusted.
   *
   * So it reports neither agreement nor conflict, and asks for a human. That is
   * the honest answer and it is also the useful one: the operator sees both
   * values either way, and only the badge differs.
   */
  if (matchedGeneric.length > 0) {
    return {
      status: 'incomplete',
      personaOccupation: occupation,
      publicText,
      publicFields: fields,
      sharedWords: matchedGeneric,
      summary:
        `Both describe her as a ${matchedGeneric.join(', ')}, but agree on nothing more specific. ` +
        `Her chat persona says ${occupation}. Worth checking by eye.`,
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
