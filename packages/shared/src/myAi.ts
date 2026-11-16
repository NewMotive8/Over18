/**
 * "My AI" — the vocabulary a user builds their own companion from.
 *
 * ── WHY THIS IS SHARED AND WHY IT CARRIES NO VENDOR VALUES ──────────────────
 *
 * Same reasoning as `voice.ts`: the browser renders the options and the server
 * validates the submission, so one list has to serve both or they drift and the
 * drift shows up as a choice the user can make and the server then rejects.
 *
 * What is DELIBERATELY not here is the generation provider's own vocabulary.
 * OhAPI wants `"Huge Boobs"`, `"Chin-length bob"` and a lower-case `"loving"`
 * among otherwise capitalised personalities; those strings are a vendor detail
 * and they live on the server alone (`apps/api/src/services/my-ai/oh-mapping.ts`).
 * The browser posts `{ breasts: 'huge' }` and never learns who renders her.
 *
 * Three things fall out of that, all of them the point:
 *   1. When OH renames a value we change one server file. No web deploy.
 *   2. A crafted request cannot smuggle an arbitrary string into a vendor
 *      payload — the server only ever maps ids it recognises.
 *   3. Swapping the provider (or adding the Anime path on SpicyAPI) is a
 *      server concern and does not touch a single option list here.
 *
 * ── THE ETHNICITY RULE ──────────────────────────────────────────────────────
 *
 * Ethnicity is chosen at step 2 and every tile after it is rendered in THAT
 * ethnicity — see `myAiTileUrl`. The option ids below are therefore also the
 * asset filenames, which is what keeps 160 image files addressable without a
 * manifest. Renaming an id renames a file.
 */

/** One selectable option. `id` is the wire value, the asset name, and the key. */
export interface MyAiOption {
  readonly id: string;
  readonly label: string;
}

/* ------------------------------------------------------------------ *
 * Step 2 — her background
 * ------------------------------------------------------------------ */

/**
 * The five ethnicities, each with a complete tile set of its own.
 *
 * ADDING ONE IS NOT A CODE CHANGE ALONE: a sixth entry needs all 31 of its
 * tiles under `/create/realistic/<id>/` or step 3 and 4 render holes. The
 * option set is identical across all five precisely so no choice here leads to
 * a narrower flow afterwards.
 */
export const MY_AI_ETHNICITIES = [
  { id: 'white', label: 'White' },
  { id: 'latina', label: 'Latina' },
  { id: 'black', label: 'Black' },
  { id: 'mideast', label: 'Middle Eastern' },
  { id: 'asian', label: 'Asian' },
] as const satisfies readonly MyAiOption[];

export type MyAiEthnicity = (typeof MY_AI_ETHNICITIES)[number]['id'];

/* ------------------------------------------------------------------ *
 * Step 3 — her look
 * ------------------------------------------------------------------ */

export const MY_AI_HAIR_COLOURS = [
  { id: 'blonde', label: 'Blonde' },
  { id: 'brunette', label: 'Brunette' },
  { id: 'black', label: 'Black' },
  { id: 'red', label: 'Red' },
] as const satisfies readonly MyAiOption[];

export const MY_AI_HAIR_STYLES = [
  { id: 'straight', label: 'Straight' },
  { id: 'wavy', label: 'Wavy' },
  { id: 'curly', label: 'Curly' },
  { id: 'bob', label: 'Bob' },
  { id: 'pixie', label: 'Pixie' },
  { id: 'ponytail', label: 'Ponytail' },
  { id: 'braids', label: 'Braids' },
  { id: 'bun', label: 'Bun' },
] as const satisfies readonly MyAiOption[];

export const MY_AI_EYE_COLOURS = [
  { id: 'brown', label: 'Brown' },
  { id: 'blue', label: 'Blue' },
  { id: 'green', label: 'Green' },
  { id: 'hazel', label: 'Hazel' },
  { id: 'grey', label: 'Grey' },
] as const satisfies readonly MyAiOption[];

/* ------------------------------------------------------------------ *
 * Step 4 — her shape
 * ------------------------------------------------------------------ */

