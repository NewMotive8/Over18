/**
 * The live-call voices SpicyAPI publishes, and the rule for choosing one.
 *
 * WHY A SERVER-SIDE LIST AT ALL. `voice` is a provider parameter, so an
 * arbitrary string from a browser would be forwarded to a paid API and would
 * either fail the session or, worse, silently pick something nobody intended.
 * The catalogue is the allowlist, and the browser never supplies a voice in any
 * case -- it is resolved from the character.
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

/**
 * The voice to use for a character.
 *
 * FALLS BACK RATHER THAN FAILING. A stored voice that the provider has since
 * retired would otherwise make that character uncallable, and a silent
 * substitution is a far better outcome than a broken call. Validation that
 * REFUSES belongs at the point an operator sets the value -- which is the admin
 * surface, and out of scope for this phase.
 */
export function resolveVoice(configured: string | null | undefined): LiveCallVoice {
  return isKnownVoice(configured) ? configured : DEFAULT_LIVE_CALL_VOICE;
}
