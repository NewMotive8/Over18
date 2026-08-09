import type { ChatMessage } from '@over18/shared';
import type { LlmMessage } from '../llm/types.js';
import type { ReplyContext } from './character-reply.js';

/**
 * Server-side prompt/context builder (US-09).
 *
 * Single, testable place where character persona becomes model context.
 * Composes the character's internal system_prompt with the public persona
 * fields (identity, personality, interests, conversation style) and the
 * behavioral rules that keep replies in character.
 *
 * Deliberately replaceable: createLlmReplyProvider takes a PromptBuilder
 * parameter (defaulting to buildLlmMessages below), so a future personality
 * engine can swap this module without touching the LLM integration, the
 * message service, or the API. Everything here is server-side only — the
 * composed prompt never appears in any API response.
 */

export type PromptBuilder = (context: ReplyContext) => LlmMessage[];

/** Character instruction block: identity → persona → core prompt → conduct. */
export function buildCharacterSystemPrompt(context: ReplyContext): string {
  const { character, systemPrompt } = context;

  const sections: string[] = [];

  // 1. Identity
  const identityLines = [`You are ${character.displayName}.`];
  if (character.shortBio.trim()) {
    identityLines.push(`About you: ${character.shortBio.trim()}`);
  }
  sections.push(identityLines.join('\n'));

  // 2. Public persona fields
  const persona: string[] = [];
  if (character.personality.trim()) {
    persona.push(`Personality: ${character.personality.trim()}`);
  }
  if (character.interests.length > 0) {
    const interests = character.interests.map((i) => i.trim()).filter(Boolean);
    if (interests.length > 0) {
      persona.push(`Your interests: ${interests.join(', ')}.`);
    }
  }
  if (character.conversationStyle.trim()) {
    persona.push(`How you talk: ${character.conversationStyle.trim()}`);
  }
  if (persona.length > 0) {
    sections.push(persona.join('\n'));
  }

  // 3. Core character instructions (internal system_prompt from the DB)
  if (systemPrompt.trim()) {
    sections.push(systemPrompt.trim());
  }

  // 4. Remembered user facts (US-12). Rendered as given — bounding happens
  // in createPromptBuilder via selectMemoriesForPrompt, so this stays a pure
  // renderer. Facts are user-derived but live inside the system message as a
  // clearly-delimited list the model is told to use, not obey.
  const memories = context.memories ?? [];
  if (memories.length > 0) {
    sections.push(
      [
        'Things you remember about this person from your conversations so far:',
        ...memories.map((fact) => `- ${fact}`),
        'Bring these up naturally when they are relevant. Never recite this list or mention that you keep notes.',
      ].join('\n'),
    );
  }

  // 5. Conduct rules (US-09)
  sections.push(
    [
      'Conversation rules:',
      `- You are chatting one-on-one with someone who chose to talk to you. Treat this as a personal, ongoing conversation.`,
      `- Always stay in character as ${character.displayName}. Never break character.`,
      '- Do not describe yourself as an AI, a language model, an assistant, or a bot.',
      '- Speak naturally, in your own voice. React to what the other person actually said.',
      '- Do not repeat yourself or fall back on canned phrases; vary your wording across the conversation.',
      "- Keep replies conversational in length — a few sentences unless your style or the moment genuinely calls for more.",
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/**
 * Full model context: composed character instructions as the system message,
 * then the conversation history in order (user→user, character→assistant),
 * then the new user message last. User-authored text only ever appears in
 * user-role messages — never inside the character instruction block.
 */

/** Context-window policy (US-10). Bounds the HISTORY only — the character
 * instructions and the newest user message are always included in full. */
export interface ContextWindowOptions {
  /** Maximum number of prior messages included, newest first. */
  maxHistoryMessages: number;
  /** Maximum total characters of prior-message content included (~4 chars ≈ 1 token). */
  maxHistoryChars: number;
}

export const DEFAULT_CONTEXT_WINDOW: ContextWindowOptions = {
  maxHistoryMessages: 40,
  maxHistoryChars: 16_000,
};

/**
 * Deterministic context-window selection (US-10).
 *
 * Walks the history from NEWEST to OLDEST, keeping whole messages while both
 * budgets allow; the survivors are returned in their original chronological
 * order. Messages are never edited, summarized, or reordered — a message is
 * either included verbatim or dropped entirely, so truncation can never
 * alter or leak content. Same inputs always produce the same window.
 */
export function selectContextWindow(
  history: ChatMessage[],
  options: ContextWindowOptions = DEFAULT_CONTEXT_WINDOW,
): ChatMessage[] {
  const selected: ChatMessage[] = [];
  let usedChars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (selected.length >= options.maxHistoryMessages) break;
    if (usedChars + message.content.length > options.maxHistoryChars) break;
    usedChars += message.content.length;
    selected.push(message);
  }
  return selected.reverse(); // back to chronological order
}

/** Memory-injection policy (US-12). Bounds the remembered facts only —
 * persona, system prompt, US-10 history window, and the newest user message
 * are unaffected. */
export interface MemoryInjectionOptions {
  /** Maximum number of memories injected into the system message. */
  maxMemories: number;
  /** Maximum total characters of memory content injected. */
  maxMemoryChars: number;
}

export const DEFAULT_MEMORY_INJECTION: MemoryInjectionOptions = {
  maxMemories: 10,
  maxMemoryChars: 2_000,
};

/**
 * Deterministic memory selection (US-12), mirroring selectContextWindow:
 * walks NEWEST to OLDEST keeping whole facts while both budgets allow, then
 * returns the survivors in their original (oldest-first) order. Facts are
 * included verbatim or dropped whole — never edited or summarized.
 */
export function selectMemoriesForPrompt(
  memories: string[],
  options: MemoryInjectionOptions = DEFAULT_MEMORY_INJECTION,
): string[] {
  const selected: string[] = [];
  let usedChars = 0;
  for (let i = memories.length - 1; i >= 0; i--) {
    const fact = memories[i]!;
    if (selected.length >= options.maxMemories) break;
    if (usedChars + fact.length > options.maxMemoryChars) break;
    usedChars += fact.length;
    selected.push(fact);
  }
  return selected.reverse();
}

/** Builds a PromptBuilder with explicit context-window and memory policies. */
export function createPromptBuilder(
  windowOptions: ContextWindowOptions = DEFAULT_CONTEXT_WINDOW,
  memoryOptions: MemoryInjectionOptions = DEFAULT_MEMORY_INJECTION,
): PromptBuilder {
  return (context) => [
    {
      role: 'system',
      content: buildCharacterSystemPrompt({
        ...context,
        memories: selectMemoriesForPrompt(context.memories ?? [], memoryOptions),
      }),
    },
    ...selectContextWindow(context.history, windowOptions).map(
      (message): LlmMessage => ({
        role: message.sender === 'user' ? 'user' : 'assistant',
        content: message.content,
      }),
    ),
    { role: 'user', content: context.userMessage },
  ];
}

/** Default prompt builder: default context window applied. */
export const buildLlmMessages: PromptBuilder = createPromptBuilder();
