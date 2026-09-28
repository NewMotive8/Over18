import { LlmError } from '../llm/types.js';
import { createOpenAiCompatibleVisionClient } from '../llm/openai-compatible-vision.js';
import type { LlmVisionClient } from '../llm/vision-types.js';
import type { Env } from '../env.js';
import type { CharacterPersona, ProposedCharacterProfile } from '@over18/shared';
import {
  CharacterPersonaValidationError,
  validateCharacterPersona,
} from './character-persona-service.js';

/**
 * Avatar-derived persona generation (Phase 2).
 *
 * Structurally the vision-input counterpart of character-profile-service.ts's
 * Autofill: a swappable generator function, a typed kind-only error, tolerant
 * JSON extraction, strict field validation, and env-based provider selection.
 * Runs ONCE per character-creation/regeneration action — never per chat
 * message, and never writes to the database itself (see
 * character-persona-service.ts's regenerateCharacterPersona for persistence).
 */

export interface PersonaGeneratorInput {
  /** The character's existing display name, so the profile matches who she is. */
  displayName: string;
  /** Raw bytes of the character's primary reference image. */
  imageBytes: Buffer;
  /** The image's stored MIME type (e.g. "image/jpeg"). */
  imageMimeType: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* IN THAT INTERFACE
 *
 * A name, the bytes, and the MIME type. No shortBio, no personality, no
 * interests, no previous persona, no previous generation. There is no field
 * through which any of it could arrive, which is the point: this is a
 * structural guarantee, not an instruction the model is asked to honour.
 *
 * THIS REVERSES AN EARLIER DECISION, ON PURPOSE. Her profile used to be
 * supplied here so the persona could not contradict a bio an operator had
 * written. It worked — and that was the problem. "FROM HER PHOTO" was
 * reading the photo AND the paragraph beside it, so whatever the previous
 * text said kept steering the result: regenerating against a genuinely
 * different reference image still came back wearing the old life, and no one
 * looking at the output could tell which parts the camera had actually
 * supplied. Anchoring is not something a prompt can opt out of — the only
 * way to know a result came from the photo is for the photo to be all there
 * was.
 *
 * "Keep what already fits" did not need to happen during generation. It is a
 * comparison between two finished descriptions, and it now happens after one,
 * against a profile read separately — see the regenerate route, which shows
 * the operator both versions and writes automatically only into fields that
 * were empty. Nothing is lost; it just stops leaking backwards into the
 * generation it is supposed to be compared against.
 * ─────────────────────────────────────────────────────────────────────── */

/**
 * What one analysis produces: the structured persona, plus the character
 * profile the photo implies.
 *
 * `profile` is a PROPOSAL and is absent whenever the model omitted it or it
 * failed the descriptive-only check below. Its absence never fails the
 * generation — the persona is the deliverable, the profile rewrite is an
 * offer, and losing the offer must not cost the operator the persona.
 */
export interface PersonaGenerationResult {
  persona: CharacterPersona;
  profile?: ProposedCharacterProfile;
}

/** The seam. Swapping the model, or stubbing it in tests, replaces only this. */
export type PersonaGenerator = (input: PersonaGeneratorInput) => Promise<PersonaGenerationResult>;

export class PersonaGeneratorError extends Error {
  constructor(
    public readonly kind: 'not_configured' | 'unavailable' | 'invalid_output',
    message: string,
  ) {
    super(message);
    this.name = 'PersonaGeneratorError';
  }
}

/** Used when no vision-capable endpoint is configured. Fails clearly, never fakes. */
export const unconfiguredPersonaGenerator: PersonaGenerator = () => {
  throw new PersonaGeneratorError(
    'not_configured',
    'AI is not configured in this environment, so persona generation is unavailable. ' +
      'The character keeps her existing identity data.',
  );
};

/**
 * Pulls the JSON object out of a model reply. Tolerant of prose or code
 * fences around the object, same rationale as Autofill's extractJsonObject:
 * demanding a bare object makes this flaky for no good reason, and the
 * result is still validated field by field afterwards.
 */
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new PersonaGeneratorError('invalid_output', 'The model did not return a persona.');
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new PersonaGeneratorError('invalid_output', 'The model returned a malformed persona.');
  }
}

