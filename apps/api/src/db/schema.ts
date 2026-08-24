import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
/**
 * US-103 CROSS-SPRINT: the smallest possible authorization concept.
 * Two values, no RBAC, no groups, no permission matrix — its only job is to
 * stop an ordinary authenticated app user invoking generation operations that
 * spend real money. Defaults to 'user', so every existing row is unprivileged.
 */
export const userRole = pgEnum('user_role', ['user', 'admin']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('user'),
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
    /**
     * Character Media Messages (commit 1) — the OPTIONAL library asset this
     * message carries. Null for every message that exists today AND for every
     * message the current code path writes: nothing in this commit ever sets
     * it, so the column is inert until a later commit adds media selection.
     *
     * A REFERENCE, never a URL and never a path. The client is handed a
     * message-scoped route instead, so the asset id, its storage key and its
     * provenance never leave the server.
     *
     * ON DELETE SET NULL mirrors generation_results.asset_id: deleting a
     * Library asset must degrade one bubble, never cascade into a user's
     * conversation history.
     *
     * The forward reference to characterVisualAssets (declared below) is safe —
     * Drizzle stores the callback and resolves it lazily, not at module load.
     */
    mediaAssetId: uuid('media_asset_id').references(() => characterVisualAssets.id, {
      onDelete: 'set null',
    }),
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
/**
 * What ROLE an asset plays. Not a status, not a rating — a role.
 *
 *  reference — the character's identity images. Visual Identity owns them.
 *  generated — her CONTENT: the Regular and Explicit shelves, and anything the
 *              generation pipeline or the Content Library produces.
 *  chat      — media a character may send inside a private conversation, and
 *              NOTHING else.
 *
 * WHY `chat` IS A KIND AND NOT A RATING OR A FLAG. Before it existed, a chat
 * asset and a Regular video were byte-identical on every column — same kind,
 * same status, same is_canonical, same content_rating — so "may this be sent in
 * a chat?" and "may this be merchandised into a public category?" had literally
 * the same answer for the same row. `kind` is already the axis that answers
 * "what is this FOR", and it is already the axis every public query excludes
 * `reference` on, so the boundary lands where the existing ones live.
 *
 * IT IS SERVER-SET, ALWAYS. No upload route accepts a kind from the client;
 * the server derives it from the Character-page section that was used. A
 * browser can name a shelf, never an enum value.
 */
export const visualAssetKind = pgEnum('visual_asset_kind', ['reference', 'generated', 'chat']);
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
    /**
     * Which CONFIGURED content requirement this asset satisfies, if any.
     *
     * Deliberately a nullable free-text KEY, not an enum and not a foreign key,
     * and this slice never writes a value to it. It exists so the configurable
     * content-requirements work lands as a pure ADDITION rather than a
     * migration that re-shapes assets:
     *
     *  - free text, so new categories are CONFIGURATION rows, not schema
     *    changes — an enum would need a migration per new requirement type;
     *  - nullable, so every existing asset stays valid and uncategorised
     *    content reads as "needs triage" rather than being silently miscounted;
     *  - a loose key rather than an FK to a requirement ROW, so requirements
     *    can be re-versioned, renamed or re-scoped without rewriting assets.
     *    Matching is by key at read time, which is what makes "existing
     *    approved content counts toward changed requirements" free, and what
     *    guarantees a requirements change never deletes or regenerates media.
     *
     * NOTE: this is a join point, not a requirement definition. No category
     * names are hard-coded anywhere in this slice.
     */
    requirementKey: text('requirement_key'),
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
    // The requirement board's query: every asset of one character, grouped by
    // the category it satisfies. Runs on every Review and character page load.
    index('character_visual_assets_character_requirement_idx').on(
      table.characterId,
      table.requirementKey,
    ),
  ],
);

/** US-105 — lifecycle of a submitted generation job. */
export const generationJobStatus = pgEnum('generation_job_status', [
  'queued',
  'running',
  'completed',
  /** Some outputs succeeded and some failed — successes are never discarded. */
  'partial',
  'failed',
  'cancelled',
  /** US-103: a sequence step whose required input never materialised. */
  'blocked',
]);

/**
 * generation_sequence_runs — one execution of a saved sequence (US-103).
 *
 * A sequence is an ordered list of steps; a RUN is one pass through it. Each
 * step becomes a generation_jobs row carrying `sequence_run_id` + `step_ordinal`,
 * so "which sequence produced this asset?" is answerable by joining job -> run.
 */
