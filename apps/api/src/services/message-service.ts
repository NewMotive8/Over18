import { asc, count, eq } from 'drizzle-orm';
import type { ChatMessage, SendMessageResult } from '@over18/shared';
import type { Db } from '../db/client.js';
import { conversations, messages, type MessageRow } from '../db/schema.js';
import { getConversationForUser } from './conversation-service.js';
import { deterministicReplyProvider, type ReplyProvider } from './character-reply.js';

/**
 * Message service (US-07). Transport-agnostic; ownership is enforced by
 * resolving the conversation through the same owner-scoped lookup US-06
 * established — callers with no access simply see null.
 */

function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sender: row.sender,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Full message history, oldest first. Null when the conversation isn't the caller's. */
export async function listMessages(
  db: Db,
  userId: string,
  conversationId: string,
): Promise<ChatMessage[] | null> {
  const conversation = await getConversationForUser(db, userId, conversationId);
  if (!conversation) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq));
  return rows.map(toChatMessage);
}

/**
 * Sends a user message and produces the character's reply ATOMICALLY:
 * user message insert, reply generation, character message insert, and the
 * conversation's updated_at bump all happen in one transaction — if any
 * step fails the whole exchange rolls back and nothing persists.
 *
 * Null when the conversation isn't the caller's.
 */
export async function sendMessage(
  db: Db,
  userId: string,
  conversationId: string,
  content: string,
  replyProvider: ReplyProvider = deterministicReplyProvider,
): Promise<SendMessageResult | null> {
  const conversation = await getConversationForUser(db, userId, conversationId);
  if (!conversation) return null;

  return db.transaction(async (tx) => {
    const [{ priorCount }] = (await tx
      .select({ priorCount: count() })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))) as [{ priorCount: number }];

    const [userRow] = await tx
      .insert(messages)
      .values({ conversationId, sender: 'user', content })
      .returning();

    const replyText = await replyProvider({
      character: conversation.character,
      priorMessageCount: Number(priorCount),
      userMessage: content,
    });

    const [characterRow] = await tx
      .insert(messages)
      .values({ conversationId, sender: 'character', content: replyText })
      .returning();

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    return {
      userMessage: toChatMessage(userRow!),
      characterMessage: toChatMessage(characterRow!),
    };
  });
}