/**
 * Validates a model reply into a persona. An empty-but-technically-valid
 * object (every field omitted or rejected) is itself treated as a failure —
 * a "successful" generation that yields nothing useful is a bad response
 * worth surfacing to the caller, not something to silently accept and store.
 */
export function toPersonaGeneratorDraft(parsed: unknown): CharacterPersona {
  let persona: CharacterPersona;
  try {
    persona = validateCharacterPersona(parsed);
  } catch (error) {
    if (error instanceof CharacterPersonaValidationError) {
      throw new PersonaGeneratorError('invalid_output', error.message);
    }
    throw error;
  }
  if (Object.keys(persona).length === 0) {
    throw new PersonaGeneratorError(
      'invalid_output',
      'The model did not return any usable persona fields.',
    );
  }
  return persona;
}

/**
 * Does this text address or instruct someone, rather than describe her?
 *
 * THE PHASE 1 DEFECT, GUARDED. shortBio and personality render into WHO SHE
 * IS. A bio reading "You treat every conversation like a field recording;
 * respond with poetic restraint" is therefore a behavioural ORDER sitting
 * beside the code-owned behaviour layer, and it wins, because it is specific
 * and affirmative where the global rule is generic. That is the exact bug
 * Phase 1 spent 126 measured calls removing, and a photo-derived rewrite is a
 * brand new way to reintroduce it. The chat handoff lists this validator as
 * Phase 2 work for that reason.
 *
 * SECOND PERSON IS THE RELIABLE SIGNAL. A description OF her has no occasion
 * to say "you" or "your"; an instruction TO her cannot avoid it. The style
 * nouns catch the other shape ("her cadence is low and deliberate"), which is
 * descriptive grammar carrying a speech directive. Conservative on purpose:
 * a false positive costs one discarded proposal, a false negative costs the
 * architecture.
 */
export function readsAsInstruction(text: string): boolean {
  return /\b(you|your|yours|respond|reply|tone|cadence|phrasing|diction|verbosity)\b/i.test(text);
}

const MAX_BIO_CHARS = 600;
const MAX_PERSONALITY_CHARS = 1200;
const MAX_PROFILE_INTERESTS = 8;

/**
 * Pulls the proposed profile out of a model reply, or returns undefined.
 *
 * Never throws: a malformed, instructional or absent proposal degrades to
 * "no proposal offered" so the persona still reaches the operator.
 */