export const generationSequenceRuns = pgTable(
  'generation_sequence_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sequenceId: uuid('sequence_id').references(() => generationSequences.id, {
      onDelete: 'set null',
    }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    status: generationJobStatus('status').notNull().default('queued'),
    totalSteps: integer('total_steps').notNull(),
    completedSteps: integer('completed_steps').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('generation_sequence_runs_character_idx').on(table.characterId)],
);

/**
 * generation_jobs — "what generation request did we actually submit?"
 *
 * Distinct from the configuration ("what do we want?") and from the produced
 * assets ("what came out?"). `effective_config` is the resolved, validated
 * configuration and is what makes a job reproducible and retryable. It carries
 * provider and model BY NAME only — never an API key, endpoint secret or
 * authorization header.
 */
export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    visualIdentityId: uuid('visual_identity_id').references(
      () => characterVisualIdentities.id,
      { onDelete: 'set null' },
    ),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: generationJobStatus('status').notNull().default('queued'),
    effectiveConfig: jsonb('effective_config').notNull(),
    requestedQuantity: integer('requested_quantity').notNull().default(1),
    succeededCount: integer('succeeded_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    estimatedCostUsd: text('estimated_cost_usd'),
    actualCostUsd: text('actual_cost_usd'),
    failures: jsonb('failures').notNull().default(sql`'[]'::jsonb`),
    /** Set when this job is a step of a sequence run. */
    sequenceRunId: uuid('sequence_run_id'),
    stepOrdinal: integer('step_ordinal'),
    /** Bounded so a retry loop can never run away. */
    retryCount: integer('retry_count').notNull().default(0),
    /**
     * Set by the caller so a resubmitted HTTP request cannot silently start a
     * second paid generation. Unique when present.
     */
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('generation_jobs_character_idx').on(table.characterId),
    index('generation_jobs_status_idx').on(table.status),
    index('generation_jobs_sequence_run_idx').on(table.sequenceRunId, table.stepOrdinal),
    uniqueIndex('generation_jobs_idempotency_idx').on(table.idempotencyKey),
  ],
);

/**
 * generation_presets — a saved, valid generation configuration.
 *
 * A preset is NOT a generation engine. It is re-validated against current model
 * capabilities every time it is loaded, so a preset saved before a model changed
 * fails loudly instead of silently generating something else.
 */
export const generationPresets = pgTable(
  'generation_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** NULL = reusable across characters. */
    characterId: uuid('character_id').references(() => characters.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    config: jsonb('config').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('generation_presets_name_idx').on(table.name)],
);

/**
 * generation_sequences — an ORDERED LIST of generation configurations.
 *
 * Deliberately a jsonb array and not a graph: EPIC 11 explicitly excludes
 * branching, conditions, loops, parallel branches, scheduling and triggers. The
 * only dataflow permitted is a step consuming the immediately prior step's
 * output, expressed as `usePreviousStepOutput` on a step.
 */
export const generationSequences = pgTable(
  'generation_sequences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    characterId: uuid('character_id').references(() => characters.id, { onDelete: 'cascade' }),
    steps: jsonb('steps').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('generation_sequences_character_idx').on(table.characterId)],
);

/** US-103 — lifecycle of ONE expected output within a job. */
export const generationResultStatus = pgEnum('generation_result_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
]);

/**
 * generation_results — one row per EXPECTED output of a job.
 *
 * A job with quantity 5 gets five rows at creation time, before anything runs.
 * That is what gives a failed output an identity: "retry result 3" addresses a
 * durable row, so retrying regenerates exactly that output and leaves results
 * 1, 2, 4 and 5 untouched. Counting successes cannot express this.
 *
 * A succeeded result points at the character_visual_assets row it produced;
 * the asset remains the reviewable artefact, so no duplicate asset concept is
 * introduced here.
 */
export const generationResults = pgTable(
  'generation_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => generationJobs.id, { onDelete: 'cascade' }),
    /** 1-based position within the job. Stable for the life of the job. */
    ordinal: integer('ordinal').notNull(),
    status: generationResultStatus('status').notNull().default('pending'),
    assetId: uuid('asset_id').references(() => characterVisualAssets.id, {
      onDelete: 'set null',
    }),
    /** Structured provider/validation error; never raw provider payloads. */
    error: jsonb('error'),
    /** Attempts spent on THIS result, so retry can be bounded per result. */
    attempts: integer('attempts').notNull().default(0),
    estimatedCostUsd: text('estimated_cost_usd'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('generation_results_job_ordinal_idx').on(table.jobId, table.ordinal),
    index('generation_results_status_idx').on(table.status),
  ],
);

