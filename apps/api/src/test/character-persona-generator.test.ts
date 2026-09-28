import { describe, expect, it } from 'vitest';
import { LlmError } from '../llm/types.js';
import type { LlmVisionClient, LlmVisionRequest } from '../llm/vision-types.js';
import {
  PersonaGeneratorError,
  buildPersonaPrompt,
  createLlmPersonaGenerator,
  sampleOccupations,
  extractJsonObject,
  toPersonaGeneratorDraft,
  toProposedProfile,
  unconfiguredPersonaGenerator,
} from '../services/character-persona-generator.js';

/**
 * Persona generation's parsing and failure behaviour, with no database and no
 * network — mirrors character-profile-service.test.ts. A vision-model reply
 * is UNTRUSTED input about to become server-side prompt material, so a
 * malformed or unsafe reply must fail loudly rather than half-apply.
 */

const GOOD = {
  age: 27,
  lifeStage: 'renting with two roommates, still finding her footing',
  occupation: 'second-year ER nurse',
  hobbies: ['night runs', 'trashy reality TV'],
  flirtingStyle: 'teases first, means it second',
};

const INPUT = { displayName: 'Nova', imageBytes: Buffer.from('fake-bytes'), imageMimeType: 'image/jpeg' };

function clientReturning(raw: string, capture?: LlmVisionRequest[]): LlmVisionClient {
  return {
    generate: async (request) => {
      capture?.push(request);
      return raw;
    },
  };
}

describe('extracting the model reply', () => {
  it('reads a bare object, a fenced one, and one buried in prose', () => {
    const json = JSON.stringify(GOOD);
    expect(extractJsonObject(json)).toMatchObject({ age: 27 });
    expect(extractJsonObject('```json\n' + json + '\n```')).toMatchObject({ age: 27 });
    expect(extractJsonObject(`Sure! Here you go:\n${json}\nHope that helps.`)).toMatchObject({
      age: 27,
    });
  });

  it('refuses a reply with no object, and one that is malformed', () => {
    expect(() => extractJsonObject('I would rather not.')).toThrow(PersonaGeneratorError);
    expect(() => extractJsonObject('{ "occupation": ')).toThrow(PersonaGeneratorError);
  });
});

describe('validating a draft', () => {
  it('accepts a valid persona', () => {
    const draft = toPersonaGeneratorDraft(GOOD);
    expect(draft.age).toBe(27);
    expect(draft.hobbies).toEqual(['night runs', 'trashy reality TV']);
  });

  it('drops unknown keys rather than surfacing them', () => {
    const draft = toPersonaGeneratorDraft({ ...GOOD, race: 'should never appear', religion: 'nope' });
    expect(draft).not.toHaveProperty('race');
    expect(draft).not.toHaveProperty('religion');
  });

  it('rejects a persona that denotes a minor', () => {
    expect(() => toPersonaGeneratorDraft({ age: 15 })).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft({ ageRange: 'teenager' })).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft({ lifeStage: 'high school student' })).toThrow(
      PersonaGeneratorError,
    );
  });

  it('rejects an all-empty object as a bad response, not a successful no-op', () => {
    expect(() => toPersonaGeneratorDraft({})).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft({ race: 'x' })).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft('not an object')).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft(null)).toThrow(PersonaGeneratorError);
  });

  it('tolerates a junk array field without letting it through unbounded', () => {
    const draft = toPersonaGeneratorDraft({
      ...GOOD,
      hobbies: [1, 'reading', null, '  ', ...Array(20).fill('x')],
    });
    expect(draft.hobbies!.length).toBeLessThanOrEqual(6);
    expect(draft.hobbies).toContain('reading');
  });
});

describe('the instruction set', () => {
  it('states the adult/privacy rules, carries the display name, and attaches the image', () => {
    const messages = buildPersonaPrompt(INPUT);
    const systemText = messages[0]!.content as string;
    expect(systemText).toContain('FICTIONAL ADULT');
    expect(systemText).toContain('Never write anything implying a minor');
    expect(systemText).toMatch(/race|religion|sexual orientation/);

    const userContent = messages[1]!.content;
    expect(Array.isArray(userContent)).toBe(true);
    const parts = userContent as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'text')).toBe(true);
    const imagePart = parts.find((p) => p.type === 'image_url') as
      | { type: 'image_url'; image_url: { url: string } }
      | undefined;
    expect(imagePart?.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });
});

