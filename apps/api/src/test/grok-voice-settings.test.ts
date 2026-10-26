import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GROK_VOICE_CATALOGUE,
  GROK_VOICE_DESCRIPTIONS,
  GROK_VOICE_SAMPLE_TEXT,
  DEFAULT_GROK_VOICE,
  isKnownGrokVoice,
  VOICE_CATALOGUE,
} from '@over18/shared';
import { resolveGrokVoice } from '../voice/grok.js';
import {
  generateMissingVoiceSamples,
  hasVoiceSample,
  voiceSamplePath,
} from '../voice/grok-voice-samples.js';

/**
 * TWO PROVIDERS, TWO SETS OF SETTINGS, ONE CHARACTER.
 *
 * Grok is active and SpicyAPI is kept for rollback, so the settings cannot be
 * one field that gets rewritten: switching `VOICE_LLM_PROVIDER` back has to
 * restore the old behaviour exactly, and that only holds if nothing ever
 * overwrote the SpicyAPI values. These pin the separation, the fallbacks that
 * keep existing characters working untouched, and the sample cache.
 */

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the Grok voice catalogue', () => {
  /** Verified against GET /v1/tts/voices on 2026-10-25: exactly these 28. */
  it('has 28 voices, every one described', () => {
    expect(GROK_VOICE_CATALOGUE).toHaveLength(28);
    for (const voice of GROK_VOICE_CATALOGUE) {
      expect(GROK_VOICE_DESCRIPTIONS[voice], voice).toBeTruthy();
    }
  });

  it('is case-insensitive, unlike the SpicyAPI one', () => {
    expect(isKnownGrokVoice('EVE')).toBe(true);
    expect(isKnownGrokVoice(' Aurora ')).toBe(true);
    expect(isKnownGrokVoice('nope')).toBe(false);
    expect(isKnownGrokVoice(null)).toBe(false);
  });

  /** The two rosters are different vendors' and must not be confused. */
  it('shares no id with the SpicyAPI catalogue', () => {
    const spicy = new Set((VOICE_CATALOGUE as readonly string[]).map((v) => v.toLowerCase()));
    for (const voice of GROK_VOICE_CATALOGUE) expect(spicy.has(voice), voice).toBe(false);
  });
});

describe('which voice a call uses', () => {
  /**
   * THE FALLBACK THAT KEEPS EXISTING CHARACTERS WORKING. Nobody has chosen a
   * Grok voice yet, so her SpicyAPI voice is mapped -- which is exactly what
   * happens today, and why this change is inert until an operator acts.
   */
  it('maps her SpicyAPI voice when no Grok voice is chosen', () => {
    expect(resolveGrokVoice('Katerina')).toBe('iris');
    expect(resolveGrokVoice('Serena')).toBe('eve');
    expect(resolveGrokVoice('Zane')).toBe('rex');
  });

  /** An explicit choice is used DIRECTLY, never run through the mapping. */
  it('passes an explicitly chosen Grok voice straight through', () => {
    for (const voice of GROK_VOICE_CATALOGUE) {
      expect(resolveGrokVoice(voice), voice).toBe(voice);
    }
    expect(resolveGrokVoice('AURORA')).toBe('aurora');
  });

  it('falls back to the default rather than failing on an unknown value', () => {
    expect(resolveGrokVoice('a-retired-voice')).toBe(DEFAULT_GROK_VOICE);
    expect(resolveGrokVoice(null)).toBe(DEFAULT_GROK_VOICE);
  });
});

describe('the call path reads only the active provider', () => {
  const call = source('../services/call-session-service.ts');

  it('uses the Grok voice only under Grok, and her SpicyAPI voice otherwise', () => {
    expect(call).toContain("deps.provider.name === GROK_PROVIDER && characterRow.grokVoice");
    expect(call).toContain('resolveVoice(characterRow.liveCallVoice)');
  });

  /**
   * Keyed off the SESSION ROW, not the current environment: a call settles
   * with the provider it was created under even if the variable changes while
   * it is in flight.
   */
  it('decides the speaking style from the row provider', () => {
    expect(call).toContain('const usingGrok = row.provider === GROK_PROVIDER;');
    expect(call).toContain('characterRow.grokSpeakingStyle ?? characterRow.conversationStyle');
    expect(call).toContain('usingGrok ? characterRow.grokCallInstructions : null');
  });

  /** Under SpicyAPI the Grok columns are not consulted at all. */
  it('leaves conversationStyle as the SpicyAPI path, untouched', () => {
    expect(call).toContain(': characterRow.conversationStyle;');
  });
});