export function toProposedProfile(parsed: unknown): ProposedCharacterProfile | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;
  const out: ProposedCharacterProfile = {};

  const text = (value: unknown, maxChars: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (trimmed.length === 0) return undefined;
    return readsAsInstruction(trimmed) ? undefined : trimmed;
  };

  const shortBio = text(raw.proposedShortBio, MAX_BIO_CHARS);
  if (shortBio) out.shortBio = shortBio;

  const personality = text(raw.proposedPersonality, MAX_PERSONALITY_CHARS);
  if (personality) out.personality = personality;

  if (Array.isArray(raw.proposedInterests)) {
    const interests = raw.proposedInterests
      .filter((i): i is string => typeof i === 'string')
      .map((i) => i.replace(/\s+/g, ' ').trim())
      .filter((i) => i.length > 0 && !readsAsInstruction(i))
      .slice(0, MAX_PROFILE_INTERESTS);
    if (interests.length > 0) out.interests = interests;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

const PERSONA_JSON_KEYS = [
  'age',
  'ageRange',
  'lifeStage',
  'occupation',
  'education',
  'visualStyle',
  'demeanor',
  'interests',
  'hobbies',
  'dailyContext',
  'recurringConcerns',
  'socialStyle',
  'humorStyle',
  'flirtingStyle',
  'speechRegister',
  'backgroundNotes',
  'relationshipToWorkOrSchool',
  'sourceSummary',
] as const satisfies ReadonlyArray<keyof CharacterPersona>;

/**
 * Her established profile, restated for the generator as binding facts.
 *
 * Returns an empty array when nothing is written yet, so a quick-created
 * draft's prompt is byte-identical to before this existed.
 */
/**
 * The instruction set + the image, kept beside its own parser rather than in
 * the prompt builder: this is an authoring tool that runs once at
 * creation/regeneration time, not part of how a character speaks in chat.
 *
 * Privacy guardrails are stated explicitly and repeatedly (system message AND
 * key list) per the Phase 2 handoff: this analyses a FICTIONAL character from
 * visible cues, and must never infer real-world sensitive traits.
 *
 * ONE SOURCE, AND IT IS THE PHOTO. Her existing profile is not described to
 * the model and cannot be: see the note on PersonaGeneratorInput for why that
 * is now a property of the input's shape rather than a line of instruction.
 * The model gets a name so it need not invent one, an image, and the keys to
 * fill. Everything it returns is therefore attributable to the image in front
 * of it — including the proposed bio, which is what makes the later
 * side-by-side against her current bio worth reading at all.
 *
 * The proposal is never written by generation — see PersonaGenerationResult.
 */
/**
 * ORDINARY JOBS, DELIBERATELY BROAD AND DELIBERATELY FLAT.
 *
 * NOT a default and NOT a cycle. A few of these are sampled per request and
 * offered as suggestions; the model may take one, or any other equally ordinary
 * job, and real evidence in the image outranks the whole list.
 *
 * WHY A POOL AT ALL. The sampling temperature is fixed at 0.4 in
 * `createLlmPersonaGenerator` below and cannot be configured, so the same
 * prompt and the same photo land on the same modal answer nearly every time.
 * Varying the PROMPT is the only lever this layer has: a different shortlist
 * each run gives the model a different starting point, with no change to model
 * configuration.
 *
 * FLAT ON PURPOSE. The list this replaces read "marketing or sales manager",
 * "project or office manager", "restaurant or retail manager", and about a
 * third of it was administrative or managerial. Two things followed. The
 * compound entries invited the model to blend them, which is where "Marketing
 * coordination manager" came from -- a title assembled out of three of my own
 * options. And the admin cluster was where the modal answer for a featureless
 * portrait sat, so that is what a generic portrait kept returning.
 *
 * So: one plain title per entry, never an "X or Y", and no occupational family
 * big enough to dominate. Admin and marketing roles are still here because they
 * are perfectly ordinary jobs; they are simply no longer the centre of gravity.
 */
const ORDINARY_OCCUPATIONS = [
  'primary school teacher',
  'secondary school maths teacher',
  'nurse',
  'midwife',
  'paramedic',
  'physiotherapist',
  'dentist',
  'pharmacist',
  'optometrist',
  'radiographer',
  'veterinary nurse',
  'speech therapist',
  'social worker',
  'accountant',
  'bookkeeper',
  'payroll administrator',
  'tax adviser',
  'financial analyst',
  'insurance broker',
  'bank branch adviser',
  'solicitor',
  'paralegal',
  'software developer',
  'data analyst',
  'QA tester',
  'IT support technician',
  'technical writer',
  'translator',
  'graphic designer',
  'architect',
  'structural engineer',
  'quantity surveyor',
  'logistics planner',
  'warehouse supervisor',
  'supermarket buyer',
  'estate agent',
  'travel agent',
  'flight attendant',
  'chef',
  'baker',
  'barista',
  'florist',
  'hairdresser',
  'personal trainer',
  'librarian',
  'museum guide',
  'civil servant',
  'council planning officer',
  'journalist',
  'sales representative',
  'customer success specialist',
  'HR specialist',
  'recruitment consultant',
  'executive assistant',
  'project manager',
  'operations coordinator',
  'marketing executive',
] as const;

/** How many suggestions ride along with one request. */
const OCCUPATION_SUGGESTIONS = 6;

/**
 * A few of the pool, in a different order every call.
 *
 * Partial Fisher-Yates over a copy: unbiased, no repeats inside one shortlist,
 * and linear rather than a sort with a random comparator, which is neither
 * uniform nor stable. `random` is injectable for one reason only -- so a test
 * can pin the selection.
 */
export function sampleOccupations(
  count = OCCUPATION_SUGGESTIONS,
  random: () => number = Math.random,
): string[] {
  const pool = [...ORDINARY_OCCUPATIONS] as string[];
  const take = Math.max(0, Math.min(count, pool.length));
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, take);
}

