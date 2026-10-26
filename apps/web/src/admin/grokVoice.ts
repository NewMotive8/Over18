import {
  DEFAULT_GROK_VOICE,
  GROK_VOICE_CATALOGUE,
  GROK_VOICE_DESCRIPTIONS,
  isKnownGrokVoice,
} from '@over18/shared';

/**
 * The Grok tab's options and payload, React-free.
 *
 * Same reason `characterVoice.ts` is a module and not inline JSX: the web test
 * environment is node with no DOM, so logic written inside a component is logic
 * no test can reach. The things worth getting right -- which option is
 * selected, what a patch carries, and which provider's settings a patch
 * touches -- are therefore all out here.
 */

/** The blank option's value. A `<select>` cannot carry null, so it carries ''. */
export const NO_GROK_VOICE = '';

export interface GrokVoiceOption {
  value: string;
  label: string;
  /** Whether a cached sample exists, so the UI knows where Play works. */
  hasSample: boolean;
}

/**
 * Every option the Grok selector offers.
 *
 * THE FIRST OPTION IS NOT "NOTHING". Leaving it unset does not silence her --
 * it means her SpicyAPI voice is mapped across, which is what every character
 * does today. Naming that explicitly stops an operator reading the blank as a
 * missing setting they have to fill in before she can be called.
 */
export function grokVoiceOptions(
  samples: ReadonlyArray<{ id: string; hasSample: boolean }> = [],
): GrokVoiceOption[] {
  const withSample = new Set(samples.filter((s) => s.hasSample).map((s) => s.id.toLowerCase()));
  return [
    { value: NO_GROK_VOICE, label: 'Match her SpicyAPI voice (default)', hasSample: false },
    ...GROK_VOICE_CATALOGUE.map((voice) => ({
      value: voice,
      label: `${voice} — ${GROK_VOICE_DESCRIPTIONS[voice]}`,
      hasSample: withSample.has(voice),
    })),
  ];
}

/**
 * Which option is selected for a stored value.
 *
 * An unrecognised stored value selects the fallback option rather than adding a
 * phantom entry: it is what the server will fall back to anyway, so the form
 * shows the truth about how she will actually sound.
 */
export function grokVoiceSelectValue(stored: string | null | undefined): string {
  if (typeof stored !== 'string' || stored.trim().length === 0) return NO_GROK_VOICE;
  return isKnownGrokVoice(stored) ? stored.trim().toLowerCase() : NO_GROK_VOICE;
}

/** Where a cached sample is served from. Null when there is none to play. */
export function grokSampleUrl(apiUrl: string, voice: string, hasSample: boolean): string | null {
  if (!hasSample || !isKnownGrokVoice(voice)) return null;
  return `${apiUrl}/admin/voice/samples/${encodeURIComponent(voice.trim().toLowerCase())}`;
}

/**
 * Speaking styles offered as a choice rather than a blank box.
 *
 * EACH ONE IS A SENTENCE THAT GOES INTO HER PROMPT, and is written as one, so
 * what an operator picks is literally what she is told. None of them claims a
 * pace, pitch or warmth control: xAI exposes no such parameters on a realtime
 * call, and a selector that implied otherwise would be promising something the
 * product cannot deliver.
 */
export const GROK_SPEAKING_STYLES: ReadonlyArray<{ key: string; label: string; text: string }> = [
  {
    key: 'warm',
    label: 'Warm and unhurried',
    text: 'She speaks warmly and takes her time, leaving room between thoughts rather than filling every pause.',
  },
  {
    key: 'playful',
    label: 'Playful and teasing',
    text: 'She is playful on the phone, teases easily, and lets herself laugh mid-sentence.',
  },
  {
    key: 'direct',
    label: 'Direct and dry',
    text: 'She is direct and dry on a call, says the short version first, and does not pad an answer.',
  },
  {
    key: 'soft',
    label: 'Soft and close',
    text: 'She speaks softly and close to the microphone, as though the room is quiet and it is late.',
  },
];

/** The sentinel for "I will write my own", which keeps the free text. */
export const CUSTOM_GROK_STYLE = '__custom__';

/** Which preset a stored sentence corresponds to, or the custom sentinel. */
export function grokStyleKeyOf(stored: string | null | undefined): string {
  const text = (stored ?? '').trim();
  if (text.length === 0) return '';
  const preset = GROK_SPEAKING_STYLES.find((style) => style.text === text);
  return preset ? preset.key : CUSTOM_GROK_STYLE;
}

/** The sentence a chosen key stores. Null for the blank option. */
export function grokStyleTextOf(key: string): string | null {
  if (key === '' ) return null;
  if (key === CUSTOM_GROK_STYLE) return null;
  return GROK_SPEAKING_STYLES.find((style) => style.key === key)?.text ?? null;
}

/**
 * What a save from the GROK tab carries.
 *
 * ONLY GROK FIELDS. The SpicyAPI values are not included, so a patch from this
 * tab cannot overwrite them -- `undefined` means "leave alone" all the way down
 * to the server. That is the whole mechanism keeping the two independent;
 * there is no copying step that could go wrong.
 */
export function grokVoicePatch(input: {
  voice: string;
  speakingStyle: string;
  callInstructions: string;
}): { grokVoice: string | null; grokSpeakingStyle: string | null; grokCallInstructions: string | null } {
  return {
    grokVoice: input.voice === NO_GROK_VOICE ? null : input.voice,
    grokSpeakingStyle: input.speakingStyle.trim().length === 0 ? null : input.speakingStyle.trim(),
    grokCallInstructions:
      input.callInstructions.trim().length === 0 ? null : input.callInstructions.trim(),
  };
}

/** The label a tab shows, from the server's answer rather than a constant. */
export function providerTabLabel(provider: string, tab: 'grok' | 'spicyapi'): string {
  const name = tab === 'grok' ? 'Grok' : 'SpicyAPI';
  return `${name} ${provider === tab ? '(Active)' : '(Saved)'}`;
}

/** Her effective Grok voice, for showing what an unset character will use. */
export function effectiveGrokVoice(
  grokVoice: string | null | undefined,
  spicyVoice: string | null | undefined,
  mapping: Readonly<Record<string, string>>,
): string {
  const explicit = grokVoiceSelectValue(grokVoice);
  if (explicit !== NO_GROK_VOICE) return explicit;
  const mapped = spicyVoice ? mapping[spicyVoice] : undefined;
  return mapped ?? DEFAULT_GROK_VOICE;
}
