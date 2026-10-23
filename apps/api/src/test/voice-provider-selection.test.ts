import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, VOICE_LLM_PROVIDERS, type Env } from '../env.js';

/**
 * WHICH PROVIDER PLACES A CALL, AND WHAT MUST NOT MOVE WITH IT.
 *
 * The failure these exist to prevent is a provider swap nobody can see. For
 * chat, a silent fall back meant replies came from a model nobody chose; for
 * voice it is worse, because a call costs money per minute and the only symptom
 * of the wrong provider is that she sounds slightly different -- which nobody
 * files as a bug.
 *
 * So: unset means SpicyAPI exactly as before, a named provider must be complete
 * or the process dies, and selecting one reaches neither chat nor persona
 * generation.
 */

const ORIGINAL = process.env;

const baseVars = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/over18_test',
  LLM_BASE_URL: 'https://api.x.ai/v1',
  LLM_MODEL: 'grok-4.20-0309-non-reasoning',
  LLM_API_KEY: 'llm-key',
};

const VOICE_VARS = [
  'VOICE_LLM_PROVIDER',
  'SPICYAPI_API_KEY',
  'VOICE_GROK_API_KEY',
  'VOICE_GROK_MODEL',
  'VOICE_GROK_DEFAULT_VOICE',
  'XAI_API_KEY',
  'VOICE_MAX_SECONDS',
  'CHAT_LLM_PROVIDER',
  'PERSONA_VISION_MODEL',
] as const;

const load = (extra: Record<string, string> = {}): Env => {
  process.env = { ...ORIGINAL, ...baseVars, ...extra } as NodeJS.ProcessEnv;
  for (const key of VOICE_VARS) {
    if (!(key in extra)) delete process.env[key];
  }
  return loadEnv();
};

/** `process.exit` would end the test run, so it is trapped and asserted on. */
const trapExit = () => {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
    errors.push(String(m));
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as never);
  return { errors, exit };
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('say nothing and nothing changes', () => {
  it('keeps SpicyAPI on the key alone, exactly as before', () => {
    const env = load({ SPICYAPI_API_KEY: 'spicy-key' });
    expect(env.voice).toMatchObject({ provider: 'spicyapi', apiKey: 'spicy-key' });
  });

  it('has no provider at all when no key is set', () => {
    expect(load().voice).toBeNull();
  });

  it('does not pick up an xAI key by accident when the provider is unnamed', () => {
    /**
     * `XAI_API_KEY` exists in this project for image generation. With
     * `VOICE_LLM_PROVIDER` unset it must have no effect on voice whatsoever --
     * otherwise deploying this change would silently repoint every environment
     * that happens to have that variable.
     */
    expect(load({ XAI_API_KEY: 'image-gen-key' }).voice).toBeNull();
  });
});

describe('naming a provider', () => {
  it('selects Grok, and reads its own key in preference to the shared one', () => {
    const env = load({
      VOICE_LLM_PROVIDER: 'grok',
      VOICE_GROK_API_KEY: 'voice-key',
      XAI_API_KEY: 'image-gen-key',
    });
    expect(env.voice).toMatchObject({ provider: 'grok', apiKey: 'voice-key' });
  });

  it('falls back to XAI_API_KEY only when asked for Grok explicitly', () => {
    const env = load({ VOICE_LLM_PROVIDER: 'grok', XAI_API_KEY: 'image-gen-key' });
    expect(env.voice).toMatchObject({ provider: 'grok', apiKey: 'image-gen-key' });
  });

  it('selects SpicyAPI when named, which is the rollback path', () => {
    const env = load({
      VOICE_LLM_PROVIDER: 'spicyapi',
      SPICYAPI_API_KEY: 'spicy-key',
      VOICE_GROK_API_KEY: 'voice-key',
    });
    expect(env.voice).toMatchObject({ provider: 'spicyapi', apiKey: 'spicy-key' });
  });

  it('is case-insensitive about the provider name', () => {
    expect(load({ VOICE_LLM_PROVIDER: 'GROK', VOICE_GROK_API_KEY: 'k' }).voice?.provider).toBe(
      'grok',
    );
  });

  it('carries the optional model and default voice through', () => {
    const env = load({
      VOICE_LLM_PROVIDER: 'grok',
      VOICE_GROK_API_KEY: 'k',
      VOICE_GROK_MODEL: 'grok-voice-3.0',
      VOICE_GROK_DEFAULT_VOICE: 'luna',
    });
    expect(env.voice).toMatchObject({ model: 'grok-voice-3.0', defaultVoice: 'luna' });
  });

  it('leaves them undefined rather than empty when unset', () => {
    const env = load({ VOICE_LLM_PROVIDER: 'grok', VOICE_GROK_API_KEY: 'k' });
    expect(env.voice?.model).toBeUndefined();
    expect(env.voice?.defaultVoice).toBeUndefined();
  });

  it('shares the duration ceiling across providers: it is tuning, not identity', () => {
    const spicy = load({ SPICYAPI_API_KEY: 'k', VOICE_MAX_SECONDS: '120' });
    const grok = load({
      VOICE_LLM_PROVIDER: 'grok',
      VOICE_GROK_API_KEY: 'k',
      VOICE_MAX_SECONDS: '120',
    });
    expect(spicy.voice?.maxSeconds).toBe(120);
    expect(grok.voice?.maxSeconds).toBe(120);
  });
});