/**
 * content_requirements — what content EVERY character needs.
 *
 * THE SINGLE SOURCE OF TRUTH. The Review board, character completion, and
 * "Generate Missing Content" all read these rows; there is no second checklist
 * anywhere, and no category name or quantity is written in TypeScript. The
 * current defaults (1 natural, 1 nude, 2 selfies, 2 sexy, 4 explicit) are
 * SEEDED ROWS, editable in Admin → Settings without a deploy.
 *
 * Category is a PRODUCTION dimension and is deliberately not any of the axes
 * that already exist: `content_rating` is a policy dimension (sfw|explicit
 * cannot express five categories), `kind` is origin, `is_canonical` is gallery
 * membership. They stay separate.
 *
 * Requirements are a CATEGORY + A QUANTITY. Individual slots are never
 * persisted: the board renders `required_quantity` capacity slots at read time,
 * so changing a quantity can never orphan or delete a slot record.
 */
export const contentRequirements = pgTable(
  'content_requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The join value written to character_visual_assets.requirement_key.
     * Immutable after creation — the label is what an operator renames.
     */
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** 'image' | 'video'. Text, not an enum: there is no media_type enum in
     *  this schema and inventing one would constrain future media kinds. */
    mediaType: text('media_type').notNull(),
    requiredQuantity: integer('required_quantity').notNull().default(1),
    /**
     * ADVISORY policy, never a qualification gate. It pre-fills the rating on
     * assignment and gives generation a default; an asset is never silently
     * excluded from its category for having a different rating. NULL = the
     * requirement expresses no preference.
     */
    contentRating: contentRating('content_rating'),
    /**
     * Disabling is the non-destructive retirement path: the requirement leaves
     * the board and stops counting, but its rows, its key and every asset
     * carrying that key survive untouched, and re-enabling restores the board
     * exactly as it was.
     */
    enabled: boolean('enabled').notNull().default(true),
    /**
     * When true, a character's PRIMARY REFERENCE image is filed under this
     * requirement automatically. Configuration, not code: the quick-create path
     * looks this flag up rather than naming a category, so the behaviour is
     * re-pointable from Settings and no category name is hard-coded.
     */
    assignPrimaryReference: boolean('assign_primary_reference').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('content_requirements_key_uq').on(table.key),
    // At most ONE requirement can claim the primary reference, enforced by the
    // database rather than by whichever code path happens to write next.
    uniqueIndex('content_requirements_primary_reference_uq')
      .on(table.assignPrimaryReference)
      .where(sql`${table.assignPrimaryReference} = true`),
    index('content_requirements_position_idx').on(table.position),
  ],
);

/**
 * content_inbox — an uploaded file that has no character YET.
 *
 * NOTE WHAT IS ABSENT: there is no character_id column. An unassigned upload is
 * not a character asset in a nullable state, it is a different entity in a
 * different table, so no character-scoped query — listVisualAssets, the
 * canonical gallery, the chat media selector, the character pages — can reach
 * it. That isolation is structural, not a filter someone must remember to add.
 *
 * Assignment does not move this row into the assets table; it CREATES a proper
 * character_visual_assets row (under_review, so Review is never bypassed) and
 * records its id here, so the intake is auditable after the fact.
 */
