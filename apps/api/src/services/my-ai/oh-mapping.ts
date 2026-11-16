import type { MyAiAttributes } from '@over18/shared';

/**
 * Our option ids → OhAPI's vocabulary.
 *
 * ── WHY THIS LIVES HERE AND NOWHERE ELSE ────────────────────────────────────
 *
 * This file is the ONLY place in the system that knows OhAPI's strings. The
 * browser posts `{ breasts: 'huge' }`; nothing above this module learns that
 * the provider calls it `Huge Boobs`. Three things follow, and all three are
 * the point:
 *
 *   1. A provider renaming a value is a one-file change with no web deploy.
 *   2. A crafted request cannot smuggle text into a vendor payload — only ids
 *      that appear as keys below are ever translated, and anything else makes
 *      the whole draft invalid long before it reaches here.
 *   3. Swapping provider (or adding the Anime path on SpicyAPI) means writing
 *      a sibling of this file, not touching the wizard.
 *
 * ── EVERY VALUE BELOW WAS VERIFIED LIVE ─────────────────────────────────────
 *
 * Read from OhAPI's own lookup endpoints on 2026-11-15 with the staging key,
 * not copied from documentation. That matters because the list is full of
 * things nobody would guess: `Average` for a medium backside, `Huge Boobs`,
 * `Chin-length bob`, and a lower-case `loving` sitting among otherwise
 * capitalised personalities.
 *
 * Two values the prototype carried did NOT exist and would have failed at
 * creation: `Anime & manga` and `Netflix nights`. They are `Anime` and
 * `Netflix`. `interests` is a hard enum of 114 values on the create schema —
 * that enum, not the broader 291-entry lookup endpoint, is what is enforced.
 */

/** What a mapped attribute contributes to the OH payload. */
interface OhFragment {
  ethnicity?: string;
  nationality?: string;
  eyeColour?: string;
  hairColour?: string;
  hairLength?: string;
  bodyBuild?: string;
  breastSize?: string;
  buttSize?: string;
  personality?: string[];
  attitude?: string;
  relationshipStyle?: string;
  /** Free prose appended to `additionalDescription`. MODERATED by the provider. */
  description?: string;
  /** Free prose appended to `backstory`. */
  backstory?: string;
}

/**
 * OH requires a nationality and the wizard does not ask for one, so each
 * ethnicity carries a plausible default rather than the flow growing a step
 * nobody wants. It is a generation hint, not a claim about her.
 */
const ETHNICITY: Record<string, OhFragment> = {
  white: { ethnicity: 'White', nationality: 'American' },
  latina: { ethnicity: 'Latina', nationality: 'Mexican' },
  black: { ethnicity: 'Black', nationality: 'American' },
  mideast: { ethnicity: 'Middle-Eastern', nationality: 'Lebanese' },
  asian: { ethnicity: 'Asian', nationality: 'Japanese' },
};

const EYE_COLOUR: Record<string, OhFragment> = {
  brown: { eyeColour: 'Brown' },
  blue: { eyeColour: 'Blue' },
  green: { eyeColour: 'Green' },
  hazel: { eyeColour: 'Hazel' },
  grey: { eyeColour: 'Grey' },
};

const HAIR_COLOUR: Record<string, OhFragment> = {
  blonde: { hairColour: 'Blonde' },
  brunette: { hairColour: 'Brunette' },
  black: { hairColour: 'Black Hair' },
  red: { hairColour: 'Red Hair' },
};

/**
 * OhAPI HAS NO HAIR-STYLE FIELD. It has `hairLength` and `hairColour`, and
 * that is all — checked against the live schema, not assumed.
 *
 * Three of our eight land on a real `hairLength` value. The other five are
 * genuinely a length plus a description, so they set the closest length and
 * add prose. That prose goes to `additionalDescription`, which the provider
 * MODERATES and may reject outright — which is why the styles that need it
 * are the ones most likely to come back a little loose, and why none of the
 * flow's other choices were routed through it.
 */