describe('a half-configured provider stops the process', () => {
  it('dies when Grok is named with no key anywhere', () => {
    const { errors } = trapExit();
    expect(() => load({ VOICE_LLM_PROVIDER: 'grok' })).toThrow('EXIT:1');
    expect(errors.join('\n')).toContain('VOICE_GROK_API_KEY');
  });

  it('dies when SpicyAPI is named with no key', () => {
    const { errors } = trapExit();
    expect(() => load({ VOICE_LLM_PROVIDER: 'spicyapi' })).toThrow('EXIT:1');
    expect(errors.join('\n')).toContain('SPICYAPI_API_KEY');
  });

  it('never silently serves the other provider when the named one is incomplete', () => {
    /**
     * The worst failure available here: Grok named, no Grok key, but a SpicyAPI
     * key present. Falling through would place every call against SpicyAPI
     * while an operator believed they were testing Grok.
     */
    const { errors } = trapExit();
    expect(() => load({ VOICE_LLM_PROVIDER: 'grok', SPICYAPI_API_KEY: 'spicy-key' })).toThrow(
      'EXIT:1',
    );
    expect(errors.join('\n')).toContain('will not silently use another provider');
  });

  it('dies on a provider name it does not support, listing the ones it does', () => {
    const { errors } = trapExit();
    expect(() => load({ VOICE_LLM_PROVIDER: 'elevenlabs' })).toThrow('EXIT:1');
    expect(errors.join('\n')).toContain(VOICE_LLM_PROVIDERS.join('|'));
  });

  it('never prints the key in any of those messages', () => {
    const { errors } = trapExit();
    expect(() => load({ VOICE_LLM_PROVIDER: 'grok', SPICYAPI_API_KEY: 'super-secret-spicy' })).toThrow();
    expect(errors.join('\n')).not.toContain('super-secret-spicy');
  });
});

describe('what selecting a voice provider must not move', () => {
  it('leaves chat on its own provider', () => {
    const env = load({ VOICE_LLM_PROVIDER: 'grok', VOICE_GROK_API_KEY: 'voice-key' });
    // Chat still reads LLM_* because CHAT_LLM_PROVIDER was not set.
    expect(env.chatLlm?.model).toBe('grok-4.20-0309-non-reasoning');
    expect(env.chatLlm?.apiKey).toBe('llm-key');
  });

  it('leaves memory extraction and Autofill on LLM_*', () => {
    const env = load({ VOICE_LLM_PROVIDER: 'grok', VOICE_GROK_API_KEY: 'voice-key' });
    expect(env.llm?.model).toBe('grok-4.20-0309-non-reasoning');
    expect(env.llm?.apiKey).toBe('llm-key');
  });

  it('leaves persona vision alone', () => {
    const base = load({ SPICYAPI_API_KEY: 'k' });
    const withGrok = load({ VOICE_LLM_PROVIDER: 'grok', VOICE_GROK_API_KEY: 'voice-key' });
    expect(withGrok.personaVision?.model).toBe(base.personaVision?.model);
  });

  it('leaves the kill switch independent of the provider', () => {
    /**
     * Two conditions have always had to hold: a provider must exist AND calls
     * must be switched on. Naming Grok must not switch anything on by itself.
     */
    const env = load({ VOICE_LLM_PROVIDER: 'grok', VOICE_GROK_API_KEY: 'k' });
    expect(env.voiceCalls.enabled).toBe(false);
  });
});
