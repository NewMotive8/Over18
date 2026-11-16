import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isInsideStorageRoot } from '../message-media-service.js';
import { OhRequestError } from './oh-client.js';

/**
 * Getting a picture off the provider and onto our own volume.
 *
 * ── WHY WE COPY THE BYTES AT ALL ────────────────────────────────────────────
 *
 * OhAPI hands back a presigned S3 URL — one that carries an expiry in its own
 * query string. A picture we only linked to would stop existing on their
 * schedule, depend on their uptime for every future view, and survive exactly
 * as long as our account does. Downloaded, it is in the volume the backup
 * process already covers.
 *
 * ── AND WHY IT ASKS MORE THAN ONCE ──────────────────────────────────────────
 *
 * The URL is named before the file behind it exists. A 404 just after a job
 * reports success means "not uploaded yet", not "wrong address" — the lesson
 * of the first companion ever created, who was thrown away 1.3 seconds in
 * over exactly that. Anything that is not a 404 or a 403 will not improve by
 * asking again, so it stops immediately.
 */

/** A photograph is a few hundred KB. Anything far past this is not one. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const DOWNLOAD_ATTEMPTS = 6;
export const DOWNLOAD_RETRY_MS = 5_000;

/**
 * @param subdir  Folder under the media root, e.g. `my-ai` or `my-ai/photos`.
 * @param id      The row's own UUID. The filename is built from THIS and a
 *                fixed extension — never from the provider's URL, which is
 *                attacker-adjacent input and the usual way a path escapes its
 *                directory. There is nothing here for `..` to come from.
 */
export async function downloadImage(
  url: string,
  storageDir: string,
  subdir: string,
  id: string,
  sleep: (ms: number) => Promise<void>,
  attempts = DOWNLOAD_ATTEMPTS,
): Promise<string> {
  let lastStatus = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
        throw new OhRequestError(200, `image size ${buffer.byteLength}`, 'Her picture could not be downloaded.');
      }

      const path = resolve(join(storageDir, subdir, `${id}.jpg`));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buffer);
      return path;
    }

    lastStatus = response.status;
    if (response.status !== 404 && response.status !== 403) break;
    if (attempt < attempts) await sleep(DOWNLOAD_RETRY_MS);
  }

  throw new OhRequestError(
    lastStatus,
    `image download ${lastStatus}`,
    'Her picture could not be downloaded.',
  );
}

/**
 * Remove one of our files, carefully.
 *
 * The path comes out of our own row, but it is still checked against
 * MEDIA_STORAGE_DIR before anything is unlinked — a delete that trusts a
 * stored path is one bad row away from removing something else entirely. A
 * file that is already gone is not an error.
 */
export async function removeImage(path: string, storageDir: string): Promise<void> {
  if (!isInsideStorageRoot(storageDir, path)) return;
  await unlink(path).catch(() => {});
}