export const MY_AI_FIGURES = [
  { id: 'petite', label: 'Petite' },
  { id: 'slim', label: 'Slim' },
  { id: 'athletic', label: 'Athletic' },
  { id: 'curvy', label: 'Curvy' },
  { id: 'voluptuous', label: 'Voluptuous' },
] as const satisfies readonly MyAiOption[];

export const MY_AI_BREASTS = [
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large', label: 'Large' },
  { id: 'xl', label: 'XL' },
  { id: 'huge', label: 'Huge' },
] as const satisfies readonly MyAiOption[];

export const MY_AI_BUTTS = [
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large', label: 'Large' },
  { id: 'huge', label: 'Huge' },
] as const satisfies readonly MyAiOption[];

/* ------------------------------------------------------------------ *
 * Step 5 — her vibe
 * ------------------------------------------------------------------ */

export const MY_AI_PERSONALITIES = [
  { id: 'bratty', label: 'Bratty' },
  { id: 'innocent', label: 'Innocent' },
  { id: 'seductive', label: 'Seductive' },
  { id: 'dominant', label: 'Dominant' },
  { id: 'submissive', label: 'Submissive' },
  { id: 'loving', label: 'Loving' },
  { id: 'flirty', label: 'Flirty' },
  { id: 'nurturing', label: 'Nurturing' },
  { id: 'silly', label: 'Silly' },
  { id: 'romantic', label: 'Romantic' },
  { id: 'bimbo', label: 'Bimbo' },
  { id: 'obsessed', label: 'Obsessed' },
  { id: 'sassy', label: 'Sassy' },
] as const satisfies readonly MyAiOption[];

/**
 * How she relates to the user.
 *
 * STEP-FAMILY FRAMING IS DELIBERATELY ABSENT. It is conventional in this
 * market and both reference flows carry it, but OH screens free text and
 * returns `400 Additional details blocked by moderation` — so the options most
 * likely to be rejected at creation time are also the ones hardest to defend.
 * Not an oversight; a decision.
 */
export const MY_AI_RELATIONSHIPS = [
  { id: 'girlfriend', label: 'Girlfriend' },
  { id: 'wife', label: 'Wife' },
  { id: 'fwb', label: 'Friends with benefits' },
  { id: 'roommate', label: 'Roommate' },
  { id: 'colleague', label: 'Colleague' },
  { id: 'bestfriend', label: 'Best friend' },
  { id: 'classmate', label: 'Classmate' },
  { id: 'stranger', label: 'Stranger' },
  { id: 'tutor', label: 'Private tutor' },
] as const satisfies readonly MyAiOption[];

/* ------------------------------------------------------------------ *
 * Confirm screen — pre-filled, each tappable to change
 * ------------------------------------------------------------------ */

export const MY_AI_JOBS = [
  { id: 'model', label: 'Model' },
  { id: 'nurse', label: 'Nurse' },
  { id: 'teacher', label: 'Teacher' },
  { id: 'flight', label: 'Flight attendant' },
  { id: 'secretary', label: 'Secretary' },
  { id: 'trainer', label: 'Fitness trainer' },
  { id: 'yoga', label: 'Yoga instructor' },
  { id: 'barista', label: 'Barista' },
  { id: 'student', label: 'College student' },
  { id: 'influencer', label: 'Influencer' },
  { id: 'dancer', label: 'Dancer' },
  { id: 'artist', label: 'Artist' },
  { id: 'photographer', label: 'Photographer' },
  { id: 'chef', label: 'Chef' },
  { id: 'bartender', label: 'Bartender' },
  { id: 'designer', label: 'Fashion designer' },
  { id: 'makeup', label: 'Makeup artist' },
  { id: 'writer', label: 'Writer' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'lawyer', label: 'Lawyer' },
  { id: 'architect', label: 'Architect' },
  { id: 'entrepreneur', label: 'Entrepreneur' },
] as const satisfies readonly MyAiOption[];

/**
 * Interests.
 *
 * Every label here maps to a value in OhAPI's `interests` enum, which is a HARD
 * enum of 114 values on the create schema — not the 291-entry lookup endpoint,
 * which is broader and is not what gets enforced. Verified live on 2026-11-15.
 * Two values the prototype carried did NOT exist (`Anime & manga`, `Netflix
 * nights`) and are corrected here to `Anime` and `Netflix`.
 */
