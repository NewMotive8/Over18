import type { PublicCharacter } from '@over18/shared';
import type { LlmClient, LlmMessage } from '../llm/types.js';
import type { Env } from '../env.js';
import { createOpenAiCompatibleClient } from '../llm/openai-compatible.js';
import { MEMORY_MAX_CONTENT_LENGTH } from './memory-service.js';

/**
 * Memory-extractor seam (US-12), the ReplyProvider pattern applied to
 * memory: the message flow depends only on this contract, and the
 * implementation is selected from the environment.
 *
 * Implementations:
 * - createLlmMemoryExtractor: real extraction via the existing
 *   OpenAI-compatible LlmClient (no new adapter, no vendor coupling).
 * - deterministicMemoryExtractor: conservative rule-based extraction for
 *   development, so memory is demoable end-to-end without a model. Like the
 *   deterministic reply provider it can never run in production (production
 *   without an LLM refuses chat sends entirely; with an LLM, the LLM
 *   extractor is selected).
 * - noopMemoryExtractor: extracts nothing (production-unconfigured guard,
 *   and the default in sendMessage unless one is injected).
 *
 * Extraction failures are ISOLATED by the caller (message flow): a throwing
 * extractor loses at most that exchange's memories, never the chat exchange.
 */

export interface MemoryExtractionContext {
  character: PublicCharacter;
  /** The user's newest message — the only text facts are extracted from. */
  userMessage: string;
}

export type MemoryExtractor = (
  context: MemoryExtractionContext,
) => Promise<string[]> | string[];

/** Extracts nothing. Production guard when no LLM is configured. */
export const noopMemoryExtractor: MemoryExtractor = () => [];

/** Max facts accepted from a single exchange, whatever the extractor says. */
export const MAX_FACTS_PER_EXCHANGE = 5;

/** Free-text value capture: runs to the first sentence punctuation. */
const VALUE = "([\\w'’][\\w'’\\- ]{0,58})";
/** Proper-name capture — validated separately for a capitalized first letter. */
const NAME = "([\\w'’-]{1,40})";

const RELATION =
  '(sister|brother|mom|mother|dad|father|son|daughter|wife|husband|partner|boyfriend|girlfriend|best friend|dog|cat)';

interface Rule {
  pattern: RegExp;
  /** Builds the third-person fact from the match, or null to reject. */
  fact: (m: RegExpMatchArray) => string | null;
}

/** Requires the captured token to look like a proper name (capitalized). */
function properName(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/[.,!?;:]+$/, '') ?? '';
  return /^[A-Z]/.test(value) ? value : null;
}

/** Conversational tails that are noise, not part of the fact's value. */
const TRAILING_FILLER =
  /\s+(these days|nowadays|now|right now|at the moment|currently|by the way|btw|though|tho|lol|haha)$/i;

function plainValue(raw: string | undefined): string | null {
  let value = raw?.trim().replace(/[.,!?;:]+$/, '') ?? '';
  for (let prev = ''; prev !== value; ) {
    prev = value;
    value = value.replace(TRAILING_FILLER, '');
  }
  return value.length > 0 ? value : null;
}

const RULES: Rule[] = [
  {
    pattern: new RegExp(`\\bmy name is ${NAME}`, 'i'),
    fact: (m) => {
      const name = properName(m[1]);
      return name ? `Their name is ${name}.` : null;
    },
  },
  {
    pattern: new RegExp(`\\b(?:i am|i'm) called ${NAME}`, 'i'),
    fact: (m) => {
      const name = properName(m[1]);
      return name ? `Their name is ${name}.` : null;
    },
  },
  {
    pattern: new RegExp(`\\bcall me ${NAME}`, 'i'),
    fact: (m) => {
      const name = properName(m[1]);
      return name ? `Their name is ${name}.` : null;
    },
  },
  {
    pattern: new RegExp(`\\bi live in ${VALUE}`, 'i'),
    fact: (m) => {
      const place = plainValue(m[1]);
      return place ? `They live in ${place}.` : null;
    },
  },
  {
    pattern: new RegExp(`\\b(?:i am|i'm) from ${VALUE}`, 'i'),
    fact: (m) => {
      const place = plainValue(m[1]);
      return place ? `They are from ${place}.` : null;
    },
  },
  {
    pattern: new RegExp(`\\bi work as (an? ${VALUE})`, 'i'),
    fact: (m) => {
      const job = plainValue(m[1]);
      return job ? `They work as ${job}.` : null;
    },
  },
  {
    pattern: new RegExp(`\\bi work at ${VALUE}`, 'i'),
    fact: (m) => {
      const employer = plainValue(m[1]);
      return employer ? `They work at ${employer}.` : null;
    },
  },
  {
    pattern: new RegExp(`\\b(?:i am|i'm) (\\d{1,3}) years old\\b`, 'i'),
    fact: (m) => `They are ${m[1]} years old.`,
  },
  {
    pattern: new RegExp(`\\bmy favou?rite ([\\w ]{1,30}?) is ${VALUE}`, 'i'),
    fact: (m) => {
      const category = plainValue(m[1]);
      const value = plainValue(m[2]);
      return category && value ? `Their favorite ${category.toLowerCase()} is ${value}.` : null;
    },
  },
  {
    pattern: new RegExp(`\\bmy ${RELATION}(?:'s name)? is (?:named |called )?${NAME}`, 'i'),
    fact: (m) => {
      const name = properName(m[2]);
      return name ? `Their ${m[1]!.toLowerCase()} is named ${name}.` : null;
    },
  },
  {
    pattern: new RegExp(
      `\\bi have (?:a|an|two|three|\\d+) (dogs?|cats?|puppy|puppies|kitten|kittens)\\b(?: (?:named|called) ${NAME})?`,
      'i',
    ),
    fact: (m) => {
      const animal = m[1]!.toLowerCase().replace(/s$/, '').replace(/ie$/, 'y');
      const name = m[2] ? properName(m[2]) : null;
      if (m[2] && !name) return null;
      return name ? `They have a ${animal} named ${name}.` : `They have a ${animal}.`;
    },
  },
];

