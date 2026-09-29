import { asc, eq, sql } from 'drizzle-orm';
import type { ChatMessage } from '@over18/shared';
import type { Db } from '../db/client.js';
import { characterPersonas, characters, messages } from '../db/schema.js';
import { getConversationForUser } from './conversation-service.js';
import type { ReplyProvider } from './character-reply.js';
import { deterministicReplyProvider } from './character-reply.js';

/**
 * She speaks first, once, in a conversation nobody has spoken in yet.
 *
 * ── WHAT DECIDES WHETHER SHE GREETS ──────────────────────────────────────────
 *
 * The conversation having NO messages. Not "was it just created": that flag is
 * consumed the moment `startConversation` returns, so a generation that failed
 * would leave the character permanently silent with no way back. Emptiness is a
 * fact that can be re-read, which is what makes a retry safe and an existing
 * empty conversation eligible.
 *
 * ── WHY THE GUARANTEE CANNOT LIVE IN THE CLIENT ──────────────────────────────
 *
 * Two tabs, a double tap, a refresh mid-flight, or a retry after a response was
 * lost in transit all produce concurrent requests from one visitor. Only the
 * database can arbitrate between them, so it does -- the same
 * `pg_advisory_xact_lock` idiom `paid-action-service`, `subscription-service`
 * and `wallet-service` already use for exactly this reason.
 *
 * ── THE LOCK IS TAKEN AFTER GENERATION, NOT BEFORE ───────────────────────────
 *
 * Deliberate. Holding it across a model call would make a visitor's first
 * message queue behind a greeting they may never see. So the model is called
 * first, unlocked, and the lock is held only long enough to re-read the
 * conversation and insert -- milliseconds. A greeting that loses the race is
 * thrown away rather than written, which costs one wasted generation and keeps
 * the chat responsive.
 */

export type OpeningOutcome =
  /** She greeted: a new character message exists. */
  | { status: 'created'; message: ChatMessage }
  /** Somebody had already spoken here. Not an error, and not a retry candidate. */
  | { status: 'already_started' }
  /** Another request greeted, or the visitor spoke, while this one generated. */
  | { status: 'raced' };

/** Generation failed. The caller reports nothing to the visitor; a retry is safe. */
export class OpeningMessageError extends Error {
  constructor(public readonly cause: unknown) {
    super('Opening message generation failed.');
    this.name = 'OpeningMessageError';
  }
}

/** One key per conversation, and this service is the only thing that takes it. */
const lockKey = (conversationId: string) => `conversation-opening:${conversationId}`;

async function messageCount(tx: Db, conversationId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return row?.count ?? 0;
}

/**
 * Generates and stores her opening message, at most once per conversation.
 *
 * Returns null when the conversation does not exist or belongs to someone else
 * -- the same "no existence leaks" convention `getConversationForUser` follows,
 * so the route answers 404 either way.
 */
export async function ensureOpeningMessage(
  db: Db,
  userId: string,
  conversationId: string,
  provider: ReplyProvider = deterministicReplyProvider,
): Promise<OpeningOutcome | null> {
  const conversation = await getConversationForUser(db, userId, conversationId);
  if (!conversation) return null;

  // Cheap pre-check OUTSIDE the lock: the overwhelmingly common case is a
  // conversation that already has messages, and that answer costs one count.
  // It is not the guarantee -- the re-read under the lock below is.
  if ((await messageCount(db, conversationId)) > 0) return { status: 'already_started' };

  // Read server-side only, exactly as the ordinary reply path reads them.
  const [personaRow] = await db
    .select({ systemPrompt: characters.systemPrompt })
    .from(characters)
    .where(eq(characters.id, conversation.character.id));
  const [avatarPersonaRow] = await db
    .select({ persona: characterPersonas.persona })
    .from(characterPersonas)
    .where(eq(characterPersonas.characterId, conversation.character.id));

  let content: string;
  try {
    content = await provider({
      character: conversation.character,
      systemPrompt: personaRow?.systemPrompt ?? '',
      persona: avatarPersonaRow?.persona ?? null,
      // Empty by construction: this runs only when nothing has been said.
      history: [],
      priorMessageCount: 0,
      // Never sent and never stored -- `buildOpeningMessages` ignores it and
      // appends an instruction instead. Present only because ReplyContext
      // requires it.
      userMessage: '',
    });
  } catch (error) {
    throw new OpeningMessageError(error);
  }

  const trimmed = content.trim();
  // A provider that returns nothing is a failed generation, not a silent
  // greeting: writing an empty bubble would be worse than writing none.
  if (trimmed === '') throw new OpeningMessageError(new Error('empty opening message'));

  return db.transaction(async (tx) => {
    /**
     * SERIALISE, THEN RE-READ. Everything before this point may have happened
     * twice concurrently; from here only one request proceeds.
     *
     * `sendMessage` takes this same lock for its whole transaction, so the two
     * paths cannot interleave: if the visitor's first message is being written,
     * this waits, sees it, and discards the greeting rather than inserting one
     * that would appear AFTER something he said.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(conversationId)}, 0))`);
    if ((await messageCount(tx as unknown as Db, conversationId)) > 0) return { status: 'raced' };

    const [row] = await tx
      .insert(messages)
      .values({ conversationId, sender: 'character', content: trimmed })
      .returning();

    /**
     * A greeting is an ORDINARY character message on the wire, so it is
     * serialised as the full shared `ChatMessage`. The annotation is what keeps
     * it that way: the first version of this built the object by hand and
     * omitted `sender`, which is the single field the client styles the bubble
     * from, and nothing complained.
     *
     * `media` is absent because a greeting never carries any -- selection is
     * driven by an explicit request on the send path, which this is not.
     *
     * Not reusing message-service's mapper on purpose: that module imports the
     * lock key from this one, and a cycle between them would work today only
     * because of how the two happen to be declared.
     */
    const message: ChatMessage = {
      id: row!.id,
      sender: row!.sender,
      content: row!.content,
      createdAt: row!.createdAt.toISOString(),
    };
    return { status: 'created', message };
  });
}

/** Exported for the message service, so both paths take the identical key. */
export const openingLockKey = lockKey;

/** Oldest-first message ids, for tests that assert ordering. */
export async function messageOrder(db: Db, conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: messages.id, sender: messages.sender })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq));
  return rows.map((r) => r.sender);
}
