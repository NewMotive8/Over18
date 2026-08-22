import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bannerCreatives, type BannerCreativeRow } from '../db/schema.js';
import {
  ACCEPTED_MIME_TYPES,
  acceptedExtensionOf,
  acceptedMediaTypeOf,
} from './library-upload-service.js';
import { isInsideStorageRoot } from './message-media-service.js';

/**
 * Banner creatives (US-102.3) — artwork uploaded for a banner and nothing else.
 *
 * SEPARATE FROM THE CHARACTER LIFECYCLE, BY CONSTRUCTION. This module never
 * touches `character_visual_assets`, `content_requirements`, `content_inbox` or
 * any generation table, and `banner_creatives` has no character column. Banner
 * artwork therefore cannot enter Review, cannot count toward a content
 * requirement, and cannot be reached by any character-scoped query. It is
 * editorial material, not a character's content.
 *
 * IT DOES NOT INVENT ITS OWN RULES. The accepted formats come from
 * library-upload-service's ACCEPTED list — the one authoritative definition in
 * this codebase, already shared by character uploads and the unassigned inbox.
 * Containment comes from isInsideStorageRoot, the same check that guards chat
 * media. Adding a banner-only accept list or a banner-only storage root would
 * be exactly the "conflicting limits" this ticket rules out.
 *
 * WHAT IT ADDS: a storage root of its own (MEDIA_STORAGE_DIR/banners) so
 * editorial art never lands among character content, and an advisory dimension
 * read — see readImageDimensions.
 */

/** Byte ceiling. Same 100MB the Library and character uploads enforce. */
export const BANNER_CREATIVE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The recommended shape for a Home banner, shown to the operator and never
 * enforced. This product has no authoritative dimension rule; inventing one
 * here would be a limit the rest of the system does not share, and coupling to
 * the generation pipeline's QA would drag banners into generation. So it is
 * guidance, and the UI says so.
 */
export const BANNER_RECOMMENDED_ASPECT = '16:9';
export const BANNER_RECOMMENDED_MIN_WIDTH = 1200;

export type BannerCreativeErrorKind = 'unsupported_type' | 'empty_file' | 'too_large';

export class BannerCreativeError extends Error {
  constructor(
    public readonly kind: BannerCreativeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BannerCreativeError';
  }
}

export interface BannerCreativeStorage {
  /** MEDIA_STORAGE_DIR. Banner bytes live in a `banners` subtree beneath it. */
  storageDir: string;
}

export function bannerCreativeDir(storage: BannerCreativeStorage): string {
  return join(storage.storageDir, 'banners');
}

/**
 * The requirements an operator has to satisfy, as DATA rather than as copy the
 * UI restates. The editor renders this, so the rules on screen can never drift
 * from the rules the server enforces.
 */
export interface BannerCreativeRequirements {
  acceptedMimeTypes: string[];
  maxBytes: number;
  maxLabel: string;
  recommendedAspect: string;
  recommendedMinWidth: number;
  /** Stated plainly, because the absence of a rule is itself worth saying. */
  dimensionsEnforced: false;
}

export function bannerCreativeRequirements(): BannerCreativeRequirements {
  return {
    acceptedMimeTypes: [...ACCEPTED_MIME_TYPES],
    maxBytes: BANNER_CREATIVE_MAX_BYTES,
    maxLabel: `${Math.round(BANNER_CREATIVE_MAX_BYTES / (1024 * 1024))}MB`,
    recommendedAspect: BANNER_RECOMMENDED_ASPECT,
    recommendedMinWidth: BANNER_RECOMMENDED_MIN_WIDTH,
    dimensionsEnforced: false,
  };
}

/** What the browser is given. Never a path, never a storage key. */
export interface BannerCreativeView {
  id: string;
  mimeType: string;
  mediaType: 'image' | 'video';
  byteSize: number;
  originalName: string | null;
  width: number | null;
  height: number | null;
  /** Opaque, id-keyed media route. */
  fileUrl: string;
  createdAt: string;
}

export function bannerCreativeUrl(creativeId: string): string {
  return `/admin/home-banners/creatives/${creativeId}/file`;
}

