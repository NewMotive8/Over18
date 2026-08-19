import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { characterVisualAssets, type CharacterVisualAssetRow } from '../db/schema.js';
import { getActiveVisualIdentity } from './visual-identity-service.js';
import {
  approveVisualAsset,
  createVisualAsset,
  getVisualAssetById,
  type ContentRating,
} from './visual-asset-service.js';

/**
 * Manual Library upload (images and video).
 *
 * This is NOT generation and shares nothing with the media-generation pipeline:
 * no provider, no model, no cost ledger, no job, no prompt. The operator picks
 * a file that already exists; the server validates it, writes the bytes, and
 * records the asset through the SAME services generation uses — createVisualAsset
 * then approveVisualAsset — so no second lifecycle is introduced.
 *
 * Deliberate constraints, all inherited rather than invented:
 *  - character_id / visual_identity_id are NOT NULL on character_visual_assets,
 *    so an upload MUST name a character; the row attaches to that character's
 *    ACTIVE visual identity. There is no implicit or default character.
 *  - is_canonical stays FALSE. createVisualAsset never sets it, and
 *    approveVisualAsset promotes only kind='reference' — an upload is
 *    kind='generated', so it can never enter the public canonical gallery,
 *    whose filter is kind='reference' AND status='approved' AND is_canonical.
 *  - kind='generated' + status='approved' is exactly what the Library selects
 *    (LIBRARY_STATUSES in content-review-service). 'approved' here means "an
 *    admin chose this file", which is the same trust level the queue confers.
 *
 * STORAGE DURABILITY: bytes are written under MEDIA_STORAGE_DIR. On Railway
 * that must point at a mounted volume or uploads are lost on the next deploy —
 * the same ephemeral-filesystem caveat the internal media routes already carry.
 */

/** Accepted upload types, keyed by MIME, with the extension we store. */
const ACCEPTED: Record<string, { ext: string; media: 'image' | 'video' }> = {
  'image/jpeg': { ext: 'jpg', media: 'image' },
  'image/png': { ext: 'png', media: 'image' },
  'image/webp': { ext: 'webp', media: 'image' },
  'video/mp4': { ext: 'mp4', media: 'video' },
  'video/webm': { ext: 'webm', media: 'video' },
  'video/quicktime': { ext: 'mov', media: 'video' },
};

export const ACCEPTED_MIME_TYPES = Object.keys(ACCEPTED);

export type LibraryUploadErrorKind = 'unsupported_type' | 'empty_file' | 'no_active_identity';

export class LibraryUploadError extends Error {
  constructor(
    public readonly kind: LibraryUploadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'LibraryUploadError';
  }
}

export interface LibraryUploadInput {
  characterId: string;
  /** MIME type reported by the client; validated against ACCEPTED. */
  mimeType: string;
  bytes: Buffer;
  /** Original filename, recorded in provenance for traceability only. */
  originalName?: string;
  contentRating?: ContentRating;
  /** Admin user id, recorded as the approver of this manual addition. */
  uploadedBy?: string;
}

export interface LibraryUploadStorage {
  /** Root directory uploaded bytes are written under (MEDIA_STORAGE_DIR). */
  storageDir: string;
  /**
   * API path prefix serving an uploaded asset's bytes. storage_key becomes
   * `${servePathPrefix}/<assetId>/file`, which the admin UI renders directly.
   */
  servePathPrefix: string;
}

