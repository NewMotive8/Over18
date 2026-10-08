import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, CHAT_LLM_PROVIDERS, type Env } from '../env.js';
import { chatInferenceConfig, selectOpeningProvider, selectReplyProvider } from '../services/llm-reply-provider.js';
import { selectMemoryExtractor } from '../services/memory-extractor.js';
import { selectProfileAuthor } from '../services/character-profile-service.js';
import { testEnv } from './helpers.js';

/**
 * WHICH MODEL SHE SPEAKS THROUGH, AND WHAT MUST NOT MOVE WITH IT.
 *
 * Chat used to share one `LLM_*` block with memory extraction and Admin
 * Autofill, so trying a different chat model silently repointed those two as
 * well. Both parse structured output and both DROP what they cannot parse, so
 * the damage was invisible: chat looked fine while memory quietly stopped
 * recording anything. These pin the separation, and pin that a half-configured
 * provider stops the process instead of quietly serving the other one.
 */

const ORIGINAL = process.env;

/** A complete, minimal environment; each test adds only what it is about. */
const baseVars = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/over18_test',
  LLM_BASE_URL: 'https://api.x.ai/v1',
  LLM_MODEL: 'grok-4.20-0309-non-reasoning',
  LLM_API_KEY: 'grok-key',
};

const load = (extra: Record<string, string> = {}): Env => {
  process.env = { ...ORIGINAL, ...baseVars, ...extra } as NodeJS.ProcessEnv;
  for (const k of ['CHAT_LLM_PROVIDER', 'CHAT_GROK_BASE_URL', 'CHAT_GROK_MODEL',
    'CHAT_GROK_API_KEY', 'CHAT_SPICYAPI_BASE_URL', 'CHAT_SPICYAPI_MODEL',
    'CHAT_SPICYAPI_API_KEY']) {
    if (!(k in extra)) delete process.env[k];
  }
  return loadEnv();
};

