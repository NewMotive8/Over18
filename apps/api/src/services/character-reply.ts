import type { ChatMessage, PublicCharacter } from '@over18/shared';

/**
 * Reply-provider seam (US-07, extended in US-08).
 *
 * This interface is the ONLY contract the message service depends on for
 * producing a character's response. Implementations:
 * - deterministicReplyProvider (below): US-07 placeholder, still the
 *   fallback when no inference endpoint is configured.
 * - createLlmReplyProvider (llm-reply-provider.ts): US-08, backed by a
 *   swappable LlmClient adapter.
 *
 * systemPrompt and history exist ONLY server-side inside this context —
 * they are never serialized into any API response.
 */
export interface ReplyContext {
  character: PublicCharacter;
  /** Internal persona instructions from the DB. Never exposed on the wire. */
  systemPrompt: string;
  /** Prior messages in the conversation, oldest first (excludes the new user message). */
  history: ChatMessage[];
  /** Number of messages already in the conversation before this exchange. */
  priorMessageCount: number;
  userMessage: string;
  /**
   * Durable facts remembered about this user for THIS character (US-12),
   * oldest first. Strictly (user, character)-scoped — never crosses
   * characters. Server-side only, like systemPrompt: never on the wire.
   * Optional so existing ReplyProvider callers/fixtures stay source-compatible.
   */
  memories?: string[];
}

export type ReplyProvider = (context: ReplyContext) => Promise<string> | string;

/**
 * Deterministic, in-character placeholder replies built purely from the
 * character's public persona (display name, bio, personality, interests,
 * conversation style). Same inputs → same reply, which keeps tests stable
 * and the demo predictable.
 */
export const deterministicReplyProvider: ReplyProvider = ({ character, priorMessageCount }) => {
  const interests = character.interests.length > 0 ? character.interests : ['getting to know you'];
  const interest = interests[Math.floor(priorMessageCount / 2) % interests.length]!;

  const templates = [
    `Hey, I'm ${character.displayName}. ${character.shortBio} I'm really glad you're here — tell me something about yourself?`,
    `Mm, I like that. You know, I've been really into ${interest} lately — does that world mean anything to you?`,
    `That makes me smile. People say I'm ${firstClause(character.personality)} — I think you'd find out quickly whether they're right.`,
    `Tell me more. I promise I'm listening — ${firstClause(character.conversationStyle)} is kind of my thing.`,
    `I was just thinking about ${interest} before you wrote. Funny timing. What's pulling at your thoughts today?`,
  ];

  return templates[priorMessageCount % templates.length]!;
};

/** First clause of a sentence, lowercased — turns persona prose into something quotable. */
function firstClause(text: string): string {
  const clause = text.split(/[.,—]/)[0]?.trim() ?? text.trim();
  return clause.charAt(0).toLowerCase() + clause.slice(1);
}