export const contentInbox = pgTable(
  'content_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'unassigned' | 'assigned' | 'discarded'. */
    status: text('status').notNull().default('unassigned'),
    mimeType: text('mime_type').notNull(),
    /** Derived from the VALIDATED mime type, never from the filename. */
    mediaType: text('media_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    originalName: text('original_name'),
    /** Absolute path under MEDIA_STORAGE_DIR/inbox. Never sent to a client. */
    storagePath: text('storage_path'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    assignedAssetId: uuid('assigned_asset_id').references(() => characterVisualAssets.id, {
      onDelete: 'set null',
    }),
    assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('content_inbox_status_idx').on(table.status, table.createdAt)],
);

/**
 * app_categories — the user-facing merchandising categories the App CMS
 * manages (US-102.1).
 *
 * NOT content_requirements. That table answers "what must we PRODUCE for a
 * character"; this one answers "how is already-approved content ORGANISED in
 * the app". They share no column, no key and no code path, and conflating them
 * is the most likely way this feature goes wrong — hence this note.
 *
 * IDENTITY IS THE SLUG, NOT THE NAME. `slug` is assigned once and never
 * changes, so anything referencing a category keeps working when an operator
 * renames "Girlfriend" to "Girlfriends". `name` is pure presentation.
 *
 * Presentation metadata is deliberately thin: a name and an optional tagline.
 * Colours, icons, hero art, layout kinds and Home visibility are assumptions
 * about a merchandising model that has not been designed yet (US-102.2/.3/.4).
 * Columns can be added additively later; guessing now bakes the guess in.
 */
export const appCategories = pgTable(
  'app_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable internal identity. Immutable after creation — see above. */
    slug: text('slug').notNull(),
    /** Display name. Freely renameable; nothing references it. */
    name: text('name').notNull(),
    /** Optional user-facing subtitle shown under the category heading. */
    tagline: text('tagline'),
    /**
     * Disabling retires a category from the app without destroying it or its
     * assignments — the non-destructive counterpart to delete, exactly as it
     * works for content requirements.
     */
    enabled: boolean('enabled').notNull().default(true),
    /** Merchandising order. Normalised to 0..n-1 by every reorder. */
    position: integer('position').notNull().default(0),
    /**
     * US-102.4 — whether this category appears on the app's Home surface.
     *
     * A SECOND, INDEPENDENT GATE, not a synonym for `enabled`. `enabled` says
     * the category exists and is usable across the CMS; `home_published` says
     * an operator has deliberately put it on Home. A category can be enabled
     * and absent from Home (the normal case), and un-publishing it from Home
     * leaves the category, its assignments and its order completely intact.
     *
     * Defaults to FALSE so the migration cannot silently publish anything that
     * already exists — "categories do not appear merely because they exist".
     */
    homePublished: boolean('home_published').notNull().default(false),
    /**
     * Order among the Home rails, INDEPENDENT of `position`.
     *
     * Two orders because they answer different questions: `position` is how the
     * operator arranges their CMS workspace, `home_position` is what the app
     * shows. A category can be third in the list and first on Home.
     */
    homePosition: integer('home_position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('app_categories_slug_uq').on(table.slug),
    index('app_categories_position_idx').on(table.position),
    index('app_categories_home_idx').on(table.homePublished, table.homePosition),
  ],
);

/**
 * app_category_assets — which approved Library assets appear in which category.
 *
 * WHY THIS EXISTS IN US-102.1, WHICH BUILDS NO ASSIGNMENT UI. The rule this
 * ticket must guarantee is "deleting a category never deletes content;
 * affected content becomes unassigned and stays in the Library". With nowhere
 * for an assignment to live that rule is vacuously true and untestable. With
 * this table it is enforced by the DATABASE and provable in a test.
 *
 * Read the cascades carefully — they are the whole point:
 *
 *   category_id ON DELETE CASCADE  deleting a CATEGORY drops these LINK rows.
 *                                  The asset row is untouched, so the content
 *                                  becomes unassigned and stays in the Library,
 *                                  available for reassignment.
 *   asset_id    ON DELETE CASCADE  deleting an ASSET drops its links, so a
 *                                  category can never point at a dead row.
 *
 * The composite primary key means an asset appears in a category at most once,
 * while the same asset may sit in many categories — many-to-many with no
 * duplication of the underlying media, as US-102 requires.
 *
 * US-102.2 fills it in: assignment, bulk operations, ordering within a category
 * and the featured flag. What it deliberately does NOT carry is any notion of
 * publishability — that lives on the asset (`status = 'approved'`) and is
 * re-checked on every read, so a link to an asset that later loses approval
 * simply stops being returned rather than being destroyed.
 */
export const appCategoryAssets = pgTable(
  'app_category_assets',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => appCategories.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => characterVisualAssets.id, { onDelete: 'cascade' }),
    /** Order of this asset WITHIN its category. */
    position: integer('position').notNull().default(0),
    /**
     * US-102.2 merchandising emphasis — a BADGE, never a sort key.
     *
     * A presentation flag on the LINK, not on the asset: the same item can be
     * featured in one category and ordinary in another, and nothing about the
     * underlying Library asset changes when it is featured or un-featured.
     *
     * Ordering is `position` alone. Sorting by featured first was tried and
     * removed: it silently overrode the operator's saved arrangement, so a
     * drag that put an ordinary item ahead of a featured one could never stick.
     */
    featured: boolean('featured').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.categoryId, table.assetId] }),
    index('app_category_assets_category_idx').on(table.categoryId, table.position),
    index('app_category_assets_asset_idx').on(table.assetId),
  ],
);

