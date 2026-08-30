import type { PromptGenerationEnv } from '../env.js';
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
export function selectPromptGenerationDeps(env: PromptGenerationEnv): PromptRunnerDeps {
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
  if (
    env.drive.live &&
    env.drive.clientId &&
    env.drive.clientSecret &&
    env.drive.refreshToken &&
    env.drive.folderId
  ) {
    drive = createGoogleDriveClient({
      clientId: env.drive.clientId,
      clientSecret: env.drive.clientSecret,
      refreshToken: env.drive.refreshToken,
      folderId: env.drive.folderId,
      timeoutMs: env.drive.timeoutMs,
      ...(env.drive.tokenUrl ? { tokenUrl: env.drive.tokenUrl } : {}),
      ...(env.drive.uploadUrl ? { uploadUrl: env.drive.uploadUrl } : {}),
    });
  } else if (env.xai.live) {
    // Live generation with no Drive configured would spend money and then have
    // nowhere to put the result. Refusing loudly beats a spool full of orphans.
    drive = createUnconfiguredDriveClient();
  } else {
    drive = createMockGoogleDriveClient();
  }

  return {
    xai,
    drive,
    spoolDir: env.spoolDir,
    defaultFolderId: env.drive.folderId,
    concurrency: env.xai.maxConcurrent,
  };
}