export const MY_AI_INTERESTS = [
  { id: 'dancing', label: 'Dancing' },
  { id: 'gardening', label: 'Gardening' },
  { id: 'photography', label: 'Photography' },
  { id: 'painting', label: 'Painting' },
  { id: 'cooking', label: 'Cooking' },
  { id: 'reading', label: 'Reading' },
  { id: 'writing', label: 'Writing' },
  { id: 'hiking', label: 'Hiking' },
  { id: 'swimming', label: 'Swimming' },
  { id: 'yoga', label: 'Yoga' },
  { id: 'cosplay', label: 'Cosplay' },
  { id: 'cars', label: 'Cars' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'magic', label: 'Magic' },
  { id: 'gym', label: 'Gym' },
  { id: 'wine', label: 'Wine tasting' },
  { id: 'travel', label: 'Travel' },
  { id: 'anime', label: 'Anime' },
  { id: 'cycling', label: 'Cycling' },
  { id: 'netflix', label: 'Netflix' },
  { id: 'diy', label: 'DIY' },
  { id: 'comedy', label: 'Comedy' },
] as const satisfies readonly MyAiOption[];

/** At most this many interests. OH accepts more; a tile grid of 22 does not. */
export const MY_AI_MAX_INTERESTS = 3;

/**
 * The voices offered for a user-created companion.
 *
 * A SUBSET of the shared live-call catalogue, not a new list — these are real
 * values `isKnownVoice` accepts, so nothing here can be configured and then
 * rejected at call time. Only the female-presenting names are offered because
 * the flow builds a female companion; the catalogue's male voices are still
 * available to operators through Admin.
 *
 * NO INVENTED DESCRIPTIONS. The provider publishes names and samples, not
 * adjectives, and labelling one "sultry" on no evidence would be a promise the
 * audio may not keep.
 */
export const MY_AI_VOICES = [
  { id: 'Serena', label: 'Serena' },
  { id: 'Tina', label: 'Tina' },
  { id: 'Cindy', label: 'Cindy' },
  { id: 'Maia', label: 'Maia' },
  { id: 'Chloe', label: 'Chloe' },
  { id: 'Jennifer', label: 'Jennifer' },
] as const satisfies readonly MyAiOption[];

/* ------------------------------------------------------------------ *
 * Age
 * ------------------------------------------------------------------ */

/**
 * 21, not 18.
 *
 * The platform's own floor is 18 (`characters.age CHECK (age >= 18)`), but
 * OhAPI enforces 21+ server-side on create, save AND update, and returns a
 * plain `400` below it. Showing 18 here would mean either a visible age that
 * disagrees with the date of birth we send — two ages for one character, which
 * is exactly the rot the confirmed-age work exists to prevent — or a wizard
 * that fails at the last step for reasons the user cannot see.
 */
export const MY_AI_MIN_AGE = 21;
/**
 * 55 — the product's own ceiling, not the provider's.
 *
 * OhAPI accepts far higher, but the catalogue this sits beside does not go
 * there and a slider that runs to 70 spends most of its travel on ages nobody
 * picks. Narrowing it makes every position on the track a plausible choice.
 */
export const MY_AI_MAX_AGE = 55;
export const MY_AI_DEFAULT_AGE = 24;

export const MY_AI_NAME_MAX_LENGTH = 40;

/* ------------------------------------------------------------------ *
 * The draft
 * ------------------------------------------------------------------ */

/**
 * Everything the wizard collects. This is the request body of
 * `POST /api/my-ai`, and it carries ids only — never a vendor string, never a
 * URL, never a prompt. The server composes all three.
 */
export interface MyAiDraft {
  ethnicity: string;
  hairColour: string;
  hairStyle: string;
  eyeColour: string;
  figure: string;
  breasts: string;
  butt: string;
  personality: string;
  relationship: string;
  /** Pre-filled on the confirm screen; all still required by the time we post. */
  age: number;
  name: string;
  voice: string;
  job: string;
  interests: string[];
}