/**
 * banner_creatives — artwork uploaded FOR a banner, and for nothing else
 * (US-102.3).
 *
 * A DEDICATED CMS ASSET, NOT LIBRARY CONTENT. Banner artwork is editorial: it
 * is not a character's content, it does not count toward any content
 * requirement, it never enters Review, and no generation job produces it. Put
 * differently — there is no column here linking to a character, so nothing in
 * the character content lifecycle can reach these rows.
 *
 * The shape deliberately mirrors content_inbox, the other "upload with no
 * character" in this schema: validated mime type, derived media type, byte
 * size, and an absolute storage_path that NEVER goes on the wire. The accepted
 * formats and the size ceiling come from library-upload-service, which is the
 * one authoritative list — banners do not define their own.
 *
 * Deleting a BANNER does not delete its creative: the FK lives on the banner
 * and is ON DELETE SET NULL, so the row and its bytes survive and can be reused.
 */
export const bannerCreatives = pgTable('banner_creatives', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Validated against the shared accepted list before anything is written. */
  mimeType: text('mime_type').notNull(),
  /** 'image' | 'video', derived from the VALIDATED mime type, never the name. */
  mediaType: text('media_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  originalName: text('original_name'),
  /** Absolute path under MEDIA_STORAGE_DIR/banners. Never sent to a client. */
  storagePath: text('storage_path'),
  /**
   * Pixel dimensions when they could be read cheaply. Advisory only — this
   * product has no authoritative dimension rule, so these are shown to the
   * operator alongside a 16:9 recommendation and never used to reject a file.
   */
  width: integer('width'),
  height: integer('height'),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * home_banners — editorial banners for the app's Home surface (US-102.3).
 *
 * WHAT THIS TABLE DOES NOT DECIDE: how Home is composed. Single banner,
 * carousel, placement, whether Home shows banners at all — every one of those
 * is US-102.4. This table owns the banners and their order, nothing more.
 *
 * NOTHING HERE IS A STORED STATE FLAG. Draft/Scheduled/Live/Ended/Unpublished/
 * Needs-attention is derived per read by bannerEffectiveState in
 * @over18/shared, from `status`, the schedule window and whether the
 * dependencies below still resolve. A stored flag would go stale the instant a
 * disabled category was re-enabled.
 *
 * EVERY DEPENDENCY IS ON DELETE SET NULL, and that is the mechanism behind
 * "a banner whose destination disappears becomes Needs attention": the pointer
 * nulls, the derived state flips, public eligibility stops — and the banner
 * keeps its creative, copy, schedule and audience, and stays editable so the
 * operator can repair it. Nothing is ever silently deleted.
 */
export const homeBanners = pgTable(
  'home_banners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    /** Button text. The DESTINATION is the four columns below. */
    ctaLabel: text('cta_label'),
    creativeId: uuid('creative_id').references(() => bannerCreatives.id, {
      onDelete: 'set null',
    }),

    /** 'category' | 'character' | 'content' | 'external'. */
    destinationKind: text('destination_kind').notNull(),
    destinationCategoryId: uuid('destination_category_id').references(() => appCategories.id, {
      onDelete: 'set null',
    }),
    destinationCharacterId: uuid('destination_character_id').references(() => characters.id, {
      onDelete: 'set null',
    }),
    destinationAssetId: uuid('destination_asset_id').references(() => characterVisualAssets.id, {
      onDelete: 'set null',
    }),
    /** https only, shape-validated. Never probed server-side (SSRF). */
    destinationUrl: text('destination_url'),

    /** 'draft' | 'published' | 'unpublished'. Draft is never public. */
    status: text('status').notNull().default('draft'),
    /** 'everyone' | 'new_users' | 'returning_users'. MVP model, see shared. */
    audience: text('audience').notNull().default('everyone'),

    /**
     * Absolute instants, so comparisons are unambiguous. The IANA zone beside
     * them is kept so the editor can render back the wall time that was typed;
     * it is never used for comparison.
     */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    scheduleTimezone: text('schedule_timezone'),

    /**
     * US-102.4 — WHERE on Home this banner renders.
     *
     * 'before_search' | 'below_results'. Two fixed slots, each holding any
     * number of banners in explicit order. Placement is a Home-composition
     * concern, which is why the column arrives with 102.4 rather than 102.3 —
     * 102.3 deliberately owned only the banners themselves and their
     * eligibility, and left composition to this ticket.
     *
     * Defaults to 'before_search' so every banner created before this migration
     * keeps a defined, visible position rather than disappearing.
     */
    slot: text('slot').notNull().default('before_search'),
    /** Order WITHIN the slot. Normalised to 0..n-1 per slot by every reorder. */
    position: integer('position').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('home_banners_position_idx').on(table.slot, table.position),
    index('home_banners_status_idx').on(table.status),
  ],
);

/**
 * home_hero_clips — the Hero carousel, ADMIN-ASSIGNED (US-102.4).
 *
 * Editorial selection only. There is deliberately no performance, engagement or
 * ranking column here: this product has no such data, and the ticket says the
 * mixing rule between editorial and performance selection is still unspecified.
 * A future performance-weighted Hero adds its own inputs; it does not need this
 * table to have guessed at them.
 *
 * Publishability is NOT stored. The clip appears only while its asset is
 * approved, checked on every read exactly as US-102.2 does for category
 * contents — so a clip that loses approval leaves the Hero on its own, and
 * comes back if it is approved again. The link row survives either way.
 */
export const homeHeroClips = pgTable(
  'home_hero_clips',
  {
    assetId: uuid('asset_id')
      .primaryKey()
      .references(() => characterVisualAssets.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('home_hero_clips_position_idx').on(table.position)],
);

/**
 * home_play_with_me_characters — the Play with me rail's CURATED override.
 *
 * THE SAME SHAPE AS home_recent_characters, DELIBERATELY. Both rails show
 * CHARACTER cards, both have one automatic rule and one operator override, and
 * both order by an explicit position. Giving the second rail its own table
 * rather than a discriminator column on the first keeps each table's meaning
 * single: `home_recent_characters.character_id` is its whole primary key, so
 * one table physically cannot hold two rails' membership without changing that
 * key — and a shared table would leak one rail into the other the first time a
 * query forgot its filter.
 *
 * EMPTY MEANS AUTOMATIC. With no rows the rail is every active character,
 * alphabetically, computed per read — exactly what it has always been. With
 * rows it is those characters, in that order, and the automatic rule is not
 * consulted at all: manual never blends with automatic. Deleting the rows
 * restores the automatic behaviour.
 */
export const homePlayWithMeCharacters = pgTable(
  'home_play_with_me_characters',
  {
    characterId: uuid('character_id')
      .primaryKey()
      .references(() => characters.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('home_play_with_me_characters_position_idx').on(table.position)],
);

/**
 * home_recent_characters — RETAINED, UNUSED.
 *
 * RECENTLY ADDED HAS BEEN REMOVED as a product feature. No service reads this
 * table, no route writes it, and no Admin control offers it. It is left defined
 * here ONLY so that removing the feature needed no migration: dropping the
 * table would mean a schema change, and this table holds nothing but operator
 * arrangements for a rail that no longer exists.
 *
 * DO NOT BUILD ON IT. If Recently Added is ever wanted again it should be
 * designed fresh — the automatic-unless-overridden rule this table encoded is
 * exactly what made the rail impossible to curate, because in the automatic
 * state the rail already contained every candidate and the picker had nothing
 * left to offer.
 */
export const homeRecentCharacters = pgTable(
  'home_recent_characters',
  {
    characterId: uuid('character_id')
      .primaryKey()
      .references(() => characters.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('home_recent_characters_position_idx').on(table.position)],
);

/**
 * content_keywords — the vocabulary behind the lower-page Discovery strip
 * (US-102.4).
 *
 * A SEPARATE SYSTEM FROM APP CATEGORIES. App Categories (US-102.1) are
 * editorial collections an operator fills by hand and publishes to Home.
 * Discovery categories are keyword queries over all content. They share no
 * table, no route and no ordering, and neither can affect the other.
 *
 * `key` is the stable normalised identity and is immutable; `label` is what an
 * operator renames — the same slug/name split App Categories use, for the same
 * reason: renaming must never orphan the things pointing at it.
 */
export const contentKeywords = pgTable(
  'content_keywords',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('content_keywords_key_uq').on(table.key)],
);

/**
 * asset_keywords — which keywords a piece of content carries (US-102.4).
 *
 * Many-to-many, because a clip is genuinely several things at once. This is
 * what `requirement_key` on character_visual_assets is NOT: that column is a
 * single nullable join to one content requirement, and overloading it with
 * discovery keywords would have made two unrelated systems fight over one
 * field.
 *
 * Both sides CASCADE: deleting a keyword removes its assignments, deleting an
 * asset removes its keywords. Neither direction can reach the asset's bytes,
 * its status, or its review lifecycle.
 */
export const assetKeywords = pgTable(
  'asset_keywords',
  {
    assetId: uuid('asset_id')
      .notNull()
      .references(() => characterVisualAssets.id, { onDelete: 'cascade' }),
    keywordId: uuid('keyword_id')
      .notNull()
      .references(() => contentKeywords.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.keywordId] }),
    index('asset_keywords_keyword_idx').on(table.keywordId),
  ],
);

/**
 * discovery_categories — the lower-page strip's pills (US-102.4).
 *
 * A discovery category is a NAMED SET OF KEYWORDS, and its membership is
 * derived: every approved asset carrying AT LEAST ONE of its keywords, computed
 * per read. Nothing is materialised, so tagging a new clip updates the strip
 * immediately with no sweep and no refresh job.
 *
 * `position` 0 is the first/default pill. That the first one is "Sexy" is DATA,
 * not a hard-coded name — the strip has no special-cased entries, which is also
 * why the old hard-coded "All" is simply gone rather than reserved.
 */
export const discoveryCategories = pgTable(
  'discovery_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable internal identity. Immutable after creation. */
    slug: text('slug').notNull(),
    /** Display name. Freely renameable. */
    name: text('name').notNull(),
    /** Non-destructive retirement, exactly as App Categories use it. */
    enabled: boolean('enabled').notNull().default(true),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('discovery_categories_slug_uq').on(table.slug),
    index('discovery_categories_position_idx').on(table.position),
  ],
);