describe('editing one provider never overwrites the other', () => {
  const service = source('../services/character-service.ts');

  /**
   * `undefined` means "leave alone" for every one of these, so a PATCH from
   * the Grok tab omits the SpicyAPI fields and cannot clear them -- and the
   * reverse. That contract is the whole mechanism; there is no copying step
   * to get wrong.
   */
  it('treats every voice field as independently optional', () => {
    for (const field of [
      'liveCallVoice',
      'grokVoice',
      'grokSpeakingStyle',
      'grokCallInstructions',
    ]) {
      expect(service, field).toContain(`${field}?: string | null;`);
    }
  });

  it('validates the Grok voice against the Grok roster, not the SpicyAPI one', () => {
    expect(service).toContain('isKnownGrokVoice(trimmed)');
    expect(service).toContain('Choose a voice from the published Grok catalogue.');
  });

  /** Style and instructions are prompt text, so they are bounded, not free. */
  it('bounds the speaking style and the extra instruction', () => {
    expect(service).toContain('GROK_INSTRUCTION_MAX_CHARS');
  });
});

describe('cached voice samples', () => {
  /**
   * A FRESH DIRECTORY PER RUN. The cache test asserts "generated 28, then
   * skipped 28", which is only true starting from empty -- a leftover from a
   * previous run would make the first pass skip and the assertion lie about
   * what happened.
   */
  const tmp = { mediaDir: join(tmpdir(), `over18-voice-samples-${randomUUID()}`) };
  afterAll(async () => {
    await rm(tmp.mediaDir, { recursive: true, force: true });
  });

  it('stores one lower-cased mp3 per voice under the media volume', () => {
    expect(voiceSamplePath(tmp, 'Aurora')).toBe(voiceSamplePath(tmp, 'aurora'));
    expect(voiceSamplePath(tmp, 'eve').endsWith('eve.mp3')).toBe(true);
    expect(voiceSamplePath(tmp, 'eve').includes('voice-samples')).toBe(true);
  });

  it('reports no sample for an unknown voice rather than guessing a path', () => {
    expect(hasVoiceSample(tmp, 'not-a-voice')).toBe(false);
  });

  /**
   * NEVER REGENERATED AUTOMATICALLY. A second run must bill nothing, which is
   * what makes it safe to leave the script in the repository.
   */
  it('skips every voice that already has a file, calling the API for none', async () => {
    let calls = 0;
    const result = await generateMissingVoiceSamples({
      apiKey: 'test',
      storage: tmp,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }) as unknown as typeof fetch,
      // No files exist in the fixture dir, so this generates all 28...
    });
    expect(result.generated.length + result.failed.length).toBe(28);
    expect(calls).toBe(28);

    // ...and a second pass, with those files now present, calls nothing.
    let secondPassCalls = 0;
    const again = await generateMissingVoiceSamples({
      apiKey: 'test',
      storage: tmp,
      fetchImpl: (async () => {
        secondPassCalls += 1;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(secondPassCalls).toBe(0);
    expect(again.skipped).toHaveLength(28);
    expect(again.generated).toHaveLength(0);
  });

  it('uses one neutral sentence for every voice, shared with the player', () => {
    expect(GROK_VOICE_SAMPLE_TEXT).toContain('this is how I sound');
    // Short: the whole set is billed by the character.
    expect(GROK_VOICE_SAMPLE_TEXT.length).toBeLessThan(120);
  });

  it('reports a per-voice failure without stopping the rest', async () => {
    const result = await generateMissingVoiceSamples({
      apiKey: 'test',
      storage: { mediaDir: join(tmpdir(), `over18-voice-fail-${randomUUID()}`) },
      force: true,
      fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    });
    expect(result.generated).toHaveLength(0);
    expect(result.failed).toHaveLength(28);
    // Status only -- a body could echo the request back into a log.
    expect(result.failed[0]!.reason).toBe('HTTP 503');
  });
});
