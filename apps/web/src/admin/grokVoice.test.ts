import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GROK_VOICE_CATALOGUE, VOICE_CATALOGUE } from '@over18/shared';
import {
  CUSTOM_GROK_STYLE,
  GROK_SPEAKING_STYLES,
  NO_GROK_VOICE,
  effectiveGrokVoice,
  grokSampleUrl,
  grokStyleKeyOf,
  grokStyleTextOf,
  grokVoiceOptions,
  grokVoicePatch,
  grokVoiceSelectValue,
  providerTabLabel,
} from './grokVoice';

/**
 * TWO PROVIDERS THAT MUST NOT TOUCH EACH OTHER.
 *
 * Grok is active and SpicyAPI is kept so a rollback is one environment
 * variable. That only holds if editing one never writes the other's values,
 * and if the tabs describe configuration rather than deciding it.
 */

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the Grok voice selector', () => {
  it('offers every catalogue voice plus an explicit fallback option', () => {
    const options = grokVoiceOptions();
    expect(options).toHaveLength(GROK_VOICE_CATALOGUE.length + 1);
    expect(options[0]!.value).toBe(NO_GROK_VOICE);
    // The blank is not "no voice" -- it is "use the mapping", and says so.
    expect(options[0]!.label).toMatch(/SpicyAPI/i);
  });

  it('marks Play only where a cached sample exists', () => {
    const options = grokVoiceOptions([
      { id: 'eve', hasSample: true },
      { id: 'aurora', hasSample: false },
    ]);
    expect(options.find((o) => o.value === 'eve')!.hasSample).toBe(true);
    expect(options.find((o) => o.value === 'aurora')!.hasSample).toBe(false);
  });

  /** A voice with no sample must stay choosable. */
  it('gives no sample URL without a sample, and a real one with', () => {
    expect(grokSampleUrl('https://api', 'aurora', false)).toBeNull();
    expect(grokSampleUrl('https://api', 'aurora', true)).toBe(
      'https://api/admin/voice/samples/aurora',
    );
    // Unknown voices never produce a URL, whatever the flag says.
    expect(grokSampleUrl('https://api', 'not-a-voice', true)).toBeNull();
  });

  it('selects the fallback option for an unknown or empty stored value', () => {
    expect(grokVoiceSelectValue(null)).toBe(NO_GROK_VOICE);
    expect(grokVoiceSelectValue('')).toBe(NO_GROK_VOICE);
    expect(grokVoiceSelectValue('retired-voice')).toBe(NO_GROK_VOICE);
    expect(grokVoiceSelectValue('AURORA')).toBe('aurora');
  });
});

describe('which voice she actually gets', () => {
  const mapping = { Katerina: 'iris', Serena: 'eve' };

  /** Explicit beats mapped -- requirement: once chosen, use it directly. */
  it('uses an explicit Grok voice over the mapped one', () => {
    expect(effectiveGrokVoice('luna', 'Katerina', mapping)).toBe('luna');
  });

  /** Unset keeps today's behaviour, which is why nobody must reconfigure. */
  it('falls back to the mapped SpicyAPI voice, then the default', () => {
    expect(effectiveGrokVoice(null, 'Katerina', mapping)).toBe('iris');
    expect(effectiveGrokVoice(null, null, mapping)).toBe('eve');
    expect(effectiveGrokVoice(null, 'Unmapped', mapping)).toBe('eve');
  });
});