/**
 * Deterministic development extractor: a small set of conservative,
 * high-precision patterns for first-person durable statements. Same input →
 * same facts, which keeps tests stable and the dev demo predictable.
 * Deliberately favors missing a fact over inventing one.
 */
export const deterministicMemoryExtractor: MemoryExtractor = ({ userMessage }) => {
  const facts: string[] = [];
  for (const rule of RULES) {
    const match = userMessage.match(rule.pattern);
    if (!match) continue;
    const fact = rule.fact(match);
    if (fact && !facts.includes(fact)) facts.push(fact);
    if (facts.length >= MAX_FACTS_PER_EXCHANGE) break;
  }
  return facts;
};

export interface LlmMemoryExtractorOptions {
  maxTokens: number;
}

/** Extraction is a classification-like task: run it cold and short. */
export const DEFAULT_LLM_EXTRACTOR_OPTIONS: LlmMemoryExtractorOptions = {
  maxTokens: 256,
};

const EXTRACTION_INSTRUCTIONS = [
  'You extract durable personal facts about a person from one chat message they wrote.',
  'A durable fact is something about THEM that would still be true and worth remembering weeks from now: their name, age, where they live or come from, their job, family members, pets, or strong lasting likes and dislikes.',
  'Rules:',
  '- Output ONLY the facts, one per line, each line starting with "- ".',
  '- Write each fact in the third person as one short standalone sentence, e.g. "- Their name is Maya."',
  `- At most ${MAX_FACTS_PER_EXCHANGE} facts.`,
  '- Do NOT include small talk, questions, moods, opinions about the conversation partner, or anything temporary.',
  '- If the message contains no durable personal facts, output exactly: NONE',
].join('\n');

/** Turns the model's line-per-fact output into a clean, bounded fact list. */
export function parseExtractedFacts(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /^none[.!]?$/i.test(trimmed)) return [];
  const facts: string[] = [];
  for (const line of trimmed.split('\n')) {
    const fact = line.replace(/^\s*[-*•]\s*/, '').trim();
    if (fact.length === 0 || /^none[.!]?$/i.test(fact)) continue;
    if (fact.length > MEMORY_MAX_CONTENT_LENGTH) continue;
    if (!facts.includes(fact)) facts.push(fact);
    if (facts.length >= MAX_FACTS_PER_EXCHANGE) break;
  }
  return facts;
}

/**
 * Real LLM-backed extraction through the existing OpenAI-compatible client.
 * Uses temperature 0 — extraction is judgment, not creativity. LlmErrors
 * propagate to the caller, which isolates them from the chat exchange.
 * The user's message is sent as the user-role message only; extraction
 * instructions never mix with user-authored text.
 */
export function createLlmMemoryExtractor(
  client: LlmClient,
  options: LlmMemoryExtractorOptions = DEFAULT_LLM_EXTRACTOR_OPTIONS,
): MemoryExtractor {
  return async ({ userMessage }): Promise<string[]> => {
    const messages: LlmMessage[] = [
      { role: 'system', content: EXTRACTION_INSTRUCTIONS },
      { role: 'user', content: userMessage },
    ];
    const raw = await client.generate({
      messages,
      maxTokens: options.maxTokens,
      temperature: 0,
    });
    return parseExtractedFacts(raw);
  };
}

/**
 * Environment-based extractor selection (mirrors selectReplyProvider):
 * - LLM configured        → real LLM-backed extraction (same endpoint/model)
 * - unset, development    → deterministic rule-based extractor (demoable)
 * - unset, production     → noop (chat sends already fail ai_not_configured;
 *                           this guarantees no fake extraction either)
 */
export function selectMemoryExtractor(env: Env): MemoryExtractor {
  if (env.llm) {
    return createLlmMemoryExtractor(createOpenAiCompatibleClient(env.llm));
  }
  return env.isProduction ? noopMemoryExtractor : deterministicMemoryExtractor;
}