/**
 * discovery_category_keywords — which keywords a discovery category matches.
 *
 * Membership is OR: "Sexy = sexy OR lingerie OR seductive". One row per term.
 *
 * DELETING A DISCOVERY CATEGORY CANNOT REACH CONTENT. The cascade runs from the
 * category to these link rows and stops: the keywords survive, every
 * asset_keywords row survives, and no asset is touched. That is the ticket's
 * "removing a discovery category does not delete or modify the underlying
 * content or its keywords", enforced by the foreign keys rather than by
 * remembering to be careful.
 */
export const discoveryCategoryKeywords = pgTable(
  'discovery_category_keywords',
  {
    discoveryCategoryId: uuid('discovery_category_id')
      .notNull()
      .references(() => discoveryCategories.id, { onDelete: 'cascade' }),
    keywordId: uuid('keyword_id')
      .notNull()
      .references(() => contentKeywords.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.discoveryCategoryId, table.keywordId] }),
    index('discovery_category_keywords_keyword_idx').on(table.keywordId),
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
export type GenerationJobRow = typeof generationJobs.$inferSelect;
export type GenerationPresetRow = typeof generationPresets.$inferSelect;
export type GenerationSequenceRow = typeof generationSequences.$inferSelect;
export type GenerationSequenceRunRow = typeof generationSequenceRuns.$inferSelect;
export type GenerationResultRow = typeof generationResults.$inferSelect;
export type ContentRequirementRow = typeof contentRequirements.$inferSelect;
export type ContentInboxRow = typeof contentInbox.$inferSelect;
export type AppCategoryRow = typeof appCategories.$inferSelect;
export type AppCategoryAssetRow = typeof appCategoryAssets.$inferSelect;
export type BannerCreativeRow = typeof bannerCreatives.$inferSelect;
export type HomeBannerRow = typeof homeBanners.$inferSelect;
export type HomeHeroClipRow = typeof homeHeroClips.$inferSelect;
export type HomePlayWithMeCharacterRow = typeof homePlayWithMeCharacters.$inferSelect;
export type HomeRecentCharacterRow = typeof homeRecentCharacters.$inferSelect;
export type ContentKeywordRow = typeof contentKeywords.$inferSelect;
export type AssetKeywordRow = typeof assetKeywords.$inferSelect;
export type DiscoveryCategoryRow = typeof discoveryCategories.$inferSelect;