function userTextOf(messages: ReturnType<typeof buildPersonaPrompt>): string {
  return (messages[1]!.content as Array<{ type: string; text?: string }>).find(
    (p) => p.type === 'text',
  )!.text!;
}

/**
 * THE PHOTO IS THE ONLY THING THE MODEL IS TOLD ABOUT HER.
 *
 * These replace an earlier pair of tests that asserted the opposite -- that
 * her bio, personality and interests WERE described to the model, with the
 * photo named as the tie-breaker. That is the behaviour Objective 2 removes:
 * a "FROM HER PHOTO" result computed while looking at last week's paragraph
 * is anchored to the paragraph, whatever the instructions say, and nobody
 * reading the output can tell the difference.
 *
 * The sentinels below are the point. They are strings no vision model could
 * produce from any image, placed where her profile used to enter the prompt,
 * so the assertion is not "the prompt looks right" but "this specific text
 * cannot reach the model". `buildPersonaPrompt` no longer has a parameter to
 * put them in -- the casts are what let the test prove that at runtime rather
 * than trusting the compiler to have caught every caller.
 */
describe('the prompt describes her photo and nothing else about her', () => {
  const SENTINELS = {
    shortBio: 'ZZZ-SENTINEL-BIO-NEVER-IN-A-PROMPT',
    personality: 'ZZZ-SENTINEL-PERSONALITY-NEVER-IN-A-PROMPT',
    interests: ['ZZZ-SENTINEL-INTEREST-NEVER-IN-A-PROMPT'],
    persona: { occupation: 'ZZZ-SENTINEL-PERSONA-NEVER-IN-A-PROMPT' },
    conversationStyle: 'ZZZ-SENTINEL-STYLE-NEVER-IN-A-PROMPT',
    systemPrompt: 'ZZZ-SENTINEL-SYSTEM-PROMPT-NEVER-IN-A-PROMPT',
  };

  it('carries her name and her image \u2014 and no profile field, even one forced in', () => {
    // Every field that used to be accepted here, plus several that never
    // were, pushed through the type. If any of them can still be rendered,
    // this fails.
    const messages = buildPersonaPrompt({
      ...INPUT,
      ...SENTINELS,
    } as unknown as Parameters<typeof buildPersonaPrompt>[0]);

    const serialised = JSON.stringify(messages);
    expect(serialised, 'her name is the one thing about her that is sent').toContain('Nova');
    for (const sentinel of [
      SENTINELS.shortBio,
      SENTINELS.personality,
      SENTINELS.interests[0]!,
      SENTINELS.persona.occupation,
      SENTINELS.conversationStyle,
      SENTINELS.systemPrompt,
    ]) {
      expect(serialised, `${sentinel} reached the model`).not.toContain(sentinel);
    }
  });

  /**
   * The prompt is two messages: instructions, then her name + the image. The
   * only per-character values in the whole thing are the display name and the
   * data URL. Pinning that shape is what stops a future edit reintroducing a
   * profile block without anyone noticing.
   */
  it('contains exactly two per-character values: the name and the image', () => {
    // The occupation shortlist varies per REQUEST by design, so it is pinned
    // here -- otherwise this test would be measuring that variation instead of
    // what it is about, which is that nothing CHARACTER-specific leaks in.
    const fixed = { random: () => 0 };
    const messages = buildPersonaPrompt(INPUT, fixed);
    const userText = userTextOf(messages);
    expect(userText).toContain('"Nova"');
    expect(userText).toContain('This photo is the only thing you know about her');

    // The instruction message is character-independent: byte-identical for
    // two different characters.
    const other = buildPersonaPrompt({ ...INPUT, displayName: 'Mazal' }, fixed);
    expect(other[0]!.content).toBe(messages[0]!.content);
    expect(userTextOf(other)).toBe(userText.replace('"Nova"', '"Mazal"'));
  });

  /** Asked for unconditionally now, not only when a profile existed. */
  it('asks for the everyday texture for a character with nothing written yet', () => {
    const userText = userTextOf(buildPersonaPrompt(INPUT));
    expect(userText).toMatch(/her routine, what she worries about, how she jokes/);
  });

  it('no longer claims the photo merely OUTRANKS a profile it never sees', () => {
    const userText = userTextOf(buildPersonaPrompt(INPUT));
    expect(userText).not.toContain('THE PHOTO IS THE AUTHORITY');
    expect(userText).not.toMatch(/currently reads as follows/i);
  });
});

