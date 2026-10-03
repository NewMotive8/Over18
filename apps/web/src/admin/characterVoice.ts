import { DEFAULT_LIVE_CALL_VOICE, VOICE_CATALOGUE } from '@over18/shared';

/**
 * The admin voice selector's options and payload, React-free.
 *
 * WHY THIS IS A MODULE AND NOT INLINE JSX. The web test environment is node
 * with no DOM and no events (see apps/web/vitest.config.ts), so logic written
 * inside a component is logic no test can reach -- the lesson `characterForm.ts`
 * was extracted for, after a bug shipped in exactly that blind spot. The three
 * things worth getting right here (the option list, which option is selected,
 * and what gets sent) are therefore all out here.
 *
 * THE LIST COMES FROM THE SHARED CATALOGUE, which is the same constant the
 * server validates against. Neither side can offer or accept a voice the other
 * does not know.
 */

/** The blank option's value. A `<select>` cannot carry null, so it carries ''. */
export const NO_VOICE = '';

export interface VoiceOption {
  value: string;
  label: string;
}

/**
 * Every option the selector offers: the explicit default first, then the
 * catalogue in published order.
 *
 * "Default (Serena)" IS AN OPTION, NOT AN ABSENCE. Without it an operator could
 * assign a voice and never take it back -- a one-way door escapable only with
 * database access. Naming the fallback also stops it reading as "no voice at
 * all", which is what an empty row would imply; she always has a voice, and
 * this says which.
 */
export function voiceOptions(): VoiceOption[] {
  return [
    { value: NO_VOICE, label: `Default (${DEFAULT_LIVE_CALL_VOICE})` },
    ...VOICE_CATALOGUE.map((voice) => ({ value: voice, label: voice })),
  ];
}

/**
 * Which option is selected for a stored value.
 *
 * An unrecognised stored value selects the default option rather than silently
 * adding a phantom entry -- it is what the server will fall back to anyway, so
 * the form shows the truth about how she will actually sound.
 */
export function voiceSelectValue(stored: string | null | undefined): string {
  if (typeof stored !== 'string' || stored.length === 0) return NO_VOICE;
  return (VOICE_CATALOGUE as readonly string[]).includes(stored) ? stored : NO_VOICE;
}

/**
 * What the PATCH carries for a chosen option.
 *
 * The blank option sends `null`, not `''`: null is what clears the column, and
 * it is the value the existing Serena fallback already understands.
 */
export function voicePatch(selected: string): { liveCallVoice: string | null } {
  return { liveCallVoice: selected === NO_VOICE ? null : selected };
}