export function toBannerCreativeView(row: BannerCreativeRow): BannerCreativeView {
  return {
    id: row.id,
    mimeType: row.mimeType,
    mediaType: row.mediaType === 'video' ? 'video' : 'image',
    byteSize: row.byteSize,
    originalName: row.originalName,
    width: row.width,
    height: row.height,
    fileUrl: bannerCreativeUrl(row.id),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Reads pixel dimensions from a PNG, JPEG or WebP header.
 *
 * ADVISORY ONLY, and failure is always fine: a video, an exotic encoding or a
 * truncated header simply yields null, and the operator sees "dimensions
 * unavailable" instead of a rejection. Nothing downstream branches on this.
 *
 * Deliberately a few bytes of header parsing rather than a dependency or a
 * spawn of ffprobe: it runs inside the upload request, and an upload must not
 * be able to fail — or hang — because a probe did.
 */
export function readImageDimensions(
  bytes: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png') {
      // [8-byte signature][len(4)][ 'IHDR' ][width(4)][height(4)]
      if (bytes.length < 24) return null;
      if (bytes.readUInt32BE(12) !== 0x49484452) return null; // 'IHDR'
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }

    if (mimeType === 'image/jpeg') {
      let offset = 2; // skip SOI
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        const length = bytes.readUInt16BE(offset + 2);
        // SOF0..SOF15, excluding the non-frame markers in that range.
        const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isFrame) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
      return null;
    }

    if (mimeType === 'image/webp') {
      // RIFF....WEBP then a VP8 / VP8L / VP8X chunk, each with its own layout.
      if (bytes.length < 30 || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
      const chunk = bytes.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        // 24-bit little-endian, stored as (dimension - 1).
        const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
        const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
        return { width, height };
      }
      if (chunk === 'VP8 ') {
        return {
          width: bytes.readUInt16LE(26) & 0x3fff,
          height: bytes.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      return null;
    }
  } catch {
    // A malformed header is not an upload failure — see the note above.
    return null;
  }
  return null;
}

export interface CreateBannerCreativeInput {
  mimeType: string;
  bytes: Buffer;
  originalName?: string | null;
  uploadedBy?: string | null;
}

/**
 * Validates and stores one creative.
 *
 * Validation order matters: type first, because "unsupported format" is the
 * more useful message when a file is both the wrong type and too big.
 *
 * The row is written before the bytes and rolled back if the write fails —
 * same discipline as createInboxItem, for the same reason: a row with no bytes
 * can never be shown, and bytes with no row can never be reclaimed.
 */
export async function createBannerCreative(
  db: Db,
  storage: BannerCreativeStorage,
  input: CreateBannerCreativeInput,
): Promise<BannerCreativeRow> {
  const mediaType = acceptedMediaTypeOf(input.mimeType);
  const ext = acceptedExtensionOf(input.mimeType);
  if (!mediaType || !ext) {
    throw new BannerCreativeError(
      'unsupported_type',
      `Unsupported file type "${input.mimeType}". Accepted: ${ACCEPTED_MIME_TYPES.join(', ')}.`,
    );
  }
  if (input.bytes.length === 0) {
    throw new BannerCreativeError('empty_file', 'The selected file is empty.');
  }
  if (input.bytes.length > BANNER_CREATIVE_MAX_BYTES) {
    throw new BannerCreativeError(
      'too_large',
      `That file exceeds the ${Math.round(BANNER_CREATIVE_MAX_BYTES / (1024 * 1024))}MB upload limit.`,
    );
  }

  const dimensions = mediaType === 'image' ? readImageDimensions(input.bytes, input.mimeType) : null;

  const [created] = await db
    .insert(bannerCreatives)
    .values({
      mimeType: input.mimeType,
      mediaType,
      byteSize: input.bytes.length,
      originalName: input.originalName ?? null,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      uploadedBy: input.uploadedBy ?? null,
    })
    .returning();

  const storagePath = join(bannerCreativeDir(storage), `${created!.id}.${ext}`);
  try {
    await mkdir(dirname(storagePath), { recursive: true });
    await writeFile(storagePath, input.bytes);
    const [stored] = await db
      .update(bannerCreatives)
      .set({ storagePath })
      .where(eq(bannerCreatives.id, created!.id))
      .returning();
    return stored!;
  } catch (error) {
    await rm(storagePath, { force: true }).catch(() => undefined);
    await db.delete(bannerCreatives).where(eq(bannerCreatives.id, created!.id)).catch(() => undefined);
    throw error;
  }
}

export async function getBannerCreative(db: Db, id: string): Promise<BannerCreativeRow | null> {
  const [row] = await db.select().from(bannerCreatives).where(eq(bannerCreatives.id, id)).limit(1);
  return row ?? null;
}

export async function listBannerCreatives(db: Db): Promise<BannerCreativeRow[]> {
  return db.select().from(bannerCreatives).orderBy(bannerCreatives.createdAt);
}

export type CreativeResolution =
  | { ok: true; path: string; contentType: string }
  | { ok: false; reason: 'no_path' | 'outside_storage_root' | 'file_missing' | 'unsupported_type' };

/**
 * Turns a creative row into a streamable file, or explains why it cannot.
 *
 * The containment check is the security boundary and is applied to the stored
 * path itself, never trusted from the column — the same rule the chat media
 * route follows. This one function backs BOTH the serving route and the
 * "is this creative still valid?" question the banner state machine asks, so
 * the two can never disagree about what a usable creative is.
 */
export function resolveBannerCreative(
  row: BannerCreativeRow,
  storage: BannerCreativeStorage,
): CreativeResolution {
  if (!row.storagePath) return { ok: false, reason: 'no_path' };
  if (!isInsideStorageRoot(storage.storageDir, row.storagePath)) {
    return { ok: false, reason: 'outside_storage_root' };
  }
  if (!acceptedMediaTypeOf(row.mimeType)) return { ok: false, reason: 'unsupported_type' };
  const path = resolve(row.storagePath);
  if (!existsSync(path)) return { ok: false, reason: 'file_missing' };
  return { ok: true, path, contentType: row.mimeType };
}