const HAIR_STYLE: Record<string, OhFragment> = {
  straight: { hairLength: 'Long, Straight Hair' },
  bob: { hairLength: 'Chin-length bob' },
  pixie: { hairLength: 'Pixie cut' },
  wavy: { hairLength: 'Long', description: 'long loose wavy hair' },
  curly: { hairLength: 'Shoulder-Length Hair', description: 'voluminous curly hair' },
  ponytail: { hairLength: 'Long', description: 'hair worn in a high ponytail' },
  braids: { hairLength: 'Long', description: 'hair worn in two long braids' },
  bun: { hairLength: 'Long', description: 'hair tied up in a bun' },
};

const FIGURE: Record<string, OhFragment> = {
  petite: { bodyBuild: 'Petite' },
  slim: { bodyBuild: 'Slim' },
  athletic: { bodyBuild: 'Athletic' },
  curvy: { bodyBuild: 'Curvy' },
  voluptuous: { bodyBuild: 'Voluptuous' },
};

const BREASTS: Record<string, OhFragment> = {
  small: { breastSize: 'Small' },
  medium: { breastSize: 'Medium' },
  large: { breastSize: 'Large' },
  xl: { breastSize: 'Extra Large' },
  huge: { breastSize: 'Huge Boobs' },
};

/** `Average`, not `Medium`. Verified — guessing here would 400 the create. */
const BUTT: Record<string, OhFragment> = {
  small: { buttSize: 'Small' },
  medium: { buttSize: 'Average' },
  large: { buttSize: 'Big' },
  huge: { buttSize: 'Huge' },
};

/**
 * OH splits character into `personality[]` (a list) and `attitude` (one
 * value), and our thirteen do not all sit in the same one — `Yandere` and
 * `Sweet & innocent` are attitudes with no personality equivalent, while
 * `Seductive` is the reverse. Each maps to whichever OH actually offers.
 */
const PERSONALITY: Record<string, OhFragment> = {
  bratty: { personality: ['Bratty'], attitude: 'Bratty' },
  innocent: { attitude: 'Sweet & innocent' },
  seductive: { personality: ['Seductive'] },
  dominant: { personality: ['Dominant'] },
  submissive: { personality: ['Submissive'] },
  loving: { personality: ['loving'] }, // lower-case in OH's list. Not a typo.
  flirty: { personality: ['Flirty'] },
  nurturing: { personality: ['Nurturing'] },
  silly: { personality: ['Funny'] },
  romantic: { personality: ['Romantic'] },
  bimbo: { personality: ['Total bimbo'] },
  obsessed: { attitude: 'Yandere' },
  sassy: { attitude: 'Sassy & sarcastic' },
};

/**
 * Only three of the nine dynamics exist as an OH `relationshipStyle`. The
 * other six are backstory, which shapes how she talks without claiming the
 * provider models the relationship — stating otherwise would be the kind of
 * quiet inaccuracy that shows up later as "why doesn't she act like my
 * roommate".
 */
const RELATIONSHIP: Record<string, OhFragment> = {
  girlfriend: { relationshipStyle: 'Monogamous girlfriend' },
  wife: { relationshipStyle: 'Newlywed wife' },
  fwb: { relationshipStyle: 'Casual FWB' },
  roommate: { backstory: 'She is the user’s roommate; they share an apartment.' },
  colleague: { backstory: 'She is the user’s colleague at work.' },
  bestfriend: { backstory: 'She is the user’s long-time best friend.' },
  classmate: { backstory: 'She and the user are classmates on an evening course.' },
  stranger: { backstory: 'She and the user have only just met.' },
  tutor: { backstory: 'She is the user’s private tutor.' },
};

