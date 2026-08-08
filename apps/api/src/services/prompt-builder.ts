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
export const buildLlmMessages: PromptBuilder = (context) => {
  return [
    { role: 'system', content: buildCharacterSystemPrompt(context) },
    ...context.history.map(
      (message): LlmMessage => ({
        role: message.sender === 'user' ? 'user' : 'assistant',
        content: message.content,
      }),
    ),
    { role: 'user', content: context.userMessage },
  ];
};
