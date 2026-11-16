import { asc, eq } from 'drizzle-orm';
import {
  MY_AI_CHOICES,
  MY_AI_INTERESTS,
  type MyAiMessage,
  type PublicCharacter,
} from '@over18/shared';
import type { Db } from '../../db/client.js';
import {
  userCompanionMessages,
  type UserCompanionMessageRow,
  type UserCompanionRow,
} from '../../db/schema.js';
import type { ReplyContext, ReplyProvider } from '../character-reply.js';

/**
 * Talking to a companion you made.
 *
 * ── SHE GOES THROUGH THE SAME MIND AS EVERYONE ELSE ─────────────────────────
 *
 * This file builds a `ReplyContext` and hands it to the injected
 * `ReplyProvider` — the very one the catalogue's chat uses. It does not know
 * which model answers, does not hold a key, and does not build a prompt: the
 * behaviour rules, the safety framing and the conversation-stage tuning that
 * 126 live calls went into are the SAME for a companion as for a character,
 * because they are about how to have a conversation and nothing about who she
 * is.
 *
 * ── WHAT ACTUALLY REACHES THE MODEL ─────────────────────────────────────────
 *
 * Five fields, and no more: her name, a short bio, her personality, her
 * interests, and her age. `prompt-builder` deliberately renders neither
 * `conversationStyle` nor a stored `systemPrompt` — both are behavioural, and
 * letting character data issue behavioural orders is the bug that made
 * production write scenes instead of having conversations. So her character
 * is carried entirely by descriptive facts, which is all a companion has
 * anyway: the user chose attributes, not instructions.
 */

/** Oldest first — the order a conversation is read in and sent in. */
export function listMessages(db: Db, companionId: string): Promise<UserCompanionMessageRow[]> {
  return db
    .select()
    .from(userCompanionMessages)
    .where(eq(userCompanionMessages.companionId, companionId))
    .orderBy(asc(userCompanionMessages.createdAt));
}

export function toMessageWire(row: UserCompanionMessageRow): MyAiMessage {
  return {
    id: row.id,
    sender: row.sender,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

const labelOf = (options: readonly { id: string; label: string }[], id: string) =>
  options.find((o) => o.id === id)?.label ?? id;

/**
 * Her, described — the only thing the prompt builder will render.
 *
 * Written as FACTS about a person, never as instructions to one. "She's a
 * nurse" is a fact; "be flirty" is an order, and orders in this slot compete
 * with the behaviour layer that is allowed to give them.
 */
export function companionAsCharacter(companion: UserCompanionRow): PublicCharacter {
  const a = companion.attributes;

  const look = [
    labelOf(MY_AI_CHOICES.hairColour, a.hairColour).toLowerCase(),
    labelOf(MY_AI_CHOICES.hairStyle, a.hairStyle).toLowerCase(),
  ].join(' ');

  const bio = [
    `She's ${labelOf(MY_AI_CHOICES.ethnicity, a.ethnicity).toLowerCase()}, with ${look} hair and ${labelOf(MY_AI_CHOICES.eyeColour, a.eyeColour).toLowerCase()} eyes.`,
    `She works as a ${labelOf(MY_AI_CHOICES.job, a.job).toLowerCase()}.`,
    `She's his ${labelOf(MY_AI_CHOICES.relationship, a.relationship).toLowerCase()}.`,
  ].join(' ');

  return {
    id: companion.id,
    name: companion.name,
    displayName: companion.name,
    // Text chat does not read a portrait, and hers is owner-scoped anyway.
    profileImage: null,
    age: companion.age,
    shortBio: bio,
    personality: `She's ${labelOf(MY_AI_CHOICES.personality, a.personality).toLowerCase()}.`,
    interests: a.interests.map((id) => labelOf(MY_AI_INTERESTS, id)),
    /*
     * EMPTY ON PURPOSE. `prompt-builder` does not render this field for
     * anybody — it is behavioural by construction — and inventing a value
     * here would be writing into a slot that is deliberately ignored.
     */
    conversationStyle: '',
  };
}

export function companionReplyContext(
  companion: UserCompanionRow,
  history: UserCompanionMessageRow[],
  userMessage: string,
): ReplyContext {
  return {
    character: companionAsCharacter(companion),
    /*
     * EMPTY, like `conversationStyle`, and for the same reason: the builder
     * does not render a stored system prompt. Everything about her travels in
     * the descriptive fields above.
     */
    systemPrompt: '',
    channel: 'text',
    history: history.map((m) => ({
      id: m.id,
      sender: m.sender,
      content: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
    priorMessageCount: history.length,
    userMessage,
    /*
     * HER AGE IS A VERIFIED ADULT FACT HERE, unlike a catalogue character's,
     * where it is an operator's note on a visual identity. A companion cannot
     * exist under 21: the wizard stops there, the shared validator stops
     * there, the database CHECK stops there, and the provider refuses below
     * it. Four independent gates, so stating it is reporting the record.
     */
    verifiedAdultAgeBand: String(companion.age),
  };
}

/**
 * Say something to her, and get her answer.
 *
 * Both messages are written down — hers after the provider answers — so a
 * reload shows the conversation as it happened. If the provider throws,
 * nothing is stored: a user message with no reply would be replayed as
 * history on the next turn and she would appear to have ignored it.
 */
export async function sendMessage(
  db: Db,
  replyProvider: ReplyProvider,
  companion: UserCompanionRow,
  body: string,
): Promise<{ user: UserCompanionMessageRow; reply: UserCompanionMessageRow }> {
  const history = await listMessages(db, companion.id);
  const trimmed = body.trim();

  const answer = await replyProvider(companionReplyContext(companion, history, trimmed));

  const written = await db
    .insert(userCompanionMessages)
    .values([
      { companionId: companion.id, sender: 'user' as const, body: trimmed },
      { companionId: companion.id, sender: 'character' as const, body: answer.trim() },
    ])
    .returning();

  /*
   * Both rows land in one statement, so they cannot half-arrive — but two
   * rows inserted in the same transaction can share a `created_at` to the
   * microsecond, and a conversation sorted by time would then be a coin toss.
   * The returned order is the insert order, which is the truth.
   */
  const [user, reply] = written;
  return { user, reply };
}