/** Server-side absolute path of an uploaded asset, or null if not an upload. */
export function uploadedPathOf(asset: CharacterVisualAssetRow): string | null {
  const provenance = asset.provenance as Record<string, unknown>;
  if (provenance.source !== 'manual-upload') return null;
  const path = provenance.storagePath;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/** Stored MIME type of an uploaded asset, for the serving route's header. */
export function uploadedMimeTypeOf(asset: CharacterVisualAssetRow): string {
  const mime = (asset.provenance as Record<string, unknown>).mimeType;
  return typeof mime === 'string' && mime.length > 0 ? mime : 'application/octet-stream';
}

/**
 * Validates, stores and records one manually uploaded file.
 *
 * Order matters: the row is created BEFORE the bytes are written so the file is
 * named by the asset's own id, and storage_key is set only once the file is
 * safely on disk. An interrupted upload therefore leaves a keyless, unapproved
 * row — which the Library skips — never a row pointing at a missing file.
 */
export async function uploadLibraryAsset(
  db: Db,
  storage: LibraryUploadStorage,
  input: LibraryUploadInput,
): Promise<CharacterVisualAssetRow> {
  const accepted = ACCEPTED[input.mimeType];
  if (!accepted) {
    throw new LibraryUploadError(
      'unsupported_type',
      `Unsupported file type "${input.mimeType}". Accepted: ${ACCEPTED_MIME_TYPES.join(', ')}.`,
    );
  }
  if (input.bytes.length === 0) {
    throw new LibraryUploadError('empty_file', 'The selected file is empty.');
  }

  // An upload attaches to the character's ACTIVE identity version — the same
  // version the rest of the visual system treats as current.
  const identity = await getActiveVisualIdentity(db, input.characterId);
  if (!identity) {
    throw new LibraryUploadError(
      'no_active_identity',
      'That character has no active visual identity to attach an upload to.',
    );
  }

  const created = await createVisualAsset(db, {
    characterId: input.characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    contentRating: input.contentRating ?? 'sfw',
    provenance: {
      source: 'manual-upload',
      originalName: input.originalName ?? null,
      mimeType: input.mimeType,
      mediaType: accepted.media,
      byteSize: input.bytes.length,
    },
  });

  const storagePath = join(
    storage.storageDir,
    input.characterId,
    'uploads',
    `${created.id}.${accepted.ext}`,
  );
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, input.bytes);

  await db
    .update(characterVisualAssets)
    .set({
      storageKey: `${storage.servePathPrefix}/${created.id}/file`,
      provenance: { ...(created.provenance as Record<string, unknown>), storagePath },
      updatedAt: new Date(),
    })
    .where(eq(characterVisualAssets.id, created.id));

  // Reuse the existing approval transition rather than inventing one: it records
  // approvedBy/approvedAt and leaves is_canonical false for a generated asset.
  return approveVisualAsset(db, created.id, input.uploadedBy);
}

/**
 * Permanently removes a Library asset: its row AND the file it owns.
 *
 * NOTE ON THE EXISTING DESIGN. admin-content.ts documents "remove" as a
 * REJECT, never a delete, so provenance survives. That remains true for the
 * review queue. This is a separate, explicitly-requested Library operation for
 * getting rid of content outright, and it is deliberately narrow:
 *
 *  - a CANONICAL asset is REFUSED. Canonical is the public gallery's
 *    membership test, so the public surface can never be altered from here.
 *  - the file is unlinked only when its recorded path resolves INSIDE
 *    MEDIA_STORAGE_DIR. A path outside it is left untouched — a stray or
 *    hand-edited provenance value can never make this delete arbitrary files.
 *  - a missing file is NOT an error. The row is still removed, so a Library
 *    entry orphaned by an ephemeral-disk redeploy can always be cleaned up.
 *  - no schema and no lifecycle enum is involved; the row is simply gone.
 *
 * generation_results.asset_id references this table with ON DELETE SET NULL,
 * so deleting an asset never cascades into generation history — the result row
 * survives with a null asset link.
 */
export class LibraryDeleteError extends Error {
  constructor(
    public readonly kind: 'not_found' | 'canonical_refused',
    message: string,
  ) {
    super(message);
    this.name = 'LibraryDeleteError';
  }
}

export interface LibraryDeleteResult {
  assetId: string;
  fileRemoved: boolean;
  /** True when the row had a file path recorded but nothing was on disk. */
  fileWasMissing: boolean;
}

/** True only when `candidate` sits inside `root` (no traversal, no siblings). */
function isInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

export async function deleteLibraryAsset(
  db: Db,
  storage: Pick<LibraryUploadStorage, 'storageDir'>,
  assetId: string,
): Promise<LibraryDeleteResult> {
  const asset = await getVisualAssetById(db, assetId);
  if (!asset) {
    throw new LibraryDeleteError('not_found', 'Asset not found.');
  }
  if (asset.isCanonical) {
    throw new LibraryDeleteError(
      'canonical_refused',
      'This asset is Primary (canonical) and is part of the public gallery. Remove it from Primary before deleting.',
    );
  }

  const recorded = (asset.provenance as Record<string, unknown>).storagePath;
  const path = typeof recorded === 'string' && recorded.length > 0 ? recorded : null;

  let fileRemoved = false;
  let fileWasMissing = false;
  if (path && isInside(storage.storageDir, path)) {
    // Check first: rm({force:true}) silently succeeds on a missing file, so it
    // cannot by itself tell "deleted" from "was never there" — and the caller
    // needs that distinction to report an orphaned row honestly.
    const existed = await stat(path).then(
      () => true,
      () => false,
    );
    if (existed) {
      await rm(path, { force: true });
      fileRemoved = true;
    } else {
      fileWasMissing = true;
    }
  } else if (path) {
    fileWasMissing = true; // outside the storage root: deliberately untouched
  }

  // The row goes last: if the unlink throws unexpectedly, the row survives and
  // the operation can be retried rather than leaving an unreachable file.
  await db.delete(characterVisualAssets).where(eq(characterVisualAssets.id, assetId));

  return { assetId, fileRemoved, fileWasMissing };
}