/**
 * ORDINARY WOMEN, NOT NOVEL CHARACTERS.
 *
 * Live generation produced "horticulturist at an ornamental public garden with
 * an on-site cafe" and "curator at a private rare-book library" -- both
 * stylistic clones of the prompt's single occupation exemplar, which was a
 * vintage-furniture shop in a converted garage. The exemplar set the pattern,
 * and "avoid stereotypes" pushed the model off the common jobs at the same
 * time.
 *
 * These assertions are about the exemplar and the correction, not just the
 * presence of a word list, because rewording the example is how this regresses.
 */
describe('occupations stay ordinary', () => {
  const systemText = buildPersonaPrompt(INPUT)[0]!.content as string;

  it('no longer offers a boutique business as THE example of a good detail', () => {
    expect(systemText).not.toContain('vintage-furniture');
    expect(systemText).not.toContain('converted garage');
  });

  /**
   * THE EXEMPLAR IS NO LONGER AN OCCUPATION AT ALL.
   *
   * It was "teaches Year 4 at a primary school...", and one character came back
   * as a Year 4 teacher at a neighbourhood primary school. An occupational
   * example anchors the occupation however carefully it is chosen, so the
   * example now illustrates specificity with something that is not a job.
   */
  it('illustrates specificity WITHOUT naming a job', () => {
    expect(systemText).toContain('Prefer concrete, specific, lived-in details');
    expect(systemText).toMatch(/opens earliest/);
    expect(systemText, 'the old anchor must be gone').not.toMatch(/teaches Year 4/);
    expect(systemText).not.toMatch(/primary school a ten-minute walk/);
  });

  it('separates what the image ESTABLISHES from what is invented', () => {
    // The old wording ("obvious occupation clue ... otherwise choose") implied a
    // job was always derivable from a photo. These two lines replace it.
    expect(systemText).toMatch(/HER JOB IS USUALLY NOT IN THE PICTURE/);
    expect(systemText).toMatch(/uniform, a workplace, tools, equipment, a vehicle, signage/);
    expect(systemText).toMatch(/WHEN IT IS UNKNOWN, INVENT ONE FREELY AND DIFFERENTLY EACH TIME/);
    expect(systemText).toMatch(/unusual occupation is allowed only when the image genuinely establishes it/i);
  });

  /** Appearance is not a job. This is the rule the reported defect broke. */
  it('rules out inferring a job from how she looks', () => {
    expect(systemText).toMatch(
      /face, her age, her build, her clothing, her makeup, her hair and a leisure setting are NEVER evidence of a job/,
    );
    expect(systemText).toMatch(/ambiguous hint is not evidence/);
  });

  /** The reported title was a hybrid, so hybrids are banned by name. */
  it('bans stacked job titles, naming the one that was reported', () => {
    expect(systemText).toMatch(/ONE PLAIN TITLE, NEVER A STACK OF THEM/);
    expect(systemText).toContain('marketing coordination manager');
    expect(systemText).toMatch(/needs a slash, a conjunction or a third noun/);
  });

  /** And the family it kept landing in is named as not-the-default. */
  it('tells the model not to default to marketing or admin roles', () => {
    expect(systemText).toMatch(
      /Do not lean towards marketing, administration, coordination or management/,
    );
  });

  /** Variety must not cost coherence -- requirement C. */
  it('requires the rest of her to fit whichever job it picked', () => {
    expect(systemText).toMatch(
      /education, her daily routine, what she worries about .* should be what that job and that life would actually produce/,
    );
    expect(systemText).toMatch(/the occupation changes between runs, the coherence does not/);
  });
  it('names the motives that used to drive the exotic choice, and rules them out', () => {
    expect(systemText).toMatch(/never to make her more interesting, sophisticated, artistic, mysterious or literary/i);
    expect(systemText).toMatch(/rare-book librar/i);
  });

  /**
   * The specific trap: "avoid stereotypes" reads as "avoid nurse, teacher,
   * accountant". The prompt must now say the opposite in as many words.
   */
  it('says explicitly that a common job is not a stereotype', () => {
    expect(systemText).toMatch(/common, ordinary job is NOT a stereotype/);
  });

  it('keeps the privacy and adult rules untouched', () => {
    expect(systemText).toContain('FICTIONAL ADULT');
    expect(systemText).toContain('Never write anything implying a minor');
    expect(systemText).toMatch(/race|religion|sexual orientation/);
  });
});


