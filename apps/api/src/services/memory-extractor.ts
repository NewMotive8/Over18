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

/**
 * One spoken turn, as extraction needs to see it.
 *
 * Structurally the transcript row without its ids, declared here rather than
 * imported so the extractor contract does not depend on the call-session module.
 */
export interface TranscriptTurn {
  speaker: 'user' | 'character';
  content: string;
}

export interface MemoryExtractionContext {
  character: PublicCharacter;
  /** The user's newest message — the only text facts are extracted from. */
  userMessage: string;
  /**
   * A finished voice call, in spoken order, when extracting from one.
   *
   * Present ONLY for calls. When it is set, `userMessage` is empty and the turns
   * are the whole input -- so an implementation must branch on this rather than
   * quietly extracting from an empty string.
   */
  transcript?: readonly TranscriptTurn[];
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
export const deterministicMemoryExtractor: MemoryExtractor = ({ userMessage, transcript }) => {
  /**
   * ONLY WHAT THE USER SAID, and for the transcript case that is a structural
   * guarantee rather than an instruction: the character's turns are filtered out
   * before a single pattern runs, so no wording of hers can produce a fact about
   * him. The rules are first-person ("my name is", "I live in"), which is also
   * why they cannot fire on her speech even if it reached them.
   */
  const sources = transcript
    ? transcript.filter((turn) => turn.speaker === 'user').map((turn) => turn.content)
    : [userMessage];

  const facts: string[] = [];
  for (const source of sources) {
    for (const rule of RULES) {
      const match = source.match(rule.pattern);
      if (!match) continue;
      const fact = rule.fact(match);
      if (fact && !facts.includes(fact)) facts.push(fact);
      if (facts.length >= MAX_FACTS_PER_EXCHANGE) break;
    }
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
  '- Write each fact in the third person as one short standalone sentence beginning with "They" or "Their" and ending with a period, e.g. "- Their name is Maya."',
  `- At most ${MAX_FACTS_PER_EXCHANGE} facts.`,
  '- Do NOT include small talk, questions, moods, opinions about the conversation partner, or anything temporary.',
  '- If the message contains no durable personal facts, output exactly: NONE',
].join('\n');

/**
 * The instructions for a whole call, which is a different problem from one message.
 *
 * THE DANGER IS ATTRIBUTION, NOT FORMAT. A transcript contains both voices, and
 * the character spends it asking questions, guessing and suggesting things. "You
 * must be exhausted" is hers, not his, and a model handed the whole conversation
 * will cheerfully turn it into "They are exhausted." So the speakers are labelled
 * and the rule is stated more than once, in the terms the mistake actually takes:
 * a question is not an answer, a guess is not a fact.
 *
 * BOTH VOICES ARE SHOWN ANYWAY, on purpose. Dropping her turns would make his
 * unreadable -- "Maya" as a bare answer means nothing without "what should I call
 * you?" before it. Context is what makes the facts resolvable; labelling is what
 * keeps them attributed.
 *
 * The OUTPUT contract is identical to the single-message one, because
 * `parseExtractedFacts` is the pollution guard for both and is not weakened for
 * this: bullet, third person, finished sentence.
 */
const TRANSCRIPT_EXTRACTION_INSTRUCTIONS = [
  'You are reading a transcript of a phone call between a person and someone they talk to.',
  'Extract durable facts about THE PERSON LABELLED "USER" and nobody else.',
  'A durable fact is something about them that would still be true and worth remembering weeks from now: their name, age, where they live or come from, their job, family, pets, lasting likes and dislikes, plans they have made, and topics they left unresolved and would expect to be asked about again.',
  'ATTRIBUTION RULES, which matter more than anything else here:',
  '- Use ONLY what the USER said. The CHARACTER\'s lines are context for understanding the USER, never a source of facts.',
  '- A question the CHARACTER asked is not an answer. If she asks "do you have a brother?" and the USER does not say he has one, there is no fact.',
  '- A guess, suggestion or sympathy from the CHARACTER is not a fact. If she says "you must be exhausted" and the USER does not agree, there is no fact.',
  '- Never record a fact about the CHARACTER. Nothing about her is remembered here.',
  '- If the USER contradicts or corrects something, record only what they settled on.',
  'Output rules:',
  '- Output ONLY the facts, one per line, each line starting with "- ".',
  '- Write each fact in the third person as one short standalone sentence beginning with "They" or "Their" and ending with a period, e.g. "- Their name is Maya."',
  `- At most ${MAX_FACTS_PER_EXCHANGE} facts. Prefer the most durable ones.`,
  '- Do NOT include small talk, pleasantries, moods, or anything temporary.',
  '- If the USER said nothing durable, output exactly: NONE',
].join('\n');

/** The transcript as the model reads it: labelled, in spoken order, nothing else. */
export function renderTranscriptForExtraction(turns: readonly TranscriptTurn[]): string {
  return turns
    .map((turn) => `${turn.speaker === 'user' ? 'USER' : 'CHARACTER'}: ${turn.content}`)
    .join('\n');
}

/**
 * Turns the model's line-per-fact output into a clean, bounded fact list.
 *
 * This is the pollution guard for persistent memory: only lines that follow
 * the instructed contract are accepted, everything else is silently ignored
 * (never an error — a chatty model loses its chatter, not the exchange).
 * A line qualifies as a fact ONLY if it:
 *   1. is a bullet line ("- ", "* ", or "• " — the instructed format);
 *   2. is a third-person statement about the user, i.e. starts with
 *      "They"/"Their" (covering "They're"/"Their ..."), the only form the
 *      instructions mandate and the only form this system ever produces;
 *   3. ends like a sentence ("." or "!") — which structurally excludes
 *      questions ("?"), headings/preambles (":"), and cut-off fragments.
 * Un-bulleted prose, assistant chatter, instructions, and headings therefore
 * can never silently become memories. This deliberately favors dropping a
 * malformed fact over storing junk, matching the extractor's documented
 * precision-over-recall stance, and is provider-agnostic: every
 * OpenAI-compatible model receives the same format instructions.
 */
export function parseExtractedFacts(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /^none[.!]?$/i.test(trimmed)) return [];
  const facts: string[] = [];
  for (const line of trimmed.split('\n')) {
    const bulleted = line.match(/^\s*[-*•]\s*(.*)$/);
    if (!bulleted) continue; // not the instructed format — model chatter, ignored
    const fact = bulleted[1]!.trim();
    if (fact.length === 0 || /^none[.!]?$/i.test(fact)) continue;
    if (fact.length > MEMORY_MAX_CONTENT_LENGTH) continue;
    if (!/^(?:They|Their)\b/.test(fact)) continue; // not third-person about the user
    if (!/[.!]$/.test(fact)) continue; // not a finished statement (question/heading/fragment)
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
  return async ({ userMessage, transcript }): Promise<string[]> => {
    // A call and a message are the same task with different hazards, so they get
    // different instructions and the same output contract.
    const fromCall = transcript !== undefined;
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: fromCall ? TRANSCRIPT_EXTRACTION_INSTRUCTIONS : EXTRACTION_INSTRUCTIONS,
      },
      {
        role: 'user',
        content: fromCall ? renderTranscriptForExtraction(transcript) : userMessage,
      },
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
