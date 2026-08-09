import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { VisualDna } from '@over18/shared';

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

export const messageSender = pgEnum('message_sender', ['user', 'character']);

/**
 * messages — the chat history of a conversation (US-07).
 * Strictly children of conversations; ownership is enforced through the
 * parent conversation, never per-message.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // Monotonic ordering key: created_at alone is ambiguous because both
    // messages of an exchange share one transaction timestamp.
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    sender: messageSender('sender').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('messages_conversation_seq_idx').on(table.conversationId, table.seq)],
);

/**
 * memories — durable user facts the character remembers (US-12).
 *
 * Stored SEPARATELY from raw messages (acceptance criterion): extraction
 * distills messages into short facts; the originals stay untouched in
 * `messages`. Scope is strictly (user_id, character_id) — what a user tells
 * one character is never visible to another (product decision, 2026-08-09).
 *
 * content is internal prompt material: like characters.system_prompt it is
 * NEVER exposed through the public API. There is deliberately no user-facing
 * view/edit/delete surface in the PoC — recorded as a future privacy/product
 * requirement (see README).
 *
 * The unique index doubles as the deduplication guarantee: re-extracting an
 * identical fact is a no-op at the database level.
 */
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** The durable fact, short plain text (e.g. "Their name is Maya."). */
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memories_user_character_content_uq').on(
      table.userId,
      table.characterId,
      table.content,
    ),
    index('memories_user_character_idx').on(table.userId, table.characterId),
  ],
);

/**
 * ── Character Visual Identity (US-16A) ──────────────────────────────────
 *
 * Swipey owns the character's visual identity: a versioned Visual DNA record
 * plus a lifecycle-managed set of visual assets. The image model/provider is
 * a later, replaceable implementation detail (US-16D) — it does NOT own
 * identity. US-16A is the data/architecture foundation only: no generation,
 * no provider, no object storage, no endpoints, no UI.
 */

export const visualIdentityStatus = pgEnum('visual_identity_status', [
  'draft',
  'active',
  'retired',
]);
export const visualAssetKind = pgEnum('visual_asset_kind', ['reference', 'generated']);
export const visualAssetStatus = pgEnum('visual_asset_status', [
  'generated',
  'under_review',
  'approved',
  'rejected',
]);
/** 18+ readiness plug-point ONLY. US-16A carries the classification; it does
 * NOT implement adult generation, policy, moderation, or access control. */
export const contentRating = pgEnum('content_rating', ['sfw', 'explicit']);

/**
 * character_visual_identities — the versioned visual identity of a character.
 *
 * A character may have many versions; exactly one is `active` (enforced by a
 * partial unique index). A deliberate redesign creates a new version and
 * retires the old one — previous versions are never overwritten, so identity
 * has provenance and rollback. visual_dna holds IDENTITY attributes only;
 * presentation (clothing/pose/scene/lighting/…) is a generation-time concern
 * and never appears here.
 */
export const characterVisualIdentities = pgTable(
  'character_visual_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: visualIdentityStatus('status').notNull().default('draft'),
    visualDna: jsonb('visual_dna').$type<VisualDna>().notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('character_visual_identities_character_version_uq').on(
      table.characterId,
      table.version,
    ),
    // At most ONE active identity version per character.
    uniqueIndex('character_visual_identities_active_uq')
      .on(table.characterId)
      .where(sql`${table.status} = 'active'`),
    index('character_visual_identities_character_idx').on(table.characterId),
  ],
);

/**
 * character_visual_assets — a first-class visual asset (not characters.profile_image).
 *
 * Unified table: `kind` distinguishes reference vs generated, `status` tracks
 * the lifecycle, and `is_canonical` marks membership of the approved canonical
 * reference set. Canonical means, and only means:
 *   kind = 'reference' AND status = 'approved' AND is_canonical = true.
 * A generated asset NEVER auto-promotes — canonical status is reachable only
 * through an explicit approval transition (which records approved_by/at).
 *
 * provenance is server-side-only internal metadata (like characters.system_prompt);
 * it must never be serialised through any public wire mapper. storage_key is a
 * reserved forward-compatible field — US-16A moves no image bytes.
 */
export const characterVisualAssets = pgTable(
  'character_visual_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    visualIdentityId: uuid('visual_identity_id')
      .notNull()
      .references(() => characterVisualIdentities.id, { onDelete: 'cascade' }),
    kind: visualAssetKind('kind').notNull(),
    status: visualAssetStatus('status').notNull(),
    isCanonical: boolean('is_canonical').notNull().default(false),
    position: integer('position'),
    storageKey: text('storage_key'),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default({}),
    contentRating: contentRating('content_rating').notNull().default('sfw'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('character_visual_assets_character_idx').on(table.characterId),
    index('character_visual_assets_identity_kind_status_idx').on(
      table.visualIdentityId,
      table.kind,
      table.status,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type CharacterRow = typeof characters.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type CharacterVisualIdentityRow = typeof characterVisualIdentities.$inferSelect;
export type CharacterVisualAssetRow = typeof characterVisualAssets.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