/**
 * THE MECHANISM THAT ACTUALLY BREAKS THE REPETITION.
 *
 * Every instruction in the prompt is identical run to run, and the sampling
 * temperature is fixed at 0.4 in `createLlmPersonaGenerator`, so wording alone
 * cannot make the model choose differently. The shortlist is the only part of
 * the request that changes, which is why it exists and why these tests are
 * about the SHORTLIST rather than about the model.
 *
 * None of this proves the model varies its answer. That is measured against the
 * real endpoint, not here.
 */
describe('the occupation shortlist varies per request', () => {
  it('offers a different shortlist on successive calls', () => {
    const line = (m: ReturnType<typeof buildPersonaPrompt>) =>
      userTextOf(m).split('\n').find((l) => l.startsWith('If the photo does not establish'))!;

    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) seen.add(line(buildPersonaPrompt(INPUT)));
    // 6 drawn from 57 -- twelve identical draws would be a broken sampler, not
    // bad luck. Loose on purpose so this can never flake.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('is a suggestion, never an instruction to use the list', () => {
    const text = userTextOf(buildPersonaPrompt(INPUT));
    expect(text).toMatch(/or any other equally ordinary job that is not on this list/);
    // Evidence still outranks the list: the sentence is conditional.
    expect(text).toMatch(/If the photo does not establish her job/);
  });

  it('draws without repeats inside one shortlist', () => {
    for (let i = 0; i < 20; i += 1) {
      const picked = sampleOccupations();
      expect(new Set(picked).size).toBe(picked.length);
    }
  });

  it('can reach far more than one corner of the pool', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) for (const o of sampleOccupations()) seen.add(o);
    // A sampler stuck on the head of the list would show a handful.
    expect(seen.size).toBeGreaterThan(30);
  });

  /**
   * The pool is the thing that used to cause the defect, so its SHAPE is
   * pinned: no compound titles (they were blended into hybrids) and no
   * single occupational family big enough to be the default answer.
   */
  it('offers no compound titles for the model to blend', () => {
    const all = sampleOccupations(200);
    for (const job of all) {
      expect(job, `"${job}" invites a hybrid title`).not.toMatch(/ or |\//);
    }
  });

  it('is not dominated by marketing, admin or management roles', () => {
    const all = sampleOccupations(200);
    const adminish = all.filter((j) =>
      /marketing|admin|coordinat|manager|executive assistant/i.test(j),
    );
    expect(all.length).toBeGreaterThan(40);
    // Present, because they are ordinary jobs -- but nowhere near the centre.
    expect(adminish.length).toBeGreaterThan(0);
    expect(adminish.length / all.length).toBeLessThan(0.2);
  });

  it('pins the selection when a test supplies its own random', () => {
    const a = sampleOccupations(6, () => 0);
    const b = sampleOccupations(6, () => 0);
    expect(a).toEqual(b);
  });

});

