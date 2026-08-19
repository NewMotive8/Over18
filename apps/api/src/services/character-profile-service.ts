import { LlmError, type LlmClient } from '../llm/types.js';
import type { Env } from '../env.js';
import { createOpenAiCompatibleClient } from '../llm/openai-compatible.js';

/**
 * Character profile Autofill.
 *
 * Produces a complete, randomised character profile the operator can edit and
 * re-roll. It is a real domain capability, not a UI convenience: the profile it
 * writes is the same `characters` record that already feeds conversations, and
 * will feed content generation and the Clip Director. There is no second
 * character model — the fields below are exactly US-03's.
 *
 * PROVIDER-NEUTRAL BY CONSTRUCTION. It talks to the existing `LlmClient`
 * abstraction, so the model or vendor can change without touching this file,
 * and the call happens in the API — never from the browser and never through a
 * hosted Custom GPT.
 *
 * DRAFT-ONLY. This never writes to the database. It returns a candidate the
 * operator reviews, edits and explicitly saves; re-rolling can therefore never
 * destroy edits already made, and Autofill can never touch a character's
 * media, visual identity or any other unrelated data — it has no access to
 * them.
 */

export interface CharacterProfileDraft {
  displayName: string;
  shortBio: string;
  personality: string;
  conversationStyle: string;
  systemPrompt: string;
  interests: string[];
}

export interface ProfileAuthorInput {
  /** The character's existing display name, so the persona matches who she is. */
  displayName: string;
  /**
   * Varies the output between calls so "Autofill again" gives a genuinely
   * different profile. Injected rather than generated here, so tests are
   * deterministic and nothing in this module depends on a clock or RNG.
   */
  variationSeed: string;
}

/** The seam. Swapping the model, or stubbing it in tests, replaces only this. */
export type ProfileAuthor = (input: ProfileAuthorInput) => Promise<CharacterProfileDraft>;

export class ProfileAuthorError extends Error {
  constructor(
    public readonly kind: 'not_configured' | 'unavailable' | 'invalid_output',
    message: string,
  ) {
    super(message);
    this.name = 'ProfileAuthorError';
  }
}

/** Used when no inference endpoint is configured. Fails clearly, never fakes. */
export const unconfiguredProfileAuthor: ProfileAuthor = () => {
  throw new ProfileAuthorError(
    'not_configured',
    'AI is not configured in this environment, so Autofill is unavailable. You can still fill the profile in by hand.',
  );
};

const MAX_FIELD_CHARS = 2000;
const MAX_INTERESTS = 8;

/**
 * Pulls the JSON object out of a model reply.
 *
 * Models wrap JSON in prose or code fences often enough that demanding a bare
 * object would make Autofill flaky for no good reason. Taking the outermost
 * braces is tolerant without being credulous — the result is still validated
 * field by field below.
 */
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new ProfileAuthorError('invalid_output', 'The model did not return a profile.');
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new ProfileAuthorError('invalid_output', 'The model returned a malformed profile.');
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProfileAuthorError('invalid_output', `The model omitted "${field}".`);
  }
  return value.trim().slice(0, MAX_FIELD_CHARS);
}

/**
 * Validates a model reply into a draft. Strict: a partial profile is a failure,
 * not something to paper over, because the operator is about to save it.
 */
export function toProfileDraft(parsed: unknown, fallbackDisplayName: string): CharacterProfileDraft {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProfileAuthorError('invalid_output', 'The model did not return a profile.');
  }
  const raw = parsed as Record<string, unknown>;

  const interests = Array.isArray(raw.interests)
    ? raw.interests
        .filter((i): i is string => typeof i === 'string')
        .map((i) => i.trim())
        .filter((i) => i.length > 0)
        .slice(0, MAX_INTERESTS)
    : [];

  return {
    // The display name is the character's identity, not the model's to invent:
    // it falls back to the existing one rather than failing the whole draft.
    displayName:
      typeof raw.displayName === 'string' && raw.displayName.trim().length > 0
        ? raw.displayName.trim().slice(0, 120)
        : fallbackDisplayName,
    shortBio: requireText(raw.shortBio, 'shortBio'),
    personality: requireText(raw.personality, 'personality'),
    conversationStyle: requireText(raw.conversationStyle, 'conversationStyle'),
    systemPrompt: requireText(raw.systemPrompt, 'systemPrompt'),
    interests,
  };
}

/** The instruction set. Kept here, beside its parser, not in the prompt builder:
 *  this is an authoring tool, not part of how a character speaks in chat. */
export function buildProfilePrompt(input: ProfileAuthorInput) {
  return [
    {
      role: 'system' as const,
      content: [
        'You write character profiles for an adult fiction chat product.',
        'Every character is a FICTIONAL ADULT woman. Never write a minor.',
        '',
        'Reply with ONE JSON object and nothing else. Keys:',
        '  displayName        - her name, a short human name',
        '  shortBio           - 1-2 sentences, first or third person',
        '  personality        - 1-3 sentences on how she comes across',
        '  conversationStyle  - 1-2 sentences on HOW she talks',
        '  systemPrompt       - instructions addressed to her, starting "You are ..."',
        '  interests          - 3-6 short strings',
        '',
        'Make her specific and memorable rather than generic. Do not write',
        'explicit sexual content in these fields; they describe who she is.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: [
        `Write a complete profile for a character named "${input.displayName}".`,
        `Make this profile clearly different from other attempts. Variation token: ${input.variationSeed}.`,
        'Reply with the JSON object only.',
      ].join('\n'),
    },
  ];
}

export interface LlmProfileAuthorOptions {
  maxTokens?: number;
  /** High by default: re-rolling must produce a genuinely different persona. */
  temperature?: number;
}

export function createLlmProfileAuthor(
  client: LlmClient,
  options: LlmProfileAuthorOptions = {},
): ProfileAuthor {
  return async (input) => {
    let raw: string;
    try {
      raw = await client.generate({
        messages: buildProfilePrompt(input),
        maxTokens: options.maxTokens ?? 900,
        temperature: options.temperature ?? 1.0,
      });
    } catch (error) {
      // Never surface a provider body or key. Kind only, like the chat path.
      if (error instanceof LlmError) {
        throw new ProfileAuthorError(
          error.kind === 'not_configured' ? 'not_configured' : 'unavailable',
          error.kind === 'timeout'
            ? 'Autofill took too long. Try again.'
            : "Autofill couldn't reach the AI service. Try again.",
        );
      }
      throw error;
    }
    return toProfileDraft(extractJsonObject(raw), input.displayName);
  };
}

/**
 * Environment-based selection, mirroring selectReplyProvider: the same single
 * LLM configuration serves chat and Autofill, so there is no second endpoint,
 * no second key, and nothing extra to set in Railway. With no endpoint
 * configured Autofill reports itself unavailable instead of inventing text.
 */
export function selectProfileAuthor(env: Env): ProfileAuthor {
  return env.llm
    ? createLlmProfileAuthor(createOpenAiCompatibleClient(env.llm))
    : unconfiguredProfileAuthor;
}