describe('speaking styles are sentences, not audio controls', () => {
  it('stores the preset sentence a label stands for', () => {
    for (const style of GROK_SPEAKING_STYLES) {
      expect(grokStyleTextOf(style.key)).toBe(style.text);
      expect(grokStyleKeyOf(style.text)).toBe(style.key);
    }
  });

  it('treats an unrecognised sentence as a custom one, keeping the text', () => {
    expect(grokStyleKeyOf('Something an operator typed.')).toBe(CUSTOM_GROK_STYLE);
    expect(grokStyleKeyOf('')).toBe('');
    expect(grokStyleKeyOf(null)).toBe('');
  });

  /**
   * NOTHING HERE PROMISES A KNOB THE API DOES NOT HAVE. xAI exposes no pace,
   * pitch, speed or volume control on a realtime call, so a style that named
   * one would be a promise the product cannot keep.
   */
  it('claims no pace, pitch, speed or volume control', () => {
    const words = /\b(pitch|speed|volume|tempo|bitrate|sample rate)\b/i;
    for (const style of GROK_SPEAKING_STYLES) {
      expect(style.text, style.key).not.toMatch(words);
      expect(style.label, style.key).not.toMatch(words);
    }
  });
});

describe('saving one provider never writes the other', () => {
  /**
   * The patch from the Grok tab carries ONLY Grok fields. The SpicyAPI
   * columns are absent, and absent means "leave alone" all the way to the
   * database -- there is no copy step that could go wrong.
   */
  it('carries only Grok fields', () => {
    const patch = grokVoicePatch({
      voice: 'luna',
      speakingStyle: 'She speaks softly.',
      callInstructions: '',
    });
    expect(Object.keys(patch).sort()).toEqual([
      'grokCallInstructions',
      'grokSpeakingStyle',
      'grokVoice',
    ]);
    expect(patch).not.toHaveProperty('liveCallVoice');
    expect(patch).not.toHaveProperty('conversationStyle');
  });

  it('sends null to clear, never an empty string', () => {
    const patch = grokVoicePatch({ voice: NO_GROK_VOICE, speakingStyle: '  ', callInstructions: '' });
    expect(patch.grokVoice).toBeNull();
    expect(patch.grokSpeakingStyle).toBeNull();
    expect(patch.grokCallInstructions).toBeNull();
  });

  it('keeps the two rosters apart', () => {
    const spicy = new Set((VOICE_CATALOGUE as readonly string[]).map((v) => v.toLowerCase()));
    for (const voice of GROK_VOICE_CATALOGUE) expect(spicy.has(voice), voice).toBe(false);
  });
});

describe('the tab labels follow configuration, not the tab', () => {
  it('marks whichever provider the SERVER says is active', () => {
    expect(providerTabLabel('grok', 'grok')).toBe('Grok (Active)');
    expect(providerTabLabel('grok', 'spicyapi')).toBe('SpicyAPI (Saved)');
    // Rolled back: the same component relabels, with no release.
    expect(providerTabLabel('spicyapi', 'spicyapi')).toBe('SpicyAPI (Active)');
    expect(providerTabLabel('spicyapi', 'grok')).toBe('Grok (Saved)');
  });

  /**
   * THE ACTIVE PROVIDER IS NEVER A CONSTANT IN THE BROWSER. If it were, a
   * rollback would need a release to tell the truth.
   */
  it('reads the active provider from the server, and no tab click changes it', () => {
    const page = source('../pages/admin/AdminCharacterDetailPage.tsx');
    expect(page).toContain('voiceSettings?.activeProvider');
    expect(page).toContain('adminVoiceApi');
    // setVoiceTab only ever sets the tab.
    expect(page).toContain('onClick={() => setVoiceTab(tab)}');
    expect(page).not.toMatch(/setVoiceTab\([^)]*\)\s*;\s*\n?\s*set(Active|Provider)/);
  });

  /** Each tab seeds from its own columns, so neither can display the other's. */
  it('seeds each provider from its own stored fields', () => {
    const page = source('../pages/admin/AdminCharacterDetailPage.tsx');
    expect(page).toContain('voiceSelectValue(next.character.liveCallVoice)');
    expect(page).toContain('grokVoiceSelectValue(next.character.grokVoice)');
    expect(page).toContain('next.character.grokSpeakingStyle');
    expect(page).toContain('next.character.grokCallInstructions');
  });
});
