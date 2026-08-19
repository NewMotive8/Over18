import { resolve, sep } from 'node:path';
import { and, eq } from 'drizzle-orm';
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
 * Character Media Messages — the read/serve half (commit 1).
 *
 * This module is the ONLY place a message's media is turned into something a
 * client can fetch, and it is deliberately inert for now: nothing in this
 * commit ever WRITES messages.media_asset_id, so every code path here returns
 * "no media" until a later commit adds selection.
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