describe('the proposed profile rewrite', () => {
  it('is requested in the third person, with no style or speech directions', () => {
    const systemText = buildPersonaPrompt(INPUT)[0]!.content as string;
    expect(systemText).toContain('proposedShortBio');
    expect(systemText).toContain('proposedPersonality');
    expect(systemText).toContain('THIRD PERSON');
    expect(systemText).toMatch(/no tone, cadence, register or style directions/i);
  });

  it('parses a descriptive proposal', () => {
    const profile = toProposedProfile({
      proposedShortBio: 'She is 24 and halfway through an astronomy doctorate.',
      proposedPersonality: 'Unhurried and watchful, warmer once she trusts someone.',
      proposedInterests: ['deep-sky photography', 'secondhand bookshops'],
    });
    expect(profile?.shortBio).toContain('astronomy doctorate');
    expect(profile?.interests).toEqual(['deep-sky photography', 'secondhand bookshops']);
  });

  it('REJECTS text that instructs rather than describes — the Phase 1 defect', () => {
    // Exactly the shape that broke production before: a bio carrying speech
    // directions, which then outranks the code-owned behaviour layer.
    expect(
      toProposedProfile({
        proposedShortBio: 'You treat every conversation like a field recording.',
      }),
    ).toBeUndefined();
    expect(
      toProposedProfile({
        proposedPersonality: 'Respond with poetic restraint and vivid sensory description.',
      }),
    ).toBeUndefined();
    expect(
      toProposedProfile({ proposedShortBio: 'Her cadence is low and deliberate.' }),
    ).toBeUndefined();
  });

  it('keeps a clean field when a sibling field is instructional', () => {
    const profile = toProposedProfile({
      proposedShortBio: 'She is a second-year ER nurse who runs at night.',
      proposedPersonality: 'Speak in a low, deliberate cadence.',
    });
    expect(profile?.shortBio).toContain('ER nurse');
    expect(profile?.personality).toBeUndefined();
  });

  it('is absent, not an error, when the model offers none', () => {
    expect(toProposedProfile({ age: 24 })).toBeUndefined();
    expect(toProposedProfile(null)).toBeUndefined();
    expect(toProposedProfile('nope')).toBeUndefined();
  });

  it('an absent proposal never costs the operator the persona', async () => {
    // The persona is the deliverable; the rewrite is an offer.
    const generator = createLlmPersonaGenerator(clientReturning(JSON.stringify(GOOD)));
    const result = await generator(INPUT);
    expect(result.persona.occupation).toBe('second-year ER nurse');
    expect(result.profile).toBeUndefined();
  });

  it('carries the proposal through when the model does offer one', async () => {
    const generator = createLlmPersonaGenerator(
      clientReturning(
        JSON.stringify({ ...GOOD, proposedShortBio: 'She is 27 and works nights in an ER.' }),
      ),
    );
    const result = await generator(INPUT);
    expect(result.profile?.shortBio).toContain('works nights in an ER');
  });
});

describe('the generator', () => {
  it('turns a model reply into a persona, and passes the image through', async () => {
    const seen: LlmVisionRequest[] = [];
    const generator = createLlmPersonaGenerator(clientReturning(JSON.stringify(GOOD), seen));
    const result = await generator(INPUT);
    expect(result.persona.occupation).toBe('second-year ER nurse');
    expect(seen[0]!.messages[0]!.role).toBe('system');
  });

  it('never leaks provider detail when inference fails', async () => {
    const secretish = 'HTTP 401 from https://provider.invalid key=sk-do-not-leak';
    const generator = createLlmPersonaGenerator({
      generate: async () => {
        throw new LlmError('http', secretish, 401);
      },
    });
    const error = await generator(INPUT).catch((e) => e);
    expect(error).toBeInstanceOf(PersonaGeneratorError);
    expect(error.kind).toBe('unavailable');
    expect(error.message).not.toContain('sk-do-not-leak');
    expect(error.message).not.toContain('provider.invalid');
  });

  it('distinguishes "not configured" and "timed out" for the operator', async () => {
    const notConfigured = await createLlmPersonaGenerator({
      generate: async () => {
        throw new LlmError('not_configured', 'no endpoint');
      },
    })(INPUT).catch((e) => e);
    expect(notConfigured.kind).toBe('not_configured');

    const timedOut = await createLlmPersonaGenerator({
      generate: async () => {
        throw new LlmError('timeout', 'took too long');
      },
    })(INPUT).catch((e) => e);
    expect(timedOut.kind).toBe('unavailable');
    expect(timedOut.message).toContain('too long');
  });

  it('the unconfigured generator refuses rather than faking a persona', async () => {
    const error = await Promise.resolve()
      .then(() => unconfiguredPersonaGenerator(INPUT))
      .catch((e) => e);
    expect(error).toBeInstanceOf(PersonaGeneratorError);
    expect(error.kind).toBe('not_configured');
  });
});