export function buildPersonaPrompt(
  input: PersonaGeneratorInput,
  /** Test seam only. Production passes nothing and gets a fresh shortlist. */
  options: { random?: () => number } = {},
) {
  const suggestions = sampleOccupations(OCCUPATION_SUGGESTIONS, options.random);
  return [
    {
      role: 'system' as const,
      content: [
        'You analyse ONE reference image of a FICTIONAL ADULT woman for an adult fiction chat product, and write a structured character-identity profile from what the image visibly supports.',
        'She is always a fictional adult. Never write anything implying a minor.',
        'Separate what the image visibly shows from the fictional character choices you make from it — you may invent a believable everyday life (occupation, hobbies, daily context), but do not claim uncertain fictional details were directly observed.',
        'Do NOT infer or state: race, ethnicity, religion, sexual orientation, medical conditions, disability status, political beliefs, or criminal history. Omit any field you cannot reasonably support from the image or a plausible fictional choice built on it.',
        // THE EXEMPLAR IS LOAD-BEARING, AND IT USED TO BE THE PROBLEM.
        //
        // This line read: 'Prefer concrete, specific, lived-in details ("runs
        // a small vintage-furniture shop out of a converted garage") ... Avoid
        // stereotypes and exaggerated archetypes.' It was the only occupation
        // example anywhere in the prompt, so it set the pattern for every
        // occupation produced -- small independent cultural business, quirky
        // premises. "Horticulturist at an ornamental public garden with an
        // on-site cafe" and "curator at a private rare-book library" are
        // stylistic clones of it, not coincidences.
        //
        // "Avoid stereotypes" made it worse from the other side: a model reads
        // nurse, teacher and accountant as stereotypical, so the one
        // instruction meant to prevent caricature was also penalising exactly
        // the ordinary jobs this product wants. Hence the explicit correction
        // below that a common job is not a stereotype.
        // THE EXEMPLAR IS NO LONGER AN OCCUPATION, AND THAT IS THE POINT.
        // It used to be "teaches Year 4 at a primary school a ten-minute walk
        // from her flat": concrete, ordinary, and the strongest single anchor
        // in the prompt. One character came back as a Year 4 teacher at a
        // neighbourhood primary school, near enough verbatim. Illustrating
        // specificity with a NON-occupational detail keeps the instruction
        // and removes the pull.
        'Prefer concrete, specific, lived-in details ("knows which caf\u00e9 on her road opens earliest, because she is usually there before it does") over abstract adjective lists ("stylish, creative, adventurous"). Avoid caricature and exaggerated archetypes — but a common, ordinary job is NOT a stereotype, and is not something to avoid.',
        'She should read as an ordinary adult woman someone could plausibly meet, grounded in contemporary everyday life rather than in a novel.',
        // EVIDENCE AND INVENTION ARE DIFFERENT THINGS, AND THE PROMPT HAD NO
        // WORDS FOR THE SECOND ONE. The old rule said "if the image gives an
        // obvious occupation clue use it, OTHERWISE choose a common
        // occupation", which reads as though a job were always somehow
        // derivable. For a plain portrait it is not, and the honest answer is
        // that the job is invented. Saying so is what makes varying it
        // legitimate rather than inconsistent.
        'HER JOB IS USUALLY NOT IN THE PICTURE. Treat an occupation as shown by the image ONLY when something in the frame actually establishes it — a uniform, a workplace, tools, equipment, a vehicle, signage. Her face, her age, her build, her clothing, her makeup, her hair and a leisure setting are NEVER evidence of a job, and an ambiguous hint is not evidence either. For an ordinary portrait the honest position is that her occupation is unknown from the photo.',
        'WHEN IT IS UNKNOWN, INVENT ONE FREELY AND DIFFERENTLY EACH TIME. Choose a plain, mainstream job, state it as a simple fact about her, and do NOT present it as something the photo shows. Vary it: do not keep returning the same job, or the same KIND of job, that an ordinary portrait most obviously suggests. Do not lean towards marketing, administration, coordination or management — those are ordinary jobs and may be chosen, but they are not the default.',
        'ONE PLAIN TITLE, NEVER A STACK OF THEM. "graphic designer", "nurse", "accountant" — not "marketing coordination manager", not "operations and administration lead", not two or three job words welded together. If a title needs a slash, a conjunction or a third noun to make sense, it is the wrong title.',
        'An unusual occupation is allowed only when the image genuinely establishes it — never to make her more interesting, sophisticated, artistic, mysterious or literary. Avoid elaborate or boutique workplaces such as private rare-book libraries, exclusive clubs, boutique cultural institutions or highly niche research facilities.',
        'Whatever the job is, the rest of her must fit it. Her education, her daily routine, what she worries about and what she does with her time should be what that job and that life would actually produce — the occupation changes between runs, the coherence does not.',
        `Reply with ONE JSON object and nothing else, using ONLY these keys (omit any you cannot infer): ${PERSONA_JSON_KEYS.join(', ')}, plus proposedShortBio, proposedPersonality and proposedInterests. Array fields (demeanor, interests, hobbies, dailyContext, recurringConcerns, backgroundNotes, proposedInterests) are short string lists. Every field is DATA describing her, never an instruction to anyone.`,
        'proposedShortBio (1-2 sentences) and proposedPersonality (1-3 sentences) describe who she is as this photo shows her. Write them in the THIRD PERSON, about her, as statements of fact. Never address her as "you", never write an instruction, and never describe how she should speak, phrase things or sound — no tone, cadence, register or style directions of any kind. Describe the person, not a performance.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: [
        {
          type: 'text' as const,
          text: [
            `Analyse this reference image for "${input.displayName}" and write her profile as the JSON object described.`,
            '',
            // Unconditional now. This used to be attached to the profile
            // block, so the everyday-texture fields were only ever asked for
            // when a profile existed -- exactly backwards, since a character
            // with no profile is the one who needs them most.
            'Work from the image: who it shows, and the everyday life it plausibly belongs to — her routine, what she worries about, how she jokes and how she flirts. This photo is the only thing you know about her.',
            '',
            // PER-REQUEST, and the reason repetition breaks at a fixed
            // temperature: every instruction above is identical run to run,
            // so the shortlist is the only thing that differs. Suggestions
            // only -- "or any other" is load-bearing, and evidence still
            // outranks it.
            `If the photo does not establish her job, take one of these, or any other equally ordinary job that is not on this list: ${suggestions.join(', ')}.`,
            '',
            'Reply with the JSON object only.',
          ].join('\n'),
        },
        {
          type: 'image_url' as const,
          image_url: { url: `data:${input.imageMimeType};base64,${input.imageBytes.toString('base64')}` },
        },
      ],
    },
  ];
}

