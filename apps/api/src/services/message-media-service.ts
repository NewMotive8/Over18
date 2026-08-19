import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { and, asc, eq, isNotNull, notInArray } from 'drizzle-orm';
import type { ChatMediaType } from '@over18/shared';
import type { Db } from '../db/client.js';
import {
  characterVisualAssets,
  conversations,
  messages,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { mediaTypeOf } from './content-review-service.js';
import { uploadedMimeTypeOf, uploadedPathOf } from './library-upload-service.js';

/**
 * Character Media Messages — selection (commit 2) and serving (commit 1).
 *
 * This module is the ONLY place a message's media is chosen, and the ONLY place
 * it is turned into something a client can fetch.
 *
 * Three invariants it exists to hold:
 *
 *  1. AUTHORISATION IS BY MESSAGE, NOT BY ASSET. There is no asset id in any
 *     route. An asset's bytes are reachable only by naming a message that
 *     (a) belongs to a conversation (b) owned by the caller and (c) actually
 *     references that asset. This is what keeps an `explicit` Library item
 *     unreachable unless it was genuinely attached to the caller's own chat.
 *
 *  2. NOTHING INTERNAL LEAVES THE SERVER. Asset ids, storage keys, provenance
 *     and filesystem paths stay here; the client gets a message-scoped URL and
 *     a media type. Same discipline as toPublicVisualAsset and system_prompt.
 *
 *  3. NO PATH IS OPENED UNTIL IT IS PROVEN TO BE INSIDE MEDIA_STORAGE_DIR.
 *     The two producers disagree about what storage_key means (see below), and
 *     one of them puts a raw filesystem path in a database column — so the
 *     containment check is the security boundary, not a nicety.
 */

/**
 * The two storage conventions that exist in the data today.
 *
 * MANUAL UPLOADS (library-upload-service): storage_key is a ROUTE
 * ('/admin/content/uploads/<id>/file') and the real path lives in
 * provenance.storagePath. Treating that key as a path would be nonsense.
 *
 * GENERATED ASSETS (internal-media / generation pipeline): storage_key IS the
 * absolute filesystem path, and there is no provenance.storagePath.
 *
 * Upload is checked FIRST because a manual upload has both a storage_key and a
 * storagePath, and only the latter is a real file.
 */
export type MediaResolutionFailure =
  | 'no_media' // the message carries no asset
  | 'no_path' // the asset row has neither convention populated
  | 'outside_storage_root'; // a path that escapes MEDIA_STORAGE_DIR

export interface ResolvedMediaFile {
  /** Absolute, containment-checked path. Safe to stream. */
  path: string;
  contentType: string;
  mediaType: ChatMediaType;
}

/** Content type for a generated asset, whose path carries a real extension. */
export function contentTypeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.m4v')) return 'video/x-m4v';
  return 'image/jpeg';
}

/** True only when `candidate` sits inside `root` — no traversal, no siblings. */
export function isInsideStorageRoot(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Turns an asset row into a streamable file, or explains why it cannot.
 *
 * Does NOT touch the filesystem: existence is the route's concern (a missing
 * file is a 404, not a resolution failure), and keeping this pure makes the
 * containment rule directly testable.
 */
export function resolveMediaFile(
  asset: CharacterVisualAssetRow,
  storageDir: string,
): ResolvedMediaFile | { failure: MediaResolutionFailure } {
  const mediaType = mediaTypeOf(asset.storageKey, asset.provenance);
  // 'audio' is not a media type this commit can produce or serve; mediaTypeOf
  // only ever returns image|video today, so the cast is a narrowing, not a lie.
  const chatMediaType: ChatMediaType = mediaType === 'video' ? 'video' : 'image';

  const uploadPath = uploadedPathOf(asset);
  if (uploadPath) {
    if (!isInsideStorageRoot(storageDir, uploadPath)) {
      return { failure: 'outside_storage_root' };
    }
    return {
      path: resolve(uploadPath),
      contentType: uploadedMimeTypeOf(asset),
      mediaType: chatMediaType,
    };
  }

  // Generated convention: storage_key is the path itself.
  const key = asset.storageKey;
  if (!key || key.length === 0) return { failure: 'no_path' };
  if (!isInsideStorageRoot(storageDir, key)) {
    return { failure: 'outside_storage_root' };
  }
  return {
    path: resolve(key),
    contentType: contentTypeForPath(key),
    mediaType: chatMediaType,
  };
}

/**
 * The authorised lookup: the asset attached to `messageId`, but ONLY when that
 * message belongs to `conversationId` AND that conversation belongs to
 * `userId`.
 *
 * One query, three conditions, so there is no window in which any of them is
 * checked but not enforced. Every failure — wrong owner, unknown conversation,
 * message from a different conversation, message with no media — returns null,
 * which the route renders as an identical 404. No existence leaks, matching
 * getConversationForUser.
 */
