/**
 * Adopting an optimised derivative — the only code that makes one active.
 *
 * THE ORIGINAL IS NEVER TOUCHED. Not moved, not renamed, not rewritten, not
 * deleted. A derivative is a NEW file beside it and a NEW key on the row, and
 * this module only ever adds. That is what makes the whole feature reversible:
 * there is no state to restore because nothing was destroyed.
 *
 * THE ORDER MATTERS AND IS THE SAFETY MODEL:
 *
 *   1. write the candidate to a TEMP name, so a crash mid-write leaves a file
 *      nothing will ever look at rather than a half-written derivative sitting
 *      at the name the server would serve;
 *   2. verify the bytes ON DISK, so what is checked is exactly what would be
 *      served — not a buffer that was checked and then written separately;
 *   3. rename, which is atomic within a directory, so the derivative appears
 *      complete or not at all;
 *   4. and only then record the key, so the row can never point at a file that
 *      failed its checks.
 *
 * A failure at any step leaves the row untouched and the original serving.
 * There is no compensating cleanup to get wrong.
 */

import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { characterVisualAssets, type CharacterVisualAssetRow } from '../db/schema.js';
import { getVisualAssetById } from './visual-asset-service.js';
import { uploadedPathOf } from './library-upload-service.js';
import { isInsideStorageRoot } from './message-media-service.js';
import { verifyDerivative, type DerivativeVerdict } from './media-verify-service.js';

/** Suffix that distinguishes a derivative from the original it sits beside. */
export const OPTIMISED_SUFFIX = '.opt.mp4';

/** Free space a write must leave behind, so optimisation cannot fill the volume. */
export const MIN_FREE_BYTES = 50 * 1024 * 1024;

export type AdoptionFailure =
  | 'not_an_upload' // no original path on the row
  | 'outside_storage_root' // the original resolves outside MEDIA_STORAGE_DIR
  | 'original_missing' // the row names a file that is not there
  | 'disk_space' // writing the derivative would leave too little room
  | 'verification_failed'; // the candidate did not pass every check

export interface AdoptionResult {
  ok: boolean;
  failure?: AdoptionFailure;
  verdict?: DerivativeVerdict;
  asset?: CharacterVisualAssetRow;
}

/** Where an asset's derivative lives: beside the original, same directory. */
export function optimisedPathFor(originalPath: string, assetId: string): string {
  return join(dirname(originalPath), `${assetId}${OPTIMISED_SUFFIX}`);
}

/** Best-effort free-space read. Unknown space is treated as enough — see below. */
function freeBytes(path: string): number | null {
  try {
    const fs = statfsSync(path);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    // A platform or filesystem that will not answer must not become a reason
    // uploads and adoptions stop working. The write itself still fails loudly
    // if the disk is genuinely full.
    return null;
  }
}

/**
 * Verifies a candidate derivative and, only if it passes every check, makes it
 * the file this asset serves while MEDIA_OPTIMISED_ENABLED is on.
 */
export async function adoptOptimisedDerivative(
  db: Db,
  asset: CharacterVisualAssetRow,
  candidate: Buffer,
  storageDir: string,
): Promise<AdoptionResult> {
  const originalPath = uploadedPathOf(asset);
  if (!originalPath) return { ok: false, failure: 'not_an_upload' };
  if (!isInsideStorageRoot(storageDir, originalPath)) {
    return { ok: false, failure: 'outside_storage_root' };
  }

  const original = resolve(originalPath);
  const exists = await stat(original).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!exists) return { ok: false, failure: 'original_missing' };

  const target = optimisedPathFor(original, asset.id);
  // Containment is re-asked for the derivative rather than inferred from the
  // original: the path is derived, but a derived path is still a path.
  if (!isInsideStorageRoot(storageDir, target)) {
    return { ok: false, failure: 'outside_storage_root' };
  }

  const free = freeBytes(dirname(original));
  if (free !== null && free - candidate.length < MIN_FREE_BYTES) {
    return { ok: false, failure: 'disk_space' };
  }

  const tmp = `${target}.tmp`;
  try {
    await writeFile(tmp, candidate);

    const verdict = verifyDerivative(original, tmp);
    if (!verdict.ok) {
      await unlink(tmp).catch(() => {});
      return { ok: false, failure: 'verification_failed', verdict };
    }

    // Atomic within the directory: readers see the old file or the new one.
    await rename(tmp, target);

    const provenance = {
      ...(asset.provenance as Record<string, unknown>),
      optimisedPath: target,
      optimisedAt: new Date().toISOString(),
      optimisedBytes: verdict.derivativeFacts?.bytes ?? candidate.length,
      originalBytes: verdict.originalFacts?.bytes ?? null,
    };
    await db
      .update(characterVisualAssets)
      .set({ provenance, updatedAt: new Date() })
      .where(eq(characterVisualAssets.id, asset.id));

    return { ok: true, verdict, asset: (await getVisualAssetById(db, asset.id)) ?? asset };
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Stops an asset serving its derivative, without deleting anything.
 *
 * Clears the key and leaves the file where it is, so re-adopting is a matter of
 * pointing at it again rather than re-encoding. This is the per-asset
 * counterpart to MEDIA_OPTIMISED_ENABLED, which does the same for all of them
 * at once; neither destroys a byte.
 */
export async function revokeOptimisedDerivative(
  db: Db,
  asset: CharacterVisualAssetRow,
): Promise<CharacterVisualAssetRow | null> {
  const provenance = { ...(asset.provenance as Record<string, unknown>) };
  delete provenance.optimisedPath;
  delete provenance.optimisedAt;
  delete provenance.optimisedBytes;
  await db
    .update(characterVisualAssets)
    .set({ provenance, updatedAt: new Date() })
    .where(eq(characterVisualAssets.id, asset.id));
  return getVisualAssetById(db, asset.id);
}