/** `job` is free text on the create schema — the 25-item list is suggestions. */
const JOB: Record<string, string> = {
  model: 'Model (fashion / lingerie)',
  nurse: 'Nurse',
  teacher: 'Teacher',
  flight: 'Flight attendant',
  secretary: 'Secretary / personal assistant',
  trainer: 'Fitness trainer',
  yoga: 'Yoga instructor',
  barista: 'Barista',
  student: 'College student',
  influencer: 'Influencer / Instagram model',
  dancer: 'Dancer (ballet or pole)',
  artist: 'Artist',
  photographer: 'Photographer',
  chef: 'Chef',
  bartender: 'Bartender',
  designer: 'Fashion designer',
  makeup: 'Makeup artist',
  writer: 'Writer',
  doctor: 'Doctor',
  lawyer: 'Lawyer',
  architect: 'Architect',
  entrepreneur: 'Entrepreneur',
};

/** Every one of these is in the create schema's 114-value `interests` enum. */
const INTERESTS: Record<string, string> = {
  dancing: 'Dancing',
  gardening: 'Gardening',
  photography: 'Photography',
  painting: 'Painting',
  cooking: 'Cooking',
  reading: 'Reading',
  writing: 'Writing',
  hiking: 'Hiking',
  swimming: 'Swimming',
  yoga: 'Yoga',
  cosplay: 'Cosplay',
  cars: 'Cars',
  gaming: 'Gaming',
  magic: 'Magic',
  gym: 'Gym',
  wine: 'Wine tasting',
  travel: 'Travel',
  anime: 'Anime', // NOT "Anime & manga" — that value does not exist.
  cycling: 'Cycling',
  netflix: 'Netflix', // NOT "Netflix nights".
  diy: 'DIY',
  comedy: 'Comedy',
};

/** A surname, since OH requires one and the wizard asks for a single name. */
const SURNAMES = [
  'Hart', 'Lane', 'Monroe', 'Reyes', 'Quinn', 'Sato',
  'Vale', 'Rivers', 'Blake', 'Moreau', 'Navarro', 'Kim',
];

export interface OhCharacterPayload {
  firstName: string;
  lastName: string;
  gender: 'Female';
  dateOfBirth: string;
  nationality: string;
  ethnicity: string;
  style: 'realistic';
  contentLevel: string;
  eyeColour?: string;
  hairColour?: string;
  hairLength?: string;
  bodyBuild?: string;
  breastSize?: string;
  buttSize?: string;
  personality?: string[];
  attitude?: string;
  relationshipStyle?: string;
  job?: string;
  interests?: string[];
  backstory?: string;
  additionalDescription?: string;
}

/**
 * A date of birth that yields exactly the age the user chose.
 *
 * Dated to the 1st of January so no companion has a birthday that could pass
 * and silently make the number beside her name wrong. The age shown and the
 * age sent are one fact with one source.
 */
export function dateOfBirthForAge(age: number, now = new Date()): string {
  return `${now.getUTCFullYear() - age}-01-01`;
}

/**
 * Compose the provider request from our own ids.
 *
 * Throws on an id it does not recognise rather than dropping it. A silently
 * omitted attribute is a companion who comes back subtly wrong with nothing in
 * the logs to say why — and since the shared validator has already run, an
 * unknown id here means a real defect, not bad input.
 */
/**
 * WHAT SHE IS WEARING, AND WHERE SHE IS STANDING.
 *
 * The first live companion came back naked. That was not the model being
 * lurid — it was us: `contentLevel` was `Sex`, and OhAPI's own definition of
 * that value is "explicit sexual content", governing the reference image as
 * much as the chat. `Sexy` is their "suggestive/clothed".
 *
 * The level alone says nothing about the outfit or the setting, and an
 * unprompted portrait tends to arrive against a blank studio void. Both go in
 * `additionalDescription`, which OhAPI documents as "free-text traits added
 * to the reference image" — the only field in the 67 that reaches it.
 */
export const PORTRAIT_OUTFIT = 'wearing a bikini';

export const PORTRAIT_SCENES = [
  'standing on a sunlit beach with the sea behind her',
  'at the edge of a swimming pool in warm afternoon light',
  'on a hotel balcony overlooking the sea',
  'on a sunny terrace with palm trees behind her',
  'on a wooden jetty above clear blue water',
] as const;