export interface LlmPersonaGeneratorOptions {
  maxTokens?: number;
  temperature?: number;
}

export function createLlmPersonaGenerator(
  client: LlmVisionClient,
  options: LlmPersonaGeneratorOptions = {},
): PersonaGenerator {
  return async (input) => {
    let raw: string;
    try {
      raw = await client.generate({
        messages: buildPersonaPrompt(input),
        maxTokens: options.maxTokens ?? 700,
        temperature: options.temperature ?? 0.4,
      });
    } catch (error) {
      // Never surface a provider body or key. Kind only, like Autofill/chat.
      if (error instanceof LlmError) {
        throw new PersonaGeneratorError(
          error.kind === 'not_configured' ? 'not_configured' : 'unavailable',
          error.kind === 'timeout'
            ? 'Persona generation took too long. Try again.'
            : "Persona generation couldn't reach the AI service. Try again.",
        );
      }
      throw error;
    }
    const parsed = extractJsonObject(raw);
    // The persona is required; the profile rewrite is an offer that may be
    // absent, malformed or instructional without costing the operator the
    // persona they asked for.
    return { persona: toPersonaGeneratorDraft(parsed), profile: toProposedProfile(parsed) };
  };
}

/**
 * Environment-based selection, mirroring selectProfileAuthor. Reuses the
 * chat LLM configuration by default (env.personaVision falls back to it — see
 * env.ts) so nothing extra needs to be set to try it against the already
 * configured model. With no vision config at all, generation reports itself
 * unavailable instead of inventing a persona.
 */
export function selectPersonaGenerator(env: Env): PersonaGenerator {
  return env.personaVision
    ? createLlmPersonaGenerator(createOpenAiCompatibleVisionClient(env.personaVision))
    : unconfiguredPersonaGenerator;
}
