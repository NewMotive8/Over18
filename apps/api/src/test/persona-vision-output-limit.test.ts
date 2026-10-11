import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, type Env } from '../env.js';
import {
  PersonaGeneratorError,
  selectPersonaGenerator,
} from '../services/character-persona-generator.js';

/**
 * THE OUTPUT CEILING, AND THE TUNING KNOB THAT WAS NEVER CONNECTED TO IT.
 *
 * Persona generation failed intermittently with "The model did not return a
 * persona", which reads as a refusal or a bad reference photo. It was neither:
 * the reply was being cut off at a 700-token ceiling. Measured against the
 * real endpoint, four complete personas from one real reference image came
 * back at 556, 621, 627 and 674 completion tokens -- the upper tail of that
 * distribution crosses 700, which is exactly why it failed sometimes and
 * worked on a retry.
 *
 * Two things had to be true for that to be invisible. First, the requested
 * object is FLAT, so its only closing brace is the last character of the
 * reply and any truncation removes it entirely. Second,
 * PERSONA_VISION_MAX_TOKENS was parsed by env.ts and then dropped on the
 * floor -- the vision adapter's config carries only the endpoint -- so the
 * one setting that could have fixed it did nothing when set.
 *
 * These tests go through the REAL adapter over a stubbed fetch, because the
 * defect lived in the gap between the config and the wire. A test that called
 * the generator with explicit options would have passed throughout.
 */

const ORIGINAL = process.env;

const baseVars = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/over18_test',
  PERSONA_VISION_BASE_URL: 'https://vision.invalid/v1',
  PERSONA_VISION_MODEL: 'vision-test-model',
  PERSONA_VISION_API_KEY: 'vision-key',
};

/** Loads an env with ONLY the persona-vision knobs this test is about. */
const load = (extra: Record<string, string> = {}): Env => {
  process.env = { ...ORIGINAL, ...baseVars, ...extra } as NodeJS.ProcessEnv;
  for (const key of ['PERSONA_VISION_MAX_TOKENS', 'PERSONA_VISION_TEMPERATURE']) {
    if (!(key in extra)) delete process.env[key];
  }
  return loadEnv();
};

const PERSONA = {
  age: 26,
  lifeStage: 'young professional',
  occupation: 'translator',
  hobbies: ['long walks', 'second-hand bookshops'],
};

const INPUT = {
  displayName: 'Freya',
  imageBytes: Buffer.from('reference-image-bytes'),
  imageMimeType: 'image/png',
};

