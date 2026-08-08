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

  // 4. Conduct rules (US-09)
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

/** Builds a PromptBuilder with an explicit context-window policy. */
export function createPromptBuilder(
  windowOptions: ContextWindowOptions = DEFAULT_CONTEXT_WINDOW,
): PromptBuilder {
  return (context) => [
    { role: 'system', content: buildCharacterSystemPrompt(context) },
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