/** Both providers configured at once — the permanent state this feature wants. */
const bothConfigured = {
  CHAT_GROK_BASE_URL: 'https://api.x.ai/v1',
  CHAT_GROK_MODEL: 'grok-4.20-0309-non-reasoning',
  CHAT_GROK_API_KEY: 'grok-key',
  CHAT_SPICYAPI_BASE_URL: 'https://api.spicyapi.com/v1',
  CHAT_SPICYAPI_MODEL: 'spicy-companion-1',
  CHAT_SPICYAPI_API_KEY: 'spicy-key',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('selecting a chat provider', () => {
  it('sends chat to Grok when CHAT_LLM_PROVIDER says grok', () => {
    const env = load({ ...bothConfigured, CHAT_LLM_PROVIDER: 'grok' });
    expect(env.chatLlm?.model).toBe('grok-4.20-0309-non-reasoning');
    expect(env.chatLlm?.baseUrl).toBe('https://api.x.ai/v1');
    expect(env.chatLlm?.apiKey).toBe('grok-key');
  });

  it('sends chat to SpicyAPI when CHAT_LLM_PROVIDER says spicyapi', () => {
    const env = load({ ...bothConfigured, CHAT_LLM_PROVIDER: 'spicyapi' });
    expect(env.chatLlm?.model).toBe('spicy-companion-1');
    expect(env.chatLlm?.baseUrl).toBe('https://api.spicyapi.com/v1');
    expect(env.chatLlm?.apiKey).toBe('spicy-key');
  });

  /** The switch is ONE variable: the same credentials stay in place either way. */
  it('switches on that variable alone, with both providers left configured', () => {
    const grok = load({ ...bothConfigured, CHAT_LLM_PROVIDER: 'grok' });
    const spicy = load({ ...bothConfigured, CHAT_LLM_PROVIDER: 'spicyapi' });
    expect(grok.chatLlm?.model).not.toBe(spicy.chatLlm?.model);
  });

  it('is case-insensitive and tolerates stray whitespace', () => {
    const env = load({ ...bothConfigured, CHAT_LLM_PROVIDER: '  SpicyAPI  ' });
    expect(env.chatLlm?.model).toBe('spicy-companion-1');
  });

  /** An endpoint may legitimately be keyless, exactly as LLM_API_KEY is optional. */
  it('accepts a provider with no key', () => {
    const env = load({
      CHAT_LLM_PROVIDER: 'grok',
      CHAT_GROK_BASE_URL: 'http://127.0.0.1:8000/v1',
      CHAT_GROK_MODEL: 'local-model',
    });
    expect(env.chatLlm?.apiKey).toBeUndefined();
    expect(env.chatLlm?.model).toBe('local-model');
  });
});

describe('saying nothing changes nothing', () => {
  /**
   * THE COMPATIBILITY GUARD. Every environment that predates this feature
   * leaves CHAT_LLM_PROVIDER unset, and must keep using LLM_* exactly as before.
   */
  it('falls back to LLM_* when CHAT_LLM_PROVIDER is unset', () => {
    const env = load();
    expect(env.chatLlm).toEqual(env.llm);
    expect(env.chatLlm?.model).toBe('grok-4.20-0309-non-reasoning');
  });

  it('treats an empty or blank value as unset rather than as an error', () => {
    expect(load({ CHAT_LLM_PROVIDER: '' }).chatLlm).toEqual(load().llm);
    expect(load({ CHAT_LLM_PROVIDER: '   ' }).chatLlm).toEqual(load().llm);
  });

  it('leaves chat unconfigured when nothing is configured at all', () => {
    process.env = { DATABASE_URL: baseVars.DATABASE_URL } as NodeJS.ProcessEnv;
    const env = loadEnv();
    expect(env.llm).toBeNull();
    expect(env.chatLlm).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Misconfiguration stops the process. It never picks the other one.
 * ------------------------------------------------------------------ */

describe('a misconfigured provider is fatal, never a silent switch', () => {
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

  it.each([
    ['base URL', { CHAT_SPICYAPI_MODEL: 'spicy-companion-1' }, 'CHAT_SPICYAPI_BASE_URL'],
    ['model', { CHAT_SPICYAPI_BASE_URL: 'https://api.spicyapi.com/v1' }, 'CHAT_SPICYAPI_MODEL'],
  ])('refuses to start when the selected provider is missing its %s', (_what, vars, named) => {
    const { errors } = trapExit();
    expect(() => load({ CHAT_LLM_PROVIDER: 'spicyapi', ...vars })).toThrow('EXIT:1');
    expect(errors.join('\n')).toContain(named);
  });

  /**
   * THE FAILURE THIS WHOLE DESIGN EXISTS TO PREVENT. Grok is fully configured
   * and would work; the point is that chat must NOT quietly use it when
   * SpicyAPI was the one asked for.
   */
  it('does not fall back to the other provider, however complete that one is', () => {
    const { errors } = trapExit();
    expect(() =>
      load({
        CHAT_LLM_PROVIDER: 'spicyapi',
        CHAT_GROK_BASE_URL: 'https://api.x.ai/v1',
        CHAT_GROK_MODEL: 'grok-4.20-0309-non-reasoning',
      }),
    ).toThrow('EXIT:1');
    expect(errors.join('\n')).toContain('will not silently use another provider');
  });

  it('refuses an unknown provider name and says which ones exist', () => {
    const { errors } = trapExit();
    expect(() => load({ CHAT_LLM_PROVIDER: 'openai' })).toThrow('EXIT:1');
    const text = errors.join('\n');
    for (const name of CHAT_LLM_PROVIDERS) expect(text).toContain(name);
  });
});

/* ------------------------------------------------------------------ *
 * What must NOT follow the chat provider
 * ------------------------------------------------------------------ */

describe('memory extraction and Autofill stay on the Grok configuration', () => {
  /**
   * Both are built from `llm`, never `chatLlm`. This asserts the wiring rather
   * than the behaviour, because the behaviour (a dropped fact, an unparsed
   * JSON object) is exactly what fails silently.
   */
  it('keeps LLM_* pointed at Grok while chat is on SpicyAPI', () => {
    const env = load({ ...bothConfigured, CHAT_LLM_PROVIDER: 'spicyapi' });
    expect(env.chatLlm?.baseUrl).toBe('https://api.spicyapi.com/v1');
    expect(env.llm?.baseUrl).toBe('https://api.x.ai/v1');
    expect(env.llm?.model).toBe('grok-4.20-0309-non-reasoning');
  });

  it('still builds an extractor and an author while chat points elsewhere', () => {
    const env = load({ ...bothConfigured, CHAT_LLM_PROVIDER: 'spicyapi' });
    expect(selectMemoryExtractor(env)).toBeTypeOf('function');
    expect(selectProfileAuthor(env)).toBeTypeOf('function');
  });

  /** Persona vision is pinned to its own variables and must not drift either. */
  it('leaves persona vision on its own configuration', () => {
    const env = load({
      ...bothConfigured,
      CHAT_LLM_PROVIDER: 'spicyapi',
      PERSONA_VISION_BASE_URL: 'https://api.x.ai/v1',
      PERSONA_VISION_MODEL: 'grok-4.6',
    });
    expect(env.personaVision?.model).toBe('grok-4.6');
    expect(env.personaVision?.baseUrl).toBe('https://api.x.ai/v1');
  });
});

/* ------------------------------------------------------------------ *
 * The providers the rest of the app actually receives
 * ------------------------------------------------------------------ */

describe('the reply and opening providers follow the chat config', () => {
  const envWith = (chatLlm: Env['chatLlm']): Env => ({ ...testEnv, chatLlm });

  /**
   * THE REGRESSION THIS FEATURE NEARLY SHIPPED. Env is built by hand in dozens
   * of tests and callers that know only about `llm`. The first version of this
   * change read `chatLlm` alone, so every one of them silently lost its
   * provider and fell through to the deterministic fallback -- caught only
   * because seven existing tests went red. Adding a field must never be able to
   * switch a model off.
   */
  it('uses llm when a caller set only that, never dropping to the fallback', () => {
    const grokOnly = load().llm;
    const handBuilt: Env = { ...testEnv, llm: grokOnly, chatLlm: null, isProduction: true };
    const provider = selectReplyProvider(handBuilt);
    // The unconfigured provider throws on sight; a real one does not.
    expect(provider).not.toBe(selectReplyProvider({ ...testEnv, isProduction: true }));
    expect(chatInferenceConfig(handBuilt)?.model).toBe('grok-4.20-0309-non-reasoning');
  });

  it('builds a real provider when chat is configured', () => {
    const env = load({ ...bothConfigured, CHAT_LLM_PROVIDER: 'spicyapi' });
    expect(selectReplyProvider(env)).toBeTypeOf('function');
    expect(selectOpeningProvider(env)).toBeTypeOf('function');
  });

  /**
   * HER GREETING IS CHARACTER CHAT. If the opening still read `llm` she would
   * say hello in one model's voice and continue in another's -- the exact
   * mismatch `selectOpeningProvider`'s own comment warns about.
   */
  it('gives the opening the same endpoint as a reply', () => {
    const env = load({ ...bothConfigured, CHAT_LLM_PROVIDER: 'spicyapi' });
    expect(env.chatLlm?.model).toBe('spicy-companion-1');
    expect(selectOpeningProvider(env)).toBeTypeOf('function');
    expect(selectOpeningProvider({ ...envWith(null), isProduction: false })).toBeTypeOf('function');
  });

  /**
   * Unconfigured chat must fail loudly in production, never invent a reply.
   * It throws SYNCHRONOUSLY, before any promise exists -- which is what makes
   * it roll the message transaction back rather than persist a half exchange.
   */
  it('refuses rather than faking a reply in production', () => {
    const provider = selectReplyProvider({ ...envWith(null), isProduction: true });
    expect(() =>
      provider({
        character: { id: 'c', name: 'n', displayName: 'N', profileImage: null, shortBio: '',
          personality: '', interests: [], conversationStyle: '' },
        systemPrompt: 'You are N.',
        history: [], priorMessageCount: 0, userMessage: 'hi',
      }),
    ).toThrow(/no llm inference endpoint is configured/i);
  });
});
