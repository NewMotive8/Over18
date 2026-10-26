/**
 * The live-call voices SpicyAPI publishes, and what counts as one of them.
 *
 * ── WHY THIS IS SHARED AND NOT THE API'S ALONE ───────────────────────────────
 *
 * It lived in `apps/api/src/voice/voice-catalogue.ts`, which the web app cannot
 * import -- separate workspaces, and the browser only ever sees
 * `@over18/shared`. An admin choosing a character's voice needs the same list
 * the server validates against, and the two ways to achieve that are to publish
 * the list here or to serve it from an endpoint. A compile-time constant does
 * not need a fetch, a loading state and an error path, so it lives here and
 * both sides read the one list. They cannot drift.
 *
 * WHAT DID NOT MOVE: `resolveVoice`. Choosing a voice for a call is server
 * behaviour, it belongs beside the provider adapter, and the browser has no
 * business performing it -- the web never supplies a voice in any case.
 *
 * TRANSCRIBED FROM THE PUBLISHED CATALOGUE, not invented. One caveat is
 * recorded rather than guessed at: the documentation lists `Liora Mira` as a
 * single entry, which may be a typesetting artefact for two voices, `Liora` and
 * `Mira`. It is kept exactly as published. Splitting it would be inventing a
 * voice name, and a character configured to a name the provider does not offer
 * falls back to the default anyway.
 */
export const VOICE_CATALOGUE = [
  'Tina',
  'Cindy',
  'Liora Mira',
  'Serena',
  'Maia',
  'Mia',
  'Katerina',
  'Jennifer',
  'Sonrisa',
  'Hana',
  'Griet',
  'Sigga',
  'Bea',
  'Chloe',
  'Kiki',
  'Sohee',
  'Zane',
  'Ryan',
  'Raymond',
  'Theo Calm',
  'Aiden',
  'Andre',
  'Dolce',
  'Bodega',
  'Jakub',
  'Alek',
  'Emilien',
  'Evan',
] as const;

export type LiveCallVoice = (typeof VOICE_CATALOGUE)[number];

/** The voice a character speaks with when none is configured. */
export const DEFAULT_LIVE_CALL_VOICE: LiveCallVoice = 'Serena';

const CATALOGUE = new Set<string>(VOICE_CATALOGUE);

/** Exact-match membership. Case matters: these are provider identifiers. */
export function isKnownVoice(value: unknown): value is LiveCallVoice {
  return typeof value === 'string' && CATALOGUE.has(value);
}

/* ------------------------------------------------------------------ *
 * Grok
 * ------------------------------------------------------------------ */

/**
 * The Grok voice roster, and the one-line character xAI publishes for each.
 *
 * ── WHY IT MOVED HERE FROM `apps/api/src/voice/grok.ts` ──────────────────────
 *
 * The same reason `VOICE_CATALOGUE` moved: an admin choosing a Grok voice needs
 * the list the server validates against, and the browser can only see
 * `@over18/shared`. The adapter still owns everything about PLACING a call --
 * the mapping from a SpicyAPI voice, the session frame, the default. It just no
 * longer owns the list.
 *
 * VERIFIED AGAINST THE LIVE API, not transcribed and hoped for:
 * `GET /v1/tts/voices` returned exactly these 28 ids on 2026-10-25, with no
 * voice missing and none unknown. The descriptions are xAI's own words from the
 * published voice table, kept so an operator has something to choose BY before
 * pressing play.
 *
 * IDS ARE LOWER-CASE because xAI documents them as case-insensitive, unlike
 * SpicyAPI's, where case matters. `isKnownGrokVoice` lowercases before testing.
 */
export const GROK_VOICE_CATALOGUE = [
  'ara', 'eve', 'leo', 'rex', 'sal', 'altair', 'atlas', 'aurora',
  'carina', 'castor', 'celeste', 'cosmo', 'helios', 'helix', 'iris', 'kepler',
  'liora', 'lumen', 'luna', 'lux', 'naksh', 'orion', 'perseus', 'rigel',
  'sirius', 'ursa', 'zagan', 'zenith',
] as const;

export type GrokVoice = (typeof GROK_VOICE_CATALOGUE)[number];

/** The Grok voice used when a character has none and none can be mapped. */
export const DEFAULT_GROK_VOICE: GrokVoice = 'eve';

const GROK_CATALOGUE = new Set<string>(GROK_VOICE_CATALOGUE);

/** Case-insensitive membership — xAI's ids are documented as such. */
export function isKnownGrokVoice(value: unknown): value is GrokVoice {
  return typeof value === 'string' && GROK_CATALOGUE.has(value.trim().toLowerCase());
}

/** xAI's own one-line description of each voice, for the selector. */
export const GROK_VOICE_DESCRIPTIONS: Readonly<Record<GrokVoice, string>> = {
  ara: 'Warm and friendly',
  eve: 'Energetic and upbeat — British accent',
  leo: 'Authoritative and strong — British accent',
  rex: 'Confident and clear',
  sal: 'Smooth and balanced',
  altair: 'Elegant, refined, and effortlessly premium',
  atlas: 'Confident, commanding, and reassuring',
  aurora: 'Serene, steady, and radiant',
  carina: 'Soft, empathetic, and soothing',
  castor: 'Charismatic, down-to-earth, and easygoing',
  celeste: 'Compassionate, confident, and reassuring',
  cosmo: 'Bright, curious, and easy to follow',
  helios: 'Upbeat, energetic, and endlessly versatile',
  helix: 'Bold, dynamic, and adrenaline-fueled',
  iris: 'Friendly, upbeat, and naturally charming',
  kepler: 'Inventive, forward-thinking, and charismatic',
  liora: 'Calm, grounded, and luminous',
  lumen: 'Warm, articulate, and engaging',
  luna: 'Gentle, patient, and deeply nurturing',
  lux: 'Grounded, calm, and quietly wise',
  naksh: 'Warm, thoughtful, and wise — Indian accent',
  orion: 'Rich, cinematic, and resonant',
  perseus: 'Strong, confident, and trustworthy',
  rigel: 'Precise, professional, and calmly confident — Australian accent',
  sirius: 'Quick-witted, clever, and playful',
  ursa: 'Friendly, warm, and steadfast',
  zagan: 'Powerful, dramatic, and unmistakable',
  zenith: 'Sharp, focused, and driven',
};

/**
 * The one sentence every cached sample says.
 *
 * Shared so the generator and the player cannot disagree about what an operator
 * is listening to, and neutral so the comparison is between VOICES rather than
 * between scripts.
 */
export const GROK_VOICE_SAMPLE_TEXT =
  "Hi, this is how I sound. Tell me what you'd like to talk about.";
