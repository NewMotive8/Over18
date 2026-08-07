import type { PublicCharacter } from '@over18/shared';

/**
 * Reply-provider seam (US-07).
 *
 * This interface is the ONLY contract the message service depends on for
 * producing a character's response. US-08 replaces the deterministic
 * implementation below with the AI orchestrator without touching the
 * message service or the API.
 *
 * Deliberate constraints:
 * - The context contains ONLY public persona fields (PublicCharacter).
 *   system_prompt is not part of this contract and is never read here;
 *   the orchestrator may extend its own implementation-side data access
 *   in US-08, but the seam itself stays prompt-free.
 */
export interface ReplyContext {
  character: PublicCharacter;
  /** Number of messages already in the conversation before this exchange. */
  priorMessageCount: number;
  userMessage: string;
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
