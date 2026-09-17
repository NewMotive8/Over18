import {
  bigserial,
  boolean,
  check,
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
 * favourites — the user-to-character relationship behind the Favourites tab.
 *
 * ONE ROW = ONE USER SAVED ONE CHARACTER, and that is the entire model. It is
 * deliberately the same shape as `conversations`: a composite identity over
 * (user, character) with cascade deletes on both sides, so a deleted account or
 * a deleted character takes its favourites with it and no orphan can be read.
 *
 * NO MEDIA COLUMN, ON PURPOSE. There is no asset id and no url here. What a
 * favourite DISPLAYS is resolved at read time by the same `representativeClips`
 * query that decides Play with me, so replacing a character's published clip
 * changes what Favourites shows on the very next request. A stored locator
 * would have gone stale the moment an operator swapped her content, and would
 * have needed reaping every time an asset lost approval.
 *
 * NO SWIPE HISTORY. A left swipe writes nothing at all — passing is not a
 * decision this product remembers, and there is no table here that could
 * accumulate one. Swiping right inserts; only the heart deletes.
 *
 * The composite primary key is what makes a right swipe IDEMPOTENT: an
 * `on conflict do nothing` insert of an existing pair is a no-op, so swiping
 * right on a character who is already a favourite leaves her favourited with
 * her original `created_at` intact rather than resurfacing her to the top.
 */
export const favourites = pgTable(
  'favourites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.characterId] }),
    // Every read is "this user's favourites"; the primary key already leads
    // with user_id, so this index exists for the ordering the gallery uses.
    index('favourites_user_created_idx').on(table.userId, table.createdAt),
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
/**
 * WHERE AN ASSET CAME FROM -- its ORIGIN, recorded once, at creation (P0.3).
 *
 * The asset model separates concerns that used to be implicit:
 *
 *   role          `kind`          reference | generated (= CONTENT) | chat
 *   origin        `origin`        generated | manual | imported | legacy
 *   workflow      `status`        moderation state (see visual_asset_status)
 *   requirement   `requirement_key`
 *   distribution  `published_at` (Posts) plus the placement tables
 *                 (Hero, categories, keywords) -- never a column here
 *   commercial    reserved for the economy work; nothing here
 *
 * WHY ORIGIN NEEDED ITS OWN COLUMN. It was never recorded as a fact, only
 * implied: a manual upload wrote `provenance.source = 'manual-upload'`, a
 * generation wrote a `jobId` and no source at all, and `kind = 'generated'` --
 * whose name reads like an origin -- is written by BOTH, because `kind` is the
 * asset's ROLE. So "was this generated or uploaded?" had no reliable answer.
 *
 * `provenance` REMAINS THE DETAIL (provider, model, prompt, paths, file name).
 * `origin` is the coarse classification every writer states explicitly; it does
 * not replace or duplicate that detail.
 *
 *   generated  produced by this system's generation pipeline
 *   manual     uploaded by an operator (Character page shelves, Content
 *              Library, and the Content Inbox, which is manual intake staged
 *              before a character is chosen)
 *   imported   brought in from an existing outside source without a per-file
 *              operator upload (e.g. the supplied site portrait)
 *   legacy     origin was never recorded and cannot be established -- never a
 *              guess dressed up as a fact
 */
export const visualAssetOrigin = pgEnum('visual_asset_origin', [
  'generated',
  'manual',
  'imported',
  'legacy',
]);
/**
 * WORKFLOW -- where an asset stands in moderation (P0.4). Read through
 * `services/asset-lifecycle.ts`, never compared ad hoc:
 *
 *   generated, under_review  PENDING REVIEW. Two historical names for one
 *                            queue; both stay valid and neither is rewritten.
 *   approved                 passed moderation. Exposes nothing by itself --
 *                            release (`published_at`) and placement do that.
 *   rejected                 failed moderation. The row, file and provenance
 *                            stay; only deletion removes them.
 *   archived                 was approved, now retired from every surface.
 *                            Media, provenance, lineage and the original
 *                            approval are kept, so nothing is lost; the
 *                            release time and placements are kept too, and
 *                            unarchiving CLEARS them -- it returns the asset to
 *                            Approved, never straight back in front of
 *                            customers.
 *
 * WHY ARCHIVED IS A STATUS AND NOT A FLAG. Every public reader already requires
 * `status = 'approved'` (Posts, Home, categories, Hero, discovery, search, the
 * media route, the chat selector, requirement counts). An archived row fails
 * that one test, so it is hidden from all of them by the rule they already
 * apply -- a separate `archived` flag would have needed every one of those
 * readers edited, and the one that was missed would leak.
 *
 * Appended LAST: Postgres enum order is creation order, and nothing here sorts
 * by it.
 */
export const visualAssetStatus = pgEnum('visual_asset_status', [
  'generated',
  'under_review',
  'approved',
  'rejected',
  'archived',
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
    /**
     * See `visual_asset_origin`. The DEFAULT exists only for backward safety: a
     * process still running the previous code during a deploy keeps inserting
     * successfully, and an unstated origin honestly reads as `legacy`. Every
     * current writer states its origin explicitly.
     */
    origin: visualAssetOrigin('origin').notNull().default('legacy'),
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
    /**
     * When an operator RELEASED this asset to the character's public Posts tab.
     * Null means approved-but-not-released, or never released.
     *
     * ── APPROVED IS NOT PUBLISHED ────────────────────────────────────────────
     *
     * `status = 'approved'` is a MODERATION verdict: the content is acceptable.
     * It has never meant "the public may see this", and the media route has
     * always refused an approved asset that no public surface referenced —
     * "approval alone must not expose the whole Library to id guessing".
     *
     * The Posts tab needed a public surface of its own, and the only ones that
     * existed were PLACEMENTS onto Home: a Hero slot, a published category, a
     * discovery keyword. Gating her own page on those meant a character with
     * five approved clips showed the one that happened to be merchandised, and
     * zero if none was. Measured against the real query: 0 of 5.
     *
     * This column is that missing surface, and it keeps the two ideas apart.
     * Approving still exposes nothing. Releasing is a separate, explicit,
     * reversible act — which is what makes "approved but not yet live" a state
     * an operator can actually hold.
     *
     * ── WHY A TIMESTAMP AND NOT A BOOLEAN ────────────────────────────────────
     *
     * Null versus a time answers "is it live?" exactly as a boolean would, and
     * also records WHEN — which an operator asking "when did this go out?"
     * currently has no way to answer. It matches `approvedAt` beside it, so the
     * two halves of an asset's lifecycle read the same way.
     *
     * NOT A STATUS VALUE. Adding 'published' to `visual_asset_status` would
     * have made release and moderation the same axis, so unpublishing would
     * have had to un-approve, and every existing status query would silently
     * change meaning.
     */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /**
     * When, and by whom, this asset was ARCHIVED (P0.4). Set exactly while
     * `status = 'archived'` -- the check below holds the two together -- and
     * cleared on unarchive. Archiving writes nothing else: `approved_*`,
     * `published_at`, provenance and placements are left as they were.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: uuid('archived_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Archived exactly when an archive time is recorded. Compared as TEXT on
     * purpose: the migration that adds the `archived` enum value runs in the
     * same transaction as this constraint, and Postgres refuses a new enum
     * value as a literal until that transaction commits.
     */
    check(
      'character_visual_assets_archived_consistent',
      sql`(${table.status}::text = 'archived') = (${table.archivedAt} is not null)`,
    ),
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

/* ------------------------------------------------------------------ *
 * Prompt generation workspace (Admin -> Generation)
 *
 * A PRODUCTION TOOL, NOT A CONTENT PIPELINE. An operator uploads .txt
 * prompt files, each becomes one job, each job produces N images through
 * xAI, and every image is uploaded to one configured Google Drive folder.
 * That is the whole product.
 *
 * WHY THESE ARE NOT `generation_jobs`. That table models CHARACTER content:
 * `character_id` is NOT NULL with a foreign key to `characters`, its config is
 * validated against a model registry that has no xAI entry, and every job it
 * runs ends by writing a `character_visual_asset`. This feature must create no
 * asset, touch no character, and reach no public surface — so it gets its own
 * tables rather than three modifications to the pipeline that owns published
 * content. Nothing here references a character, an asset, or a category, and
 * that absence is the isolation guarantee.
 * ------------------------------------------------------------------ */

/**
 * A job's rollup state.
 *
 * `partial` exists for the same reason `generation_job_status` has it: when one
 * output of two succeeds and the other does not, the success is never
 * discarded and the row must not read as a failure.
 */
export const promptJobStatus = pgEnum('prompt_job_status', [
  'queued',
  'generating',
  'uploading',
  'completed',
  'partial',
  'failed',
  'cancelled',
]);

/**
 * One image's state, and the reason outputs are rows rather than columns.
 *
 * `drive_upload_failed` is DELIBERATELY DISTINCT from `failed`. The image
 * exists in the spool and has already been paid for; the only thing missing is
 * a Drive upload. Collapsing the two would make the retry path regenerate an
 * image we already own.
 */
export const promptOutputStatus = pgEnum('prompt_output_status', [
  'pending',
  'generated',
  'uploading',
  'completed',
  'failed',
  'drive_upload_failed',
]);

/** A batch's own lifecycle. `paused` stops STARTING work, never in-flight work. */
export const promptBatchStatus = pgEnum('prompt_batch_status', [
  'draft',
  'running',
  'paused',
  'completed',
]);

export const promptBatches = pgTable(
  'prompt_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    status: promptBatchStatus('status').notNull().default('draft'),
    /** The model id sent to xAI, recorded per batch so history stays readable. */
    model: text('model').notNull(),
    /**
     * The exact generation parameters used, frozen at batch creation.
     * Recorded so a batch run last month can still be explained after the
     * defaults change. Never contains a key of any kind.
     */
    params: jsonb('params').notNull(),
    /** How many images each prompt produces. 2 in V1; the extensibility hook. */
    outputsPerPrompt: integer('outputs_per_prompt').notNull().default(2),
    /** The Drive folder every output of this batch is uploaded into. */
    driveFolderId: text('drive_folder_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [index('prompt_batches_status_idx').on(table.status)],
);

export const promptJobs = pgTable(
  'prompt_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => promptBatches.id, { onDelete: 'cascade' }),
    /** Upload order. Stable for the life of the batch. */
    ordinal: integer('ordinal').notNull(),
    /** The uploaded file's name, verbatim. The basis of every output filename. */
    originalFilename: text('original_filename').notNull(),
    /**
     * The prompt, EXACTLY as uploaded. Never trimmed, normalised, re-encoded or
     * truncated anywhere in this feature — the operator's wording is the input.
     */
    promptText: text('prompt_text').notNull(),
    status: promptJobStatus('status').notNull().default('queued'),
    requestedOutputs: integer('requested_outputs').notNull().default(2),
    succeededCount: integer('succeeded_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    /** Bounded so a recovery sweep can never loop forever on a poisoned row. */
    attempts: integer('attempts').notNull().default(0),
    /** Structured provider/validation error. NEVER a raw provider payload. */
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('prompt_jobs_batch_idx').on(table.batchId, table.ordinal),
    index('prompt_jobs_status_idx').on(table.status),
    /**
     * Uniqueness is PER BATCH, not global: the same prompt file may legitimately
     * be run again in a later batch. Within one batch it makes re-uploading the
     * same file a no-op instead of a second paid generation.
     */
    uniqueIndex('prompt_jobs_batch_filename_idx').on(table.batchId, table.originalFilename),
  ],
);

export const promptJobOutputs = pgTable(
  'prompt_job_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => promptJobs.id, { onDelete: 'cascade' }),
    /** 1-based, and it is what the filename suffix is built from. */
    ordinal: integer('ordinal').notNull(),
    status: promptOutputStatus('status').notNull().default('pending'),
    /** `<original stem>_<ordinal>.jpg`, derived once and stored. */
    outputFilename: text('output_filename').notNull(),
    /**
     * Where the generated bytes wait between xAI and Drive.
     *
     * A SERVER PATH THAT NEVER REACHES A CLIENT — no route serves it and no
     * view includes it. It is what makes a Drive failure retryable without
     * paying xAI a second time, and it is cleared once the upload succeeds.
     */
    spoolPath: text('spool_path'),
    driveFileId: text('drive_file_id'),
    driveWebViewLink: text('drive_web_view_link'),
    /**
     * GENERATION attempts only — how many times xAI has been asked for this
     * image.
     *
     * IT USED TO COUNT UPLOADS TOO, AND THAT WAS A BUG. `outputsNeedingGeneration`
     * gates regeneration on this column, so every failed Drive upload silently
     * spent part of the generation budget: three Drive outages could leave an
     * output that had been generated exactly once permanently ineligible to be
     * generated again. The two budgets answer different questions and now have
     * different columns.
     */
    attempts: integer('attempts').notNull().default(0),
    /**
     * DRIVE UPLOAD attempts, counted separately from `attempts`.
     *
     * Bounded by `MAX_OUTPUT_UPLOAD_ATTEMPTS`. Exhausting it is a terminal but
     * RETRYABLE state — the spooled bytes are still there, so an operator retry
     * re-uploads them and never pays for the image twice.
     */
    uploadAttempts: integer('upload_attempts').notNull().default(0),
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
  },
  (table) => [
    /** One row per (job, ordinal): a restart or a double click cannot make a third image. */
    uniqueIndex('prompt_job_outputs_job_ordinal_idx').on(table.jobId, table.ordinal),
    index('prompt_job_outputs_status_idx').on(table.status),
  ],
);

/**
 * The Drive folder this application created for itself, remembered forever.
 *
 * WHY THIS TABLE EXISTS, AND WHY IT IS NOT AN ENVIRONMENT VARIABLE. The OAuth
 * scope is `drive.file`, which Google defines as access to files "that you open
 * with an app or that the user shares with an app while using the Google Picker
 * API or the app's file picker". A folder the operator made by hand in the
 * Drive web UI is therefore INVISIBLE to this application — Drive answers 404
 * `notFound` for it, which is exactly the production failure this table fixes.
 * The only folder we can address under that scope is one we created ourselves,
 * so the id has to be discovered at runtime and then remembered. An operator
 * cannot type it in in advance, because it does not exist until we make it.
 *
 * `slot` IS THE CREATE-ONCE GUARANTEE. It is unique, so two API processes that
 * both find an empty table and both create a folder cannot both record one:
 * the loser's insert is refused and it adopts the winner's id. Without that
 * uniqueness the safety property would rest on there only ever being one
 * process, which is not a property of a deployment platform.
 *
 * NOTHING SECRET LIVES HERE. A Drive folder id is already returned to the admin
 * UI so the operator can open the folder; it is not a credential, and it grants
 * nothing on its own.
 */
export const promptDriveFolders = pgTable(
  'prompt_drive_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Which destination this row is. One value today: 'default'. */
    slot: text('slot').notNull(),
    /** The id Google assigned when WE created the folder. */
    driveFolderId: text('drive_folder_id').notNull(),
    /** What we named it, kept so the operator can find it in their Drive. */
    folderName: text('folder_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When Drive last confirmed the folder still exists and is not trashed.
     * Null means never checked by this deployment; it is a diagnostic, never a
     * gate — an unverified row is still used.
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('prompt_drive_folders_slot_idx').on(table.slot)],
);

/**
 * The Google Drive connection an operator made from Admin -> Generation.
 *
 * WHY THIS IS NOT `sessions`-SHAPED. A session token is SHA-256 hashed,
 * because the only question ever asked of it is "does this match?". A refresh
 * token has to be REPLAYED at Google's token endpoint, so it must survive in a
 * reversible form — hashing is not merely inconvenient here, it is impossible.
 * That is precisely why it is encrypted rather than stored plainly: a database
 * dump travels further than an environment variable does, and this row would
 * otherwise be a Drive credential sitting in it.
 *
 * AES-256-GCM, key from `PROMPT_GENERATION_TOKEN_KEY`. GCM rather than CBC
 * because it authenticates as well as encrypts: a tampered ciphertext fails to
 * decrypt instead of yielding rubbish that gets sent to Google.
 *
 * `slot` is unique for the same reason `prompt_drive_folders.slot` is: one
 * destination account, and two processes cannot each record a different one.
 */
export const promptDriveConnections = pgTable(
  'prompt_drive_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slot: text('slot').notNull(),
    /** AES-256-GCM parts. Never returned by any route, in any shape. */
    refreshTokenCiphertext: text('refresh_token_ciphertext').notNull(),
    refreshTokenIv: text('refresh_token_iv').notNull(),
    refreshTokenTag: text('refresh_token_tag').notNull(),
    /**
     * Which Google account this is. NOT a credential — it is the one fact an
     * operator needs to confirm they connected the right Drive, and getting it
     * wrong silently is how images end up in a stranger's account.
     */
    googleAccountEmail: text('google_account_email'),
    /** Recorded so a scope that ever widens is visible rather than assumed. */
    scope: text('scope'),
    connectedBy: uuid('connected_by').references(() => users.id, { onDelete: 'set null' }),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Kind only — `auth`, `network` — never a provider body. */
    lastErrorKind: text('last_error_kind'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('prompt_drive_connections_slot_idx').on(table.slot)],
);

/**
 * One in-flight authorization attempt.
 *
 * THE STATE IS THE CSRF DEFENCE, and it is a row rather than a cookie because
 * the callback arrives as a cross-site top-level redirect from Google. A `lax`
 * cookie survives that today, but `strict` would not, and a security control
 * that silently stops working when an unrelated setting changes is not a
 * control. Single-use (deleted when consumed) and short-lived.
 */
export const promptDriveOauthStates = pgTable(
  'prompt_drive_oauth_states',
  {
    state: text('state').primaryKey(),
    /** Who started it, so the callback can be attributed and audited. */
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('prompt_drive_oauth_states_expires_idx').on(table.expiresAt)],
);

/* ------------------------------------------------------------------ *
 * Admin roles and the audit log (PRD v1.2 §34, build step 0c)
 * ------------------------------------------------------------------ */

/**
 * The six operator roles of PRD §34.1.
 *
 * `users.role` IS UNCHANGED AND STILL DECIDES WHO IS STAFF. `requireAdmin`
 * reads it exactly as before, so nothing here can lock an operator out of the
 * admin. A grant refines what a staff member may do; it never makes an ordinary
 * user staff.
 *
 * ALL SIX EXIST AS DATA even if the team decides to run with three (D-9):
 * collapsing is simply not granting the other three, which needs no migration.
 */
export const adminRole = pgEnum('admin_role', [
  'administrator',
  'economy_editor',
  'content_editor',
  'marketing',
  'support',
  'analyst',
]);

/**
 * admin_role_grants -- which roles a staff member holds.
 *
 * One row per (user, role). The migration that creates this table grants
 * `administrator` to every existing `users.role = 'admin'`, so the day
 * permission enforcement is switched on, every current operator can still do
 * exactly what they can do today.
 *
 * THERE IS NO IMPLICIT FALLBACK. An admin with no grant has no permissions once
 * enforcement is on. The alternative -- "no grants means administrator" -- makes
 * revoking someone's last narrow role silently promote them to administrator.
 */
export const adminRoleGrants = pgTable(
  'admin_role_grants',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: adminRole('role').notNull(),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

/**
 * audit_log -- every attributed admin write, append-only.
 *
 * APPEND-ONLY IS ENFORCED BY THE DATABASE, not merely by convention: migration
 * 0026 installs a trigger that rejects UPDATE and DELETE on this table. The
 * service layer exposes no update or delete either, but a lock that only the
 * application honours is not a lock (PRD §5).
 *
 * THE ACTOR IS DELIBERATELY NOT A FOREIGN KEY. An `ON DELETE SET NULL` would be
 * an UPDATE, which the trigger refuses -- so deleting a user would fail -- and
 * an audit trail must outlive the account that wrote it anyway. The email is
 * snapshotted for the same reason: the log has to read correctly after the
 * user row is gone.
 *
 * `before` / `after` are null when the writer cannot know them. The generic
 * request hook records WHICH route was called on WHICH ids but never a request
 * body, because bodies carry credentials (the Drive OAuth flow) and free text;
 * services that own a change record the real before and after explicitly.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    actorEmail: text('actor_email'),
    /** e.g. `admin.roles.grant`, or `PATCH /admin/home/categories/:categoryId`. */
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id'),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    /** Required by the service for anything that affects money or access. */
    reason: text('reason'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index('audit_log_occurred_idx').on(table.occurredAt),
    index('audit_log_object_idx').on(table.objectType, table.objectId),
    index('audit_log_actor_idx').on(table.actorUserId),
  ],
);

/* ------------------------------------------------------------------ *
 * Economy configuration (PRD v1.2 §8, §9, §17, §20, §31) -- P1.1
 *
 * CONFIGURATION IS DATA. Every plan price, pack ladder rung, action cost,
 * allowance and reward lives in these tables, versioned, and nothing in
 * application code may hold an economy value.
 *
 * THREE INDEPENDENT VERSION STREAMS, ONE LIFECYCLE:
 *
 *   economy_plans     -> economy_plan_versions      what a subscription costs
 *   economy_packs     -> economy_pack_versions      what a Credit pack costs
 *   (global)             economy_rulesets           action costs, allowances,
 *                          + action costs / allowances / rewards    rewards
 *
 * Every version row is `draft`, `published` or `cancelled`:
 *
 *   draft      freely editable and deletable; NEVER resolvable. At most one
 *              open draft per parent, so two operators cannot silently
 *              prepare competing changes to the same plan.
 *   published  immutable forever. Carries `effective_from`, the instant it
 *              starts to apply, which may be in the future (scheduled).
 *   cancelled  a published version withdrawn BEFORE it took effect. Kept,
 *              immutable, and never resolvable.
 *
 * THERE IS NO "ACTIVE" FLAG, deliberately. A stored flag would need a job to
 * flip it at the scheduled instant, and between the instant and the job the
 * database would be wrong. Instead the live version at time T is DERIVED:
 *
 *   the `published` version with the greatest `effective_from` <= T
 *
 * which is exactly the banner schedule's read-time rule. For that answer to be
 * unambiguous, two published versions of one parent may never share an
 * `effective_from` (a partial unique index), and version numbers must order
 * the same way as effective instants (enforced when publishing, by migration
 * 0028's trigger). History is therefore linear: a later version always takes
 * effect after an earlier one, and every superseded version stays intact and
 * queryable -- which is what lets an existing subscriber keep the version they
 * bought (§31) by referencing its row.
 *
 * THE LIFECYCLE IS ENFORCED BY THE DATABASE (migration 0028), not merely by the
 * service that will write these rows in P1.3:
 *   - a row is created as `draft`; publishing is an explicit transition;
 *   - publishing stamps `published_at` from the database clock and, if no
 *     `effective_from` was given, makes it effective immediately;
 *   - `effective_from` can never precede `published_at` -- forward-only (§30.1);
 *   - a published row cannot be edited or deleted, only cancelled, and only
 *     while its `effective_from` is still in the future;
 *   - a published ruleset's cost, allowance and reward rows are frozen with it.
 *
 * ACTORS ARE NOT FOREIGN KEYS, the same rule as `audit_log` (P0): an
 * `ON DELETE SET NULL` would be an UPDATE the immutability trigger refuses,
 * and who published a price must outlive their account.
 *
 * MONEY IS INTEGER MINOR UNITS with an explicit ISO 4217 currency. Credits are
 * integers. There is no floating-point column anywhere in this model.
 * ------------------------------------------------------------------ */

export const economyVersionStatus = pgEnum('economy_version_status', [
  'draft',
  'published',
  'cancelled',
]);

/** The unit an action cost is charged in (§8: most per action, voice calls per minute). */
export const economyCostUnit = pgEnum('economy_cost_unit', ['per_action', 'per_minute']);

/**
 * The lifecycle columns every version table shares, and the CHECKs that make a
 * row's state self-consistent. The trigger in 0028 enforces the TRANSITIONS
 * between states; these enforce what each state must carry.
 */
const versionLifecycle = () => ({
  status: economyVersionStatus('status').notNull().default('draft'),
  /** When this version starts to apply. Null only while a draft has no schedule yet. */
  effectiveFrom: timestamp('effective_from', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedBy: uuid('published_by'),
  /** Why the change was made. Required to publish: every one of these affects money (§30.1). */
  publishReason: text('publish_reason'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: uuid('cancelled_by'),
  cancelReason: text('cancel_reason'),
});

function lifecycleChecks(
  prefix: string,
  t: {
    status: unknown;
    effectiveFrom: unknown;
    publishedAt: unknown;
    publishedBy: unknown;
    publishReason: unknown;
    cancelledAt: unknown;
    cancelledBy: unknown;
    cancelReason: unknown;
  },
) {
  return [
    // Published or cancelled: it was published, by someone, for a reason, at
    // an instant, taking effect no earlier than that instant.
    check(
      `${prefix}_published_complete`,
      sql`${t.status} = 'draft' OR (
        ${t.effectiveFrom} IS NOT NULL AND ${t.publishedAt} IS NOT NULL
        AND ${t.publishedBy} IS NOT NULL
        AND ${t.publishReason} IS NOT NULL AND length(btrim(${t.publishReason})) > 0
        AND ${t.effectiveFrom} >= ${t.publishedAt}
      )`,
    ),
    // A draft carries no publication or cancellation facts.
    check(
      `${prefix}_draft_unpublished`,
      sql`${t.status} <> 'draft' OR (
        ${t.publishedAt} IS NULL AND ${t.publishedBy} IS NULL AND ${t.cancelledAt} IS NULL
      )`,
    ),
    // Cancellation facts exist exactly when the row is cancelled, and a
    // cancellation always precedes the instant it prevented.
    check(
      `${prefix}_cancellation_complete`,
      sql`(${t.status} = 'cancelled') = (
        ${t.cancelledAt} IS NOT NULL AND ${t.cancelledBy} IS NOT NULL
        AND ${t.cancelReason} IS NOT NULL AND length(btrim(${t.cancelReason})) > 0
      )`,
    ),
    check(
      `${prefix}_cancelled_before_effective`,
      sql`${t.cancelledAt} IS NULL OR ${t.cancelledAt} < ${t.effectiveFrom}`,
    ),
  ];
}

/** Stable, human-typable identifiers: `premium_monthly`, `starter`. */
const CODE_PATTERN = sql.raw(`'^[a-z][a-z0-9_]{1,63}$'`);
const CURRENCY_PATTERN = sql.raw(`'^[A-Z]{3}$'`);

/**
 * economy_plans -- a subscription plan's STABLE identity.
 *
 * Holds nothing that can change: the price, term and grant live on versions.
 * `code` is what P0's `CommercialSubscription.planCode` carries. A plan cannot
 * be deleted while it has any version (versions RESTRICT), so no version is
 * ever orphaned and no history can be removed by deleting its parent.
 */
export const economyPlans = pgTable(
  'economy_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => [check('economy_plans_code_format', sql`${t.code} ~ ${CODE_PATTERN}`)],
);

/**
 * economy_plan_versions -- what a plan costs and includes, from an instant on.
 *
 * `price_minor` is the amount charged per billing period, in minor units of
 * `currency`. `billing_period_months` is the term (§9: 1, 3 or 12 today).
 * `monthly_included_credits` is the §8 grant expressed per month; whether a
 * quarterly or annual plan grants it monthly or up front is decision P-10 and
 * belongs to the grant logic, not to this row.
 *
 * `is_purchasable` = false is how a plan is RETIRED (§31): publish a version
 * that cannot be bought, effective from the retirement instant. Existing
 * subscribers are untouched because they reference the version they bought.
 */
export const economyPlanVersions = pgTable(
  'economy_plan_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => economyPlans.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    displayName: text('display_name').notNull(),
    billingPeriodMonths: integer('billing_period_months').notNull(),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull(),
    monthlyIncludedCredits: integer('monthly_included_credits').notNull(),
    /** Feature flags the plan grants (§31). Keys are validated by the service. */
    features: jsonb('features').$type<Record<string, unknown>>().notNull().default({}),
    isPurchasable: boolean('is_purchasable').notNull().default(true),
    ...versionLifecycle(),
  },
  (t) => [
    uniqueIndex('economy_plan_versions_version_idx').on(t.planId, t.version),
    // Unambiguous resolution: one published version per plan per instant.
    uniqueIndex('economy_plan_versions_effective_idx')
      .on(t.planId, t.effectiveFrom)
      .where(sql`status = 'published'`),
    // At most one open draft per plan.
    uniqueIndex('economy_plan_versions_one_draft_idx').on(t.planId).where(sql`status = 'draft'`),
    check('economy_plan_versions_version_positive', sql`${t.version} >= 1`),
    check('economy_plan_versions_display_name', sql`length(btrim(${t.displayName})) > 0`),
    check(
      'economy_plan_versions_billing_period',
      sql`${t.billingPeriodMonths} BETWEEN 1 AND 36`,
    ),
    check('economy_plan_versions_price_positive', sql`${t.priceMinor} > 0`),
    check('economy_plan_versions_currency', sql`${t.currency} ~ ${CURRENCY_PATTERN}`),
    check('economy_plan_versions_credits', sql`${t.monthlyIncludedCredits} >= 0`),
    check('economy_plan_versions_features_object', sql`jsonb_typeof(${t.features}) = 'object'`),
    ...lifecycleChecks('economy_plan_versions', t),
  ],
);

/** economy_packs -- a purchasable Credit pack's STABLE identity (§17). */
export const economyPacks = pgTable(
  'economy_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => [check('economy_packs_code_format', sql`${t.code} ~ ${CODE_PATTERN}`)],
);

/**
 * economy_pack_versions -- one rung of the §17 ladder, from an instant on.
 *
 * The per-Credit rate is DERIVED (`price_minor / credits`), never stored, so it
 * cannot disagree with the two numbers it comes from. `sort_order` and
 * `is_best_value` are presentation, versioned with the price they describe.
 * `is_purchasable` = false retires a pack, as for plans.
 */
export const economyPackVersions = pgTable(
  'economy_pack_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packId: uuid('pack_id')
      .notNull()
      .references(() => economyPacks.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    displayName: text('display_name').notNull(),
    credits: integer('credits').notNull(),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isBestValue: boolean('is_best_value').notNull().default(false),
    isPurchasable: boolean('is_purchasable').notNull().default(true),
    ...versionLifecycle(),
  },
  (t) => [
    uniqueIndex('economy_pack_versions_version_idx').on(t.packId, t.version),
    uniqueIndex('economy_pack_versions_effective_idx')
      .on(t.packId, t.effectiveFrom)
      .where(sql`status = 'published'`),
    uniqueIndex('economy_pack_versions_one_draft_idx').on(t.packId).where(sql`status = 'draft'`),
    check('economy_pack_versions_version_positive', sql`${t.version} >= 1`),
    check('economy_pack_versions_display_name', sql`length(btrim(${t.displayName})) > 0`),
    check('economy_pack_versions_credits_positive', sql`${t.credits} > 0`),
    check('economy_pack_versions_price_positive', sql`${t.priceMinor} > 0`),
    check('economy_pack_versions_currency', sql`${t.currency} ~ ${CURRENCY_PATTERN}`),
    check('economy_pack_versions_sort_order', sql`${t.sortOrder} >= 0`),
    ...lifecycleChecks('economy_pack_versions', t),
  ],
);

/**
 * economy_rulesets -- one global, versioned snapshot of action costs,
 * allowances and rewards (§8, §31).
 *
 * A SNAPSHOT, NOT PER-ROW VERSIONING. Costs, allowances and rewards change
 * together and are previewed together (§31's economy preview: "how many
 * images the monthly grant buys" needs the grant AND the image cost at the
 * same instant). So they are published as one unit and resolved as one unit;
 * there is never a moment where half an economy change is live.
 *
 * Global rather than per-parent, so `version` is unique across the table and
 * there is at most one open draft in total.
 */
export const economyRulesets = pgTable(
  'economy_rulesets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    version: integer('version').notNull(),
    ...versionLifecycle(),
  },
  (t) => [
    uniqueIndex('economy_rulesets_version_idx').on(t.version),
    uniqueIndex('economy_rulesets_effective_idx')
      .on(t.effectiveFrom)
      .where(sql`status = 'published'`),
    uniqueIndex('economy_rulesets_one_draft_idx')
      .on(t.status)
      .where(sql`status = 'draft'`),
    check('economy_rulesets_version_positive', sql`${t.version} >= 1`),
    ...lifecycleChecks('economy_rulesets', t),
  ],
);

/**
 * economy_ruleset_action_costs -- the §8 table as rows.
 *
 * `action_type` and `quality_tier` are validated keys (e.g. `image`,
 * `standard` / `high`), deliberately text rather than enums: adding an action
 * is configuration, and an enum would make it a migration. The service
 * validates them against a catalogue.
 *
 * `max_duration_seconds` is the upper bound of a duration tier (§8 video: up to
 * 5s, 6-15s, 16-30s), null for actions with no duration tiers. The resolver
 * picks the smallest tier that covers a requested duration.
 *
 * `credit_cost` is strictly positive. A free action is expressed by disabling
 * the row, never by a zero price that could make metered work silently free.
 */
export const economyRulesetActionCosts = pgTable(
  'economy_ruleset_action_costs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rulesetId: uuid('ruleset_id')
      .notNull()
      .references(() => economyRulesets.id, { onDelete: 'cascade' }),
    actionType: text('action_type').notNull(),
    qualityTier: text('quality_tier').notNull().default('standard'),
    maxDurationSeconds: integer('max_duration_seconds'),
    unit: economyCostUnit('unit').notNull().default('per_action'),
    creditCost: integer('credit_cost').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    // NULL is a real tier ("no duration tiers"), so it must collide with
    // itself: COALESCE rather than NULLS NOT DISTINCT, which needs Postgres 15.
    uniqueIndex('economy_ruleset_action_costs_tier_idx').on(
      t.rulesetId,
      t.actionType,
      t.qualityTier,
      sql`coalesce(${t.maxDurationSeconds}, -1)`,
    ),
    check('economy_ruleset_action_costs_action_key', sql`${t.actionType} ~ ${CODE_PATTERN}`),
    check('economy_ruleset_action_costs_tier_key', sql`${t.qualityTier} ~ ${CODE_PATTERN}`),
    check('economy_ruleset_action_costs_cost_positive', sql`${t.creditCost} > 0`),
    check(
      'economy_ruleset_action_costs_duration',
      sql`${t.maxDurationSeconds} IS NULL OR ${t.maxDurationSeconds} > 0`,
    ),
  ],
);

/**
 * economy_ruleset_allowances -- scalar allowances and limits (§8, §31):
 * free first-conversation and daily messages, the signup grant, grace-period
 * length, the global monthly reward cap.
 *
 * Key/value rather than one column per allowance, for the same reason action
 * types are text: several of these (the reset hour, the grace window, the
 * reward cap) are still open decisions, and each would otherwise be a
 * migration. The value is an integer >= 0; a zero allowance is legitimate
 * ("no free daily messages"). Completeness -- that a ruleset defines every key
 * the resolver needs -- is a publish-time validation for P1.3.
 */
export const economyRulesetAllowances = pgTable(
  'economy_ruleset_allowances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rulesetId: uuid('ruleset_id')
      .notNull()
      .references(() => economyRulesets.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: integer('value').notNull(),
  },
  (t) => [
    uniqueIndex('economy_ruleset_allowances_key_idx').on(t.rulesetId, t.key),
    check('economy_ruleset_allowances_key_format', sql`${t.key} ~ ${CODE_PATTERN}`),
    check('economy_ruleset_allowances_value', sql`${t.value} >= 0`),
  ],
);

/**
 * economy_ruleset_rewards -- milestone and referral reward amounts (§8.2, §31).
 *
 * `per_user_cap` limits how often one user can earn this reward; null means
 * once. The GLOBAL monthly cap that stops a reward bug minting unlimited
 * balance (§31) is an allowance, so it applies across every reward.
 */
export const economyRulesetRewards = pgTable(
  'economy_ruleset_rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rulesetId: uuid('ruleset_id')
      .notNull()
      .references(() => economyRulesets.id, { onDelete: 'cascade' }),
    rewardKey: text('reward_key').notNull(),
    credits: integer('credits').notNull(),
    perUserCap: integer('per_user_cap'),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    uniqueIndex('economy_ruleset_rewards_key_idx').on(t.rulesetId, t.rewardKey),
    check('economy_ruleset_rewards_key_format', sql`${t.rewardKey} ~ ${CODE_PATTERN}`),
    check('economy_ruleset_rewards_credits_positive', sql`${t.credits} > 0`),
    check(
      'economy_ruleset_rewards_cap',
      sql`${t.perUserCap} IS NULL OR ${t.perUserCap} > 0`,
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
export type PromptBatchRow = typeof promptBatches.$inferSelect;
export type PromptJobRow = typeof promptJobs.$inferSelect;
export type PromptJobOutputRow = typeof promptJobOutputs.$inferSelect;
export type PromptDriveFolderRow = typeof promptDriveFolders.$inferSelect;
export type PromptDriveConnectionRow = typeof promptDriveConnections.$inferSelect;
export type AdminRoleGrantRow = typeof adminRoleGrants.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type EconomyPlanRow = typeof economyPlans.$inferSelect;
export type EconomyPlanVersionRow = typeof economyPlanVersions.$inferSelect;
export type EconomyPackRow = typeof economyPacks.$inferSelect;
export type EconomyPackVersionRow = typeof economyPackVersions.$inferSelect;
export type EconomyRulesetRow = typeof economyRulesets.$inferSelect;
export type EconomyRulesetActionCostRow = typeof economyRulesetActionCosts.$inferSelect;
export type EconomyRulesetAllowanceRow = typeof economyRulesetAllowances.$inferSelect;
export type EconomyRulesetRewardRow = typeof economyRulesetRewards.$inferSelect;
