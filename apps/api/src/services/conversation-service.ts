import { and, eq } from 'drizzle-orm';
import type { ConversationSummary } from '@over18/shared';
import type { Db } from '../db/client.js';
import { characters, conversations } from '../db/schema.js';
import { getActiveCharacterById, toPublicCharacter } from './character-service.js';

/**
 * Conversation service — transport-agnostic, following the established
 * service pattern. A conversation is the persistent link between one user
 * and one character; messages arrive in a later story.
 */

export type StartConversationResult =
  | { ok: true; created: boolean; conversation: ConversationSummary }
  | { ok: false; error: 'character_not_found' };

/**
 * Get-or-create the conversation between a user and an active character.
 *
 * Race-safe: relies on the (user_id, character_id) unique index —
 * concurrent starts insert with ON CONFLICT DO NOTHING and both callers
 * read back the single surviving row.
 */
export async function startConversation(
  db: Db,
  userId: string,
  characterId: string,
): Promise<StartConversationResult> {
  const character = await getActiveCharacterById(db, characterId);
  if (!character) {
    return { ok: false, error: 'character_not_found' };
  }

  const inserted = await db
    .insert(conversations)
    .values({ userId, characterId })
    .onConflictDoNothing({
      target: [conversations.userId, conversations.characterId],
    })
    .returning();

  const row =
    inserted[0] ??
    (await db.query.conversations.findFirst({
      where: and(eq(conversations.userId, userId), eq(conversations.characterId, characterId)),
    }));

  // The row must exist at this point: either we inserted it or the conflict
  // means another request already had.
  return {
    ok: true,
    created: inserted.length > 0,
    conversation: { id: row!.id, character, createdAt: row!.createdAt.toISOString() },
  };
}

/**
 * A conversation by id, restricted to its owner. Unknown ids and other
 * users' conversations both read as null — no existence leaks.
 */
export async function getConversationForUser(
  db: Db,
  userId: string,
  conversationId: string,
): Promise<ConversationSummary | null> {
  const rows = await db
    .select({ conversation: conversations, character: characters })
    .from(conversations)
    .innerJoin(characters, eq(conversations.characterId, characters.id))
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.conversation.id,
    character: toPublicCharacter(row.character),
    createdAt: row.conversation.createdAt.toISOString(),
  };
}
