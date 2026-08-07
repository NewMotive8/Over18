import { pgTable, pgEnum, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * users — one row per registered account.
 * email is stored normalized (trimmed + lowercased) and is unique.
 * password_hash holds a bcrypt hash, never plaintext, and is never
 * returned through the API.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * sessions — server-managed sessions.
 * token_hash is the SHA-256 hash of the raw session token; the raw token
 * only ever exists in the HttpOnly cookie on the client.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);

export const characterStatus = pgEnum('character_status', ['active', 'inactive']);

/**
 * characters — the AI companion personas users can browse and (later) chat with.
 *
 * - name: unique internal identifier (stable, lowercase slug), used by seeds
 *   and future tooling; display_name is what users see.
 * - system_prompt: internal LLM instruction material — NEVER exposed through
 *   the public API (same allow-list treatment as users.password_hash).
 * - status: only 'active' characters are returned by the API; 'inactive'
 *   soft-hides a character without deleting it.
 */
export const characters = pgTable(
  'characters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    displayName: text('display_name').notNull(),
    profileImage: text('profile_image'),
    shortBio: text('short_bio').notNull(),
    personality: text('personality').notNull(),
    interests: text('interests').array().notNull().default([]),
    conversationStyle: text('conversation_style').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    status: characterStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('characters_status_idx').on(table.status)],
);

/**
 * conversations — one persistent conversation per (user, character) pair.
 *
 * The unique index on (user_id, character_id) is the database-level guarantee
 * behind US-06's "existing conversation is reopened rather than duplicated".
 * Messages arrive in a later story.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('conversations_user_character_uq').on(table.userId, table.characterId),
    index('conversations_user_id_idx').on(table.userId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type CharacterRow = typeof characters.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