/**
 * The same companion always gets the same setting, and two companions rarely
 * get the same one.
 *
 * Deterministic rather than random so a re-run of the same draft produces the
 * same intent — and varied rather than fixed so a grid of companions does not
 * look like five photographs taken in one afternoon. Seeded on what the user
 * chose, never on ethnicity alone: the setting must not become a claim about
 * where somebody of a given background belongs.
 */
export function portraitSceneFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PORTRAIT_SCENES[hash % PORTRAIT_SCENES.length];
}

export function toOhPayload(input: {
  name: string;
  age: number;
  attributes: MyAiAttributes;
  now?: Date;
}): OhCharacterPayload {
  const { attributes: a } = input;

  const lookup = (table: Record<string, OhFragment>, key: string, field: string): OhFragment => {
    const found = table[key];
    if (!found) throw new Error(`my-ai: no OH mapping for ${field}="${key}"`);
    return found;
  };

  const fragments: OhFragment[] = [
    lookup(ETHNICITY, a.ethnicity, 'ethnicity'),
    lookup(EYE_COLOUR, a.eyeColour, 'eyeColour'),
    lookup(HAIR_COLOUR, a.hairColour, 'hairColour'),
    lookup(HAIR_STYLE, a.hairStyle, 'hairStyle'),
    lookup(FIGURE, a.figure, 'figure'),
    lookup(BREASTS, a.breasts, 'breasts'),
    lookup(BUTT, a.butt, 'butt'),
    lookup(PERSONALITY, a.personality, 'personality'),
    lookup(RELATIONSHIP, a.relationship, 'relationship'),
  ];

  const merged: OhFragment = {};
  const descriptions: string[] = [];
  const backstories: string[] = [];
  for (const fragment of fragments) {
    const { description, backstory, personality, ...rest } = fragment;
    if (description) descriptions.push(description);
    if (backstory) backstories.push(backstory);
    if (personality) merged.personality = [...(merged.personality ?? []), ...personality];
    Object.assign(merged, rest);
  }

  const job = JOB[a.job];
  if (!job) throw new Error(`my-ai: no OH mapping for job="${a.job}"`);

  const interests = a.interests.map((id) => {
    const value = INTERESTS[id];
    if (!value) throw new Error(`my-ai: no OH mapping for interest="${id}"`);
    return value;
  });

  const payload: OhCharacterPayload = {
    firstName: input.name.trim(),
    lastName: SURNAMES[Math.floor(Math.random() * SURNAMES.length)],
    gender: 'Female',
    dateOfBirth: dateOfBirthForAge(input.age, input.now),
    nationality: merged.nationality!,
    ethnicity: merged.ethnicity!,
    style: 'realistic',
    /*
     * `Sexy`, the provider's "suggestive/clothed" — NOT `Sex`, which is their
     * "explicit sexual content" and is why the first companion arrived naked.
     * It is a ceiling on text and media alike, and the image is the only part
     * of OhAPI this product uses.
     */
    contentLevel: 'Sexy',
    eyeColour: merged.eyeColour,
    hairColour: merged.hairColour,
    hairLength: merged.hairLength,
    bodyBuild: merged.bodyBuild,
    breastSize: merged.breastSize,
    buttSize: merged.buttSize,
    personality: merged.personality,
    attitude: merged.attitude,
    relationshipStyle: merged.relationshipStyle,
    job,
  };

  if (interests.length) payload.interests = interests;
  if (backstories.length) payload.backstory = backstories.join(' ');

  /*
   * Last, and always present. The attribute phrases above are occasional —
   * only five of eight hairstyles need one — but every portrait needs an
   * outfit and somewhere to stand, or the model decides both for itself.
   */
  descriptions.push(
    `${PORTRAIT_OUTFIT}, ${portraitSceneFor(`${input.name}|${a.figure}|${a.hairColour}|${a.personality}`)}`,
  );
  // Capped well under OH's 1,000 characters; this is only ever a few phrases.
  payload.additionalDescription = descriptions.join(', ').slice(0, 900);

  return payload;
}
