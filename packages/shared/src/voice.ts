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