/**
 * A companion the signed-in user has created, as the API reports her.
 *
 * `imageUrl` is an OPAQUE, OWNER-SCOPED locator — not a storage key, not a
 * provider URL, and deliberately not the public `/api/media/assets/:id/file`
 * route the lobby uses, which serves anyone who asks. Fetching it proves the
 * caller owns her. Null while she is still being drawn.
 */
/**
 * Her look and character as OUR option ids — what gets persisted.
 *
 * Name, age and voice are deliberately NOT in here: they are columns of their
 * own because they are read and displayed on their own, while these eleven are
 * only ever used together to compose a generation request.
 */
export type MyAiAttributes = Pick<
  MyAiDraft,
  | 'ethnicity'
  | 'hairColour'
  | 'hairStyle'
  | 'eyeColour'
  | 'figure'
  | 'breasts'
  | 'butt'
  | 'personality'
  | 'relationship'
  | 'job'
  | 'interests'
>;

export type MyAiStatus = 'generating' | 'ready' | 'failed';

export interface MyAiCompanion {
  id: string;
  name: string;
  age: number;
  status: MyAiStatus;
  imageUrl: string | null;
  createdAt: string;
}

const idsOf = (options: readonly MyAiOption[]) => options.map((o) => o.id);

/** Every option list, keyed by the draft field it fills. Single-choice fields only. */
export const MY_AI_CHOICES = {
  ethnicity: MY_AI_ETHNICITIES,
  hairColour: MY_AI_HAIR_COLOURS,
  hairStyle: MY_AI_HAIR_STYLES,
  eyeColour: MY_AI_EYE_COLOURS,
  figure: MY_AI_FIGURES,
  breasts: MY_AI_BREASTS,
  butt: MY_AI_BUTTS,
  personality: MY_AI_PERSONALITIES,
  relationship: MY_AI_RELATIONSHIPS,
  voice: MY_AI_VOICES,
  job: MY_AI_JOBS,
} as const satisfies Record<string, readonly MyAiOption[]>;

export type MyAiChoiceField = keyof typeof MY_AI_CHOICES;

/**
 * Validate a draft. Returns the field names that are wrong, newest-first order
 * irrelevant — the caller decides how to present them.
 *
 * SHARED ON PURPOSE. The wizard uses it to enable Create; the route uses it to
 * refuse a hand-rolled POST. One implementation means the button and the
 * server cannot disagree about what a complete companion is.
 */
