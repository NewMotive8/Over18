import {
  DEFAULT_LIVE_CALL_VOICE,
  VOICE_CATALOGUE,
  isKnownVoice,
  type LiveCallVoice,
} from '@over18/shared';

/**
 * The live-call voice catalogue, and the rule for choosing one.
 *
 * ── THE LIST ITSELF NOW LIVES IN `@over18/shared` ────────────────────────────
 *
 * It moved so the admin voice selector can offer exactly the values this file
 * validates against; the web app cannot import from `apps/api`. Everything is
 * re-exported here unchanged, so every existing importer of this module keeps
 * working and nothing about the provider request changes.
 *
 * WHY A SERVER-SIDE LIST AT ALL. `voice` is a provider parameter, so an
 * arbitrary string from a browser would be forwarded to a paid API and would
 * either fail the session or, worse, silently pick something nobody intended.
 * The catalogue is the allowlist, and the browser never supplies a voice in any
 * case -- it is resolved from the character.
 */
export { VOICE_CATALOGUE, DEFAULT_LIVE_CALL_VOICE, isKnownVoice };
export type { LiveCallVoice };

/**
 * The voice to use for a character.
 *
 * UNCHANGED, AND DELIBERATELY SO. It stays here rather than moving to the
 * shared package: choosing a voice for a call is server behaviour that belongs
 * beside the provider adapter, and the browser has no business performing it.
 *
 * FALLS BACK RATHER THAN FAILING. A stored voice that the provider has since
 * retired would otherwise make that character uncallable, and a silent
 * substitution is a far better outcome than a broken call. Validation that
 * REFUSES belongs at the point an operator sets the value -- which is the admin
 * surface, and is `normalise` in character-service.ts.
 */
export function resolveVoice(configured: string | null | undefined): LiveCallVoice {
  return isKnownVoice(configured) ? configured : DEFAULT_LIVE_CALL_VOICE;
}