/** One upstream reply, in the OpenAI-compatible shape the adapter reads. */
function completion(content: string, finishReason = 'stop') {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function stubFetch(impl: (input: unknown, init: RequestInit) => Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** What the adapter actually put on the wire. */
function sentBody(spy: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const [, init] = spy.mock.calls[0]!;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = ORIGINAL;
});

describe('the configured output ceiling reaches the wire', () => {
  it('defaults to 2000 tokens, not the 700 that was truncating replies', async () => {
    const spy = stubFetch(() => completion(JSON.stringify(PERSONA)));

    await selectPersonaGenerator(load())(INPUT);

    expect(sentBody(spy).max_tokens).toBe(2_000);
  });

  /**
   * THE REGRESSION ITSELF. This variable existed, was documented by its own
   * presence in env.ts, and changed nothing. Asserting on the request body is
   * the only way to catch that -- every layer above it looked correct.
   */
  it('honours PERSONA_VISION_MAX_TOKENS and PERSONA_VISION_TEMPERATURE', async () => {
    const spy = stubFetch(() => completion(JSON.stringify(PERSONA)));

    await selectPersonaGenerator(
      load({ PERSONA_VISION_MAX_TOKENS: '1234', PERSONA_VISION_TEMPERATURE: '0.9' }),
    )(INPUT);

    const body = sentBody(spy);
    expect(body.max_tokens).toBe(1234);
    expect(body.temperature).toBe(0.9);
  });

  it('leaves temperature at 0.4 when only the ceiling is configured', async () => {
    const spy = stubFetch(() => completion(JSON.stringify(PERSONA)));

    await selectPersonaGenerator(load({ PERSONA_VISION_MAX_TOKENS: '3000' }))(INPUT);

    const body = sentBody(spy);
    expect(body.max_tokens).toBe(3000);
    expect(body.temperature).toBe(0.4);
  });

  /** Zero is a real temperature, so it must survive the "is it set?" check. */
  it('treats an explicit temperature of 0 as configured', async () => {
    const spy = stubFetch(() => completion(JSON.stringify(PERSONA)));

    await selectPersonaGenerator(load({ PERSONA_VISION_TEMPERATURE: '0' }))(INPUT);

    expect(sentBody(spy).temperature).toBe(0);
  });

  /**
   * A typo must not reach the endpoint. `Number('plenty')` is NaN, and
   * JSON.stringify turns NaN into null -- an upstream 400 about a malformed
   * request instead of an obviously-ignored setting.
   */
  it('falls back to the defaults when a value is not a usable number', async () => {
    const spy = stubFetch(() => completion(JSON.stringify(PERSONA)));

    await selectPersonaGenerator(
      load({ PERSONA_VISION_MAX_TOKENS: 'plenty', PERSONA_VISION_TEMPERATURE: 'warm' }),
    )(INPUT);

    const body = sentBody(spy);
    expect(body.max_tokens).toBe(2_000);
    expect(body.temperature).toBe(0.4);
    expect(body.max_tokens).not.toBeNull();
  });

  it('ignores a negative ceiling rather than sending it', async () => {
    const spy = stubFetch(() => completion(JSON.stringify(PERSONA)));

    await selectPersonaGenerator(load({ PERSONA_VISION_MAX_TOKENS: '-50' }))(INPUT);

    expect(sentBody(spy).max_tokens).toBe(2_000);
  });

  /**
   * The unconfigured generator throws SYNCHRONOUSLY rather than rejecting, so
   * this asserts on the call and not on a promise. Its only caller awaits it
   * inside a try, which is why that has never mattered.
   */
  it('reports itself unconfigured when there is no vision endpoint at all', () => {
    process.env = { ...ORIGINAL, DATABASE_URL: baseVars.DATABASE_URL } as NodeJS.ProcessEnv;
    for (const key of ['PERSONA_VISION_BASE_URL', 'PERSONA_VISION_MODEL', 'LLM_BASE_URL', 'LLM_MODEL']) {
      delete process.env[key];
    }
    const generator = selectPersonaGenerator(loadEnv());
    let caught: unknown;
    try {
      generator(INPUT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersonaGeneratorError);
    expect((caught as PersonaGeneratorError).kind).toBe('not_configured');
  });
});

describe('a truncated reply says so', () => {
  /**
   * The flat object's only brace is its last character, so a reply that ran
   * out of room contains none at all. Before this, that produced the same
   * message as a model that had refused outright.
   */
  it('reports truncation instead of blaming the photo or the model', async () => {
    const cutOff = JSON.stringify(PERSONA).slice(0, 60);
    expect(cutOff).not.toContain('}');
    stubFetch(() => completion(cutOff, 'length'));

    const error = await selectPersonaGenerator(load())(INPUT).catch((e) => e);

    expect(error).toBeInstanceOf(PersonaGeneratorError);
    expect(error.kind).toBe('truncated');
    expect(error.message).toMatch(/ran out of room/i);
    expect(error.message).not.toMatch(/did not return a persona/i);
    // Actionable: it names the setting that fixes it.
    expect(error.message).toContain('PERSONA_VISION_MAX_TOKENS');
  });

  /**
   * PRESERVED BEHAVIOUR. A reply that stopped of its own accord and still
   * carried no object is a bad reply, not a short one, and must keep the
   * original diagnosis.
   */
  it('keeps the original message when the model simply said something else', async () => {
    stubFetch(() => completion('I would rather not describe this person.', 'stop'));

    const error = await selectPersonaGenerator(load())(INPUT).catch((e) => e);

    expect(error.kind).toBe('invalid_output');
    expect(error.message).toBe('The model did not return a persona.');
  });

  /**
   * A ceiling hit on the token AFTER the closing brace costs nothing, so the
   * persona must still be delivered. Truncation is judged by whether the
   * reply parsed, never by the stop reason alone.
   */
  it('still delivers a persona that happens to close just before the ceiling', async () => {
    stubFetch(() => completion(JSON.stringify(PERSONA), 'length'));

    const result = await selectPersonaGenerator(load())(INPUT);

    expect(result.persona.occupation).toBe('translator');
  });
});

describe('what the model is allowed to see is unchanged', () => {
  /**
   * The rule this feature rests on: the request carries her NAME and her
   * REFERENCE IMAGE, and nothing else about her. Raising a token ceiling is
   * no reason for that to drift, so it is pinned here against the real
   * request body rather than against the prompt builder in isolation.
   */
  it('sends only her name and the image, never an existing persona', async () => {
    const spy = stubFetch(() => completion(JSON.stringify(PERSONA)));

    await selectPersonaGenerator(load())(INPUT);

    const body = sentBody(spy);
    const wire = JSON.stringify(body.messages);
    expect(wire).toContain('Freya');
    expect(wire).toContain(`data:image/png;base64,${INPUT.imageBytes.toString('base64')}`);
    // Nothing from a previous generation can be in here -- there is no field
    // on PersonaGeneratorInput through which it could arrive.
    for (const leak of ['translator', 'young professional', 'second-hand bookshops']) {
      expect(wire).not.toContain(leak);
    }
  });
});
