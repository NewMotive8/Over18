import type { Db } from '../db/client.js';
import type { PromptGenerationEnv } from '../env.js';
import { createDriveFolderResolver, createNullDriveFolderResolver } from './drive-folder.js';
import {
  createGoogleDriveClient,
  createMockGoogleDriveClient,
  createUnconfiguredDriveClient,
  type GoogleDriveClient,
} from './google-drive-client.js';
import { RateLimiter } from './rate-limiter.js';
import {
  createMockXaiImageProvider,
  createXaiImageProvider,
  type XaiImageProvider,
} from './xai-image-provider.js';
import type { PromptRunnerDeps } from './runner.js';

/**
 * Turns environment into runner dependencies.
 *
 * ONE PLACE DECIDES WHETHER MONEY CAN BE SPENT, and it is this function. The
 * live client is constructed only when `live` is true, which itself requires
 * both a confirm flag and a key — so a misconfigured deploy gets a mock and a
 * log line, never a surprise invoice. It is the same shape as
 * `selectMediaProviders`.
 */
export function selectPromptGenerationDeps(env: PromptGenerationEnv, db: Db): PromptRunnerDeps {
  const limiter = new RateLimiter({
    requestsPerSecond: env.xai.requestsPerSecond,
    maxConcurrent: env.xai.maxConcurrent,
  });

  let xai: XaiImageProvider;
  if (env.xai.live && env.xai.apiKey) {
    xai = createXaiImageProvider(
      {
        baseUrl: env.xai.baseUrl,
        apiKey: env.xai.apiKey,
        model: env.xai.model,
        timeoutMs: env.xai.timeoutMs,
        maxAttempts: env.xai.maxAttempts,
      },
      limiter,
    );
  } else {
    xai = createMockXaiImageProvider();
  }

  let drive: GoogleDriveClient;
  let driveConfigured = false;
  /**
   * A DESTINATION FOLDER IS NO LONGER PART OF THIS CONDITION, and it cannot be.
   * Under `drive.file` the only usable folder is one this application creates
   * for itself at runtime, so demanding an id up front would make the working
   * configuration impossible to express. The three credentials are the gate;
   * the destination is resolved after them.
   */
  if (env.drive.live && env.drive.clientId && env.drive.clientSecret && env.drive.refreshToken) {
    drive = createGoogleDriveClient({
      clientId: env.drive.clientId,
      clientSecret: env.drive.clientSecret,
      refreshToken: env.drive.refreshToken,
      folderId: env.drive.folderId,
      timeoutMs: env.drive.timeoutMs,
      ...(env.drive.tokenUrl ? { tokenUrl: env.drive.tokenUrl } : {}),
      ...(env.drive.uploadUrl ? { uploadUrl: env.drive.uploadUrl } : {}),
      ...(env.drive.filesUrl ? { filesUrl: env.drive.filesUrl } : {}),
    });
    driveConfigured = true;
  } else if (env.xai.live) {
    // Live generation with no Drive configured would spend money and then have
    // nowhere to put the result. Refusing loudly beats a spool full of orphans.
    drive = createUnconfiguredDriveClient();
  } else {
    drive = createMockGoogleDriveClient();
    driveConfigured = true;
  }

  return {
    xai,
    drive,
    spoolDir: env.spoolDir,
    /**
     * The mock Drive gets a real resolver too, so the create-once-and-reuse
     * path is exercised in every offline run rather than only when a
     * credential happens to exist.
     */
    driveFolder: driveConfigured
      ? createDriveFolderResolver({ db, drive, configuredFolderId: env.drive.folderId })
      : createNullDriveFolderResolver(env.drive.folderId),
    concurrency: env.xai.maxConcurrent,
  };
}