export async function getAuthorisedMessageMedia(
  db: Db,
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<CharacterVisualAssetRow | null> {
  const rows = await db
    .select({ asset: characterVisualAssets })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, messages.mediaAssetId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
        eq(conversations.userId, userId),
      ),
    )
    .limit(1);
  return rows[0]?.asset ?? null;
}

/**
 * The client-facing locator for a message's media. Contains only ids the
 * caller already holds (their own conversation and message) — never the asset
 * id, so the Library is not enumerable and nothing about the underlying asset
 * is inferable from the URL.
 */
export function mediaUrlFor(conversationId: string, messageId: string): string {
  return `/api/conversations/${conversationId}/messages/${messageId}/media`;
}

/* ------------------------------------------------------------------ *
 * Selection (commit 2)
 * ------------------------------------------------------------------ */

/**
 * Minimal connection contract, following memory-service's MemoryDb: satisfied
 * by both the pool and a transaction handle, so selection can run inside
 * sendMessage's transaction and see a consistent "already sent" set.
 */
export type MediaSelectionDb = Pick<Db, 'select'>;

/**
 * What the selector returns: a REFERENCE, plus the type needed to render it.
 * Never a URL, a path or a storage key — the caller stores the id and the wire
 * mapper derives the message-scoped URL. Nothing leaks by construction.
 */
export interface SelectedMedia {
  assetId: string;
  mediaType: ChatMediaType;
}

export interface MediaSelectionContext {
  /** The character in THIS conversation. Assets are scoped to it, always. */
  characterId: string;
  /** Scopes the "already sent" exclusion. */
  conversationId: string;
  /** Which kind the request asked for. There is no "any" — see below. */
  requested: ChatMediaType;
}

/** The seam sendMessage depends on. Null return = send text only. */
export type MediaSelector = (
  db: MediaSelectionDb,
  context: MediaSelectionContext,
) => Promise<SelectedMedia | null>;

/**
 * The deterministic Phase 1 selector.
 *
 * NO model involvement of any kind. The LLM cannot name, hint at or influence
 * which asset is chosen — it is not consulted, and its reply text is not read
 * here. The eligibility rules are the whole policy:
 *
 *   character_id = the conversation's character   (A can never send B's asset)
 *   kind         = 'generated'                    (the Library's own filter)
 *   status       = 'approved'                     (never unreviewed/rejected)
 *   is_canonical = false                          (never the public gallery)
 *   content_rating = 'sfw'                        (explicit is never eligible)
 *   media type   = exactly what was requested
 *   not already sent in this conversation
 *   the file actually exists inside MEDIA_STORAGE_DIR
 *
 * The first five are SQL, so nothing outside them is ever loaded. Media type is
 * resolved with mediaTypeOf, which reads provenance.mediaType first — a manual
 * upload's storage_key is an extensionless `/file` route, so extension sniffing
 * would misclassify every upload as an image.
 *
 * Deterministic ordering: oldest first, id as a stable tiebreak. The same
 * conversation asking the same thing twice gets the next asset, not a random
 * one, which is what makes this testable and repeatable during QA.
 *
 * Existence is checked LAST and per-candidate, because it is the only I/O: the
 * first candidate whose bytes are actually readable wins. A row orphaned by an
 * ephemeral-disk redeploy is skipped rather than producing a broken bubble.
 */
export function createDeterministicMediaSelector(storageDir: string): MediaSelector {
  return async (db, context) => {
    // Assets already used in this conversation. A subquery would be tidier,
    // but this stays a plain value so the exclusion is obvious and testable.
    const alreadySent = await db
      .select({ assetId: messages.mediaAssetId })
      .from(messages)
      .where(and(eq(messages.conversationId, context.conversationId), isNotNull(messages.mediaAssetId)));
    const usedIds = alreadySent
      .map((row) => row.assetId)
      .filter((id): id is string => id !== null);

    const conditions = [
      eq(characterVisualAssets.characterId, context.characterId),
      eq(characterVisualAssets.kind, 'generated'),
      eq(characterVisualAssets.status, 'approved'),
      eq(characterVisualAssets.isCanonical, false),
      eq(characterVisualAssets.contentRating, 'sfw'),
      isNotNull(characterVisualAssets.storageKey),
    ];
    if (usedIds.length > 0) {
      conditions.push(notInArray(characterVisualAssets.id, usedIds));
    }

    const candidates = await db
      .select()
      .from(characterVisualAssets)
      .where(and(...conditions))
      .orderBy(asc(characterVisualAssets.createdAt), asc(characterVisualAssets.id));

    for (const asset of candidates) {
      if (mediaTypeOf(asset.storageKey, asset.provenance) !== context.requested) continue;

      // Resolution enforces MEDIA_STORAGE_DIR containment, so an asset with a
      // stray path is skipped here as well as refused at serve time.
      const resolved = resolveMediaFile(asset, storageDir);
      if ('failure' in resolved) continue;

      const exists = await stat(resolved.path).then(
        (s) => s.isFile(),
        () => false,
      );
      if (!exists) continue;

      return { assetId: asset.id, mediaType: resolved.mediaType };
    }

    return null; // nothing eligible — the character simply replies with text
  };
}
