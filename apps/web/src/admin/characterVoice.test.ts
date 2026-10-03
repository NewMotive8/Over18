import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_CALL_VOICE, VOICE_CATALOGUE, isKnownVoice } from '@over18/shared';
import { NO_VOICE, voiceOptions, voicePatch, voiceSelectValue } from './characterVoice';

/**
 * The admin voice selector.
 *
 * Three things have to hold: the operator is offered exactly what the server
 * will accept, the form shows the truth about how she currently sounds, and the
 * payload says what was chosen — including the choice to have no voice at all.
 */

describe('the shared catalogue', () => {
  it('publishes 28 voices', () => {
    expect(VOICE_CATALOGUE).toHaveLength(28);
  });

  it('has no duplicates', () => {
    expect(new Set(VOICE_CATALOGUE).size).toBe(VOICE_CATALOGUE.length);
  });

  it('offers a default that is itself a catalogue voice', () => {
    expect(isKnownVoice(DEFAULT_LIVE_CALL_VOICE)).toBe(true);
    expect(DEFAULT_LIVE_CALL_VOICE).toBe('Serena');
  });

  /** These are provider identifiers, so a near miss is a miss. */
  it('matches exactly, case included', () => {
    expect(isKnownVoice('Serena')).toBe(true);
    expect(isKnownVoice('serena')).toBe(false);
    expect(isKnownVoice('SERENA')).toBe(false);
    expect(isKnownVoice(' Serena')).toBe(false);
    expect(isKnownVoice('Bob')).toBe(false);
    expect(isKnownVoice(null)).toBe(false);
    expect(isKnownVoice(42)).toBe(false);
  });
});

describe('the options offered', () => {
  it('offers every catalogue voice plus the default', () => {
    const options = voiceOptions();
    expect(options).toHaveLength(VOICE_CATALOGUE.length + 1);
    for (const voice of VOICE_CATALOGUE) {
      expect(options.map((o) => o.value), voice).toContain(voice);
    }
  });

  /**
   * NAMED, NOT BLANK. An empty first row would read as "no voice at all"; she
   * always has one, and this says which.
   */
  it('leads with an explicit Default (Serena)', () => {
    const [first] = voiceOptions();
    expect(first?.value).toBe(NO_VOICE);
    expect(first?.label).toBe('Default (Serena)');
  });

  it('offers nothing the server would refuse', () => {
    for (const option of voiceOptions()) {
      if (option.value === NO_VOICE) continue;
      expect(isKnownVoice(option.value), option.value).toBe(true);
    }
  });
});

describe('which option a stored value selects', () => {
  it('selects the stored voice', () => {
    expect(voiceSelectValue('Hana')).toBe('Hana');
    expect(voiceSelectValue('Liora Mira')).toBe('Liora Mira');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('selects the default for %s', (_label, stored) => {
    expect(voiceSelectValue(stored)).toBe(NO_VOICE);
  });

  /**
   * A value the provider no longer offers resolves to the default at call time,
   * so the form shows the default too — it reports how she will actually sound,
   * not what a stale row says.
   */
  it('selects the default for a voice the catalogue does not have', () => {
    expect(voiceSelectValue('Bob')).toBe(NO_VOICE);
    expect(voiceSelectValue('serena')).toBe(NO_VOICE);
  });
});

describe('what the save sends', () => {
  it('sends the chosen voice', () => {
    expect(voicePatch('Hana')).toEqual({ liveCallVoice: 'Hana' });
  });

  /** Null, not '': null is what clears the column and restores the fallback. */
  it('sends null for the default option', () => {
    expect(voicePatch(NO_VOICE)).toEqual({ liveCallVoice: null });
  });

  it('round-trips every catalogue voice', () => {
    for (const voice of VOICE_CATALOGUE) {
      expect(voicePatch(voiceSelectValue(voice)), voice).toEqual({ liveCallVoice: voice });
    }
  });
});