export function myAiDraftProblems(draft: Partial<MyAiDraft>): string[] {
  const problems: string[] = [];

  for (const [field, options] of Object.entries(MY_AI_CHOICES)) {
    const value = draft[field as MyAiChoiceField];
    if (typeof value !== 'string' || !idsOf(options).includes(value)) problems.push(field);
  }

  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (name.length === 0 || name.length > MY_AI_NAME_MAX_LENGTH) problems.push('name');

  // Integer, in range. A non-integer age cannot become a date of birth.
  const { age } = draft;
  if (
    typeof age !== 'number' ||
    !Number.isInteger(age) ||
    age < MY_AI_MIN_AGE ||
    age > MY_AI_MAX_AGE
  ) {
    problems.push('age');
  }

  const interests = draft.interests;
  const known = idsOf(MY_AI_INTERESTS);
  if (
    !Array.isArray(interests) ||
    interests.length > MY_AI_MAX_INTERESTS ||
    new Set(interests).size !== interests.length ||
    interests.some((i) => !known.includes(i))
  ) {
    problems.push('interests');
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Tiles
 * ------------------------------------------------------------------ */

/** The attribute steps whose tiles are photographs rather than text. */
export const MY_AI_PHOTO_FIELDS = [
  'hairColour',
  'hairStyle',
  'eyeColour',
  'figure',
  'breasts',
  'butt',
] as const;

export type MyAiPhotoField = (typeof MY_AI_PHOTO_FIELDS)[number];

/** The file stem each photo field uses on disk. `figure` is stored as `figure-*`. */
const TILE_STEM: Record<MyAiPhotoField, string> = {
  hairColour: 'hairColour',
  hairStyle: 'hairStyle',
  eyeColour: 'eyes',
  figure: 'figure',
  breasts: 'breasts',
  butt: 'butt',
};

/**
 * The tile for one option, IN THE CHOSEN ETHNICITY.
 *
 * This single function is where "the flow corresponds to the ethnicity" lives.
 * Every attribute tile after step 2 is resolved through it, so changing
 * ethnicity re-renders the whole flow by construction — there is no cache to
 * invalidate and no second code path that could keep showing the old set.
 */
export function myAiTileUrl(
  field: MyAiPhotoField,
  optionId: string,
  ethnicity: MyAiEthnicity,
): string {
  return `/create/realistic/${ethnicity}/${TILE_STEM[field]}-${optionId}.jpg`;
}

/** The step-2 tile for an ethnicity itself — the only tile not inside a set. */
export function myAiEthnicityTileUrl(ethnicity: MyAiEthnicity): string {
  return `/create/realistic/ethnicity-${ethnicity}.jpg`;
}

/* ------------------------------------------------------------------ *
 * Further photographs of a companion
 * ------------------------------------------------------------------ */

/**
 * The provider's two looks, in words a user recognises.
 *
 * `glam` is their default: an even-lit, high-end photograph. `amateur` is the
 * phone-in-the-bedroom look. It changes the result more than any wording in
 * the prompt does, which is why it is a control rather than something to be
 * typed.
 */
export const MY_AI_PHOTO_STYLES = [
  { id: 'glam', label: 'Studio' },
  { id: 'amateur', label: 'Candid' },
] as const satisfies readonly MyAiOption[];

export const MY_AI_PHOTO_PROMPT_MAX = 300;
export const MY_AI_PHOTO_PROMPT_MIN = 3;

/**
 * Starting points, not options.
 *
 * A blank box is the hardest thing in any interface to answer. These fill it
 * with something editable — one tap to get a sentence, then change any word
 * of it. They are not a menu: anything the user types is sent as typed.
 */
export const MY_AI_PHOTO_IDEAS = [
  'In a red bikini by the pool',
  'In black lingerie, on a bed',
  'Topless, in soft morning light',
  'Nude, on white sheets',
  'In a little black dress at a bar',
  'In gym clothes, at the gym',
  'In a summer dress in a park',
  'Wet, in the shower',
] as const;

/** One photograph of a companion, as the API reports her. */
export interface MyAiPhoto {
  id: string;
  /** Owner-scoped route, or null while she is still being drawn. */
  url: string | null;
  /** What the user asked for. Empty for her original portrait. */
  prompt: string;
  style: string;
  status: MyAiStatus;
  createdAt: string;
  /**
   * TRUE FOR HER ORIGINAL PORTRAIT ONLY — the one the provider drew from her
   * attributes, which every other photograph is generated from. It carries
   * the reserved id `reference` rather than a row id, because it does not
   * live in the photographs table.
   */
  isReference: boolean;
}

/** The id the original portrait answers to. Never a real row id. */
export const MY_AI_REFERENCE_PHOTO_ID = 'reference';

/**
 * Validate a request for another photograph.
 *
 * Shared, like `myAiDraftProblems`, so the button that is enabled and the
 * request that is accepted cannot disagree.
 */
export function myAiPhotoProblems(input: { prompt?: unknown; style?: unknown }): string[] {
  const problems: string[] = [];

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt.length < MY_AI_PHOTO_PROMPT_MIN || prompt.length > MY_AI_PHOTO_PROMPT_MAX) {
    problems.push('prompt');
  }

  const styles = MY_AI_PHOTO_STYLES.map((s) => s.id as string);
  if (typeof input.style !== 'string' || !styles.includes(input.style)) problems.push('style');

  return problems;
}

/* ------------------------------------------------------------------ *
 * Talking to her
 * ------------------------------------------------------------------ */

/** Long enough for anything anyone types at a companion, short enough to bound. */
export const MY_AI_MESSAGE_MAX_LENGTH = 2_000;

/** One line of a conversation with a companion, as the API reports it. */
export interface MyAiMessage {
  id: string;
  /** `user` is her owner; `character` is her. */
  sender: 'user' | 'character';
  body: string;
  createdAt: string;
}

/** Validate something typed at her. Shared, so the button and the route agree. */
export function myAiMessageProblem(body: unknown): string | null {
  if (typeof body !== 'string') return 'message';
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > MY_AI_MESSAGE_MAX_LENGTH) return 'message';
  return null;
}
