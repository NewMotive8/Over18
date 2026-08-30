import { Buffer } from 'node:buffer';

/**
 * Google Drive uploads, over plain `fetch`.
 *
 * TWO ENDPOINTS, NO SDK. `googleapis` would pull a very large dependency tree
 * to reach a token exchange and a single multipart POST, and this codebase
 * calls every other provider — Atlas, RunPod, the LLM endpoint — with bare
 * `fetch`. Following that keeps the dependency list honest.
 *
 * WHY OAUTH AND NOT A SERVICE ACCOUNT. Google's own guidance is explicit:
 * "Service accounts don't have storage quota and can't own any files. Instead,
 * they must upload files and folders into shared drives, or use OAuth 2.0 to
 * upload items on behalf of a human user." Shared drives require Google
 * Workspace; the destination here is a personal Gmail account's Drive, so the
 * service-account path would fail with `storageQuotaExceeded` on the very
 * first upload. A refresh token owned by the account holder is the only
 * mechanism that works, and it leaves the files owned by them.
 *
 * SCOPE IS `drive.file`, WHICH IS THE SECURITY PROPERTY. That scope grants
 * access only to files this application itself creates. Even with a valid
 * token this client cannot read, list or modify anything else in the account —
 * so the blast radius of the stored refresh token is the folder it writes to.
 *
 * NOTHING IS EVER MADE PUBLIC. There is no `permissions.create` call in this
 * file, and adding one would be the only way a generated image could become
 * publicly reachable. Drive's default for a newly created file is private to
 * its owner, so privacy here is the absence of code rather than a setting.
 */

export type DriveErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'quota'
  | 'http'
  | 'network'
  | 'timeout'
  | 'malformed_response'
  | 'not_configured';

export class DriveError extends Error {
  constructor(
    public readonly kind: DriveErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'DriveError';
  }

  get retryable(): boolean {
    if (this.kind === 'rate_limited' || this.kind === 'network' || this.kind === 'timeout') {
      return true;
    }
    return this.kind === 'http' && this.status !== undefined && this.status >= 500;
  }
}

export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId: string;
  timeoutMs: number;
  tokenUrl?: string;
  uploadUrl?: string;
}

export interface DriveUpload {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  /** Overrides the configured folder. Recorded per batch so history is stable. */
  folderId?: string;
}

export interface DriveUploadResult {
  fileId: string;
  webViewLink: string | null;
}

export interface GoogleDriveClient {
  upload(file: DriveUpload): Promise<DriveUploadResult>;
}

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

export function createGoogleDriveClient(
  config: DriveConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): GoogleDriveClient {
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const uploadUrl = config.uploadUrl ?? DEFAULT_UPLOAD_URL;

  /**
   * The cached access token.
   *
   * Cached because a 200-image batch would otherwise perform 200 token
   * exchanges, and Google rate limits those too. Expiry is treated as 60
   * seconds earlier than stated so a token cannot lapse mid-upload.
   */
  let cachedToken: { value: string; expiresAtMs: number } | null = null;
  /**
   * The exchange currently in flight, if any.
   *
   * Without this, the first N concurrent uploads each find an empty cache and
   * each start their own token exchange — a thundering herd against an endpoint
   * Google also rate limits. Sharing the promise makes N concurrent callers
   * perform exactly ONE exchange, which is what the browser run measured.
   */
  let inFlight: Promise<string> | null = null;

  async function accessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAtMs > now()) return cachedToken.value;
    if (inFlight) return inFlight;
    inFlight = exchangeToken().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function exchangeToken(): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: config.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new DriveError('timeout', 'The Google token request timed out.');
      }
      throw new DriveError('network', 'The Google token request could not be sent.');
    }

    if (!response.ok) {
      // Deliberately body-free: a token error body echoes the client id and
      // sometimes the refresh token itself.
      throw new DriveError(
        'auth',
        `Google refused the refresh token (HTTP ${response.status}). Re-authorise the Drive connection.`,
        response.status,
      );
    }

    let body: { access_token?: string; expires_in?: number };
    try {
      body = (await response.json()) as { access_token?: string; expires_in?: number };
    } catch {
      throw new DriveError('malformed_response', 'Google returned an unreadable token response.');
    }
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new DriveError('malformed_response', 'Google returned no access token.');
    }
    const lifetimeSeconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    cachedToken = {
      value: body.access_token,
      expiresAtMs: now() + Math.max(0, lifetimeSeconds - 60) * 1000,
    };
    return cachedToken.value;
  }

  return {
    async upload(file) {
      const token = await accessToken();
      const folderId = file.folderId ?? config.folderId;

      /**
       * `uploadType=multipart` — one request carrying metadata and bytes.
       *
       * Google recommends resumable uploads above 5MB. A 2K JPEG is far below
       * that, so multipart is the right shape: one round trip, no session URI
       * to persist, and nothing to resume. If this ever carried video, the
       * resumable path would have to replace it.
       *
       * `supportsAllDrives` is sent so the same code keeps working unchanged if
       * the destination later becomes a shared drive.
       */
      const boundary = `over18-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
      const metadata = JSON.stringify({ name: file.filename, parents: [folderId] });
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
          'utf8',
        ),
        Buffer.from(`--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`, 'utf8'),
        file.bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
      ]);

      const url = `${uploadUrl}?uploadType=multipart&supportsAllDrives=true&fields=id%2CwebViewLink`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': `multipart/related; boundary=${boundary}`,
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new DriveError('timeout', 'The Drive upload timed out.');
        }
        throw new DriveError('network', 'The Drive upload could not be sent.');
      }

      if (response.status === 401) {
        // The cached token may simply have been revoked; drop it so the next
        // attempt re-exchanges rather than replaying a dead token.
        cachedToken = null;
        throw new DriveError('auth', 'Drive rejected our access token.', 401);
      }
      if (response.status === 429) {
        throw new DriveError(
          'rate_limited',
          'Drive is rate limiting us.',
          429,
          Number(response.headers.get('retry-after')) || null,
        );
      }
      if (response.status === 403) {
        /**
         * 403 SPLITS INTO TWO VERY DIFFERENT PROBLEMS, and telling them apart
         * is what stops an operator retrying forever. `storageQuotaExceeded`
         * means the Drive is full (or a service account was used, which has no
         * quota at all) and no amount of retrying will help; a rate-limit 403
         * is transient.
         */
        const detail = await response.text().catch(() => '');
        if (detail.includes('storageQuotaExceeded')) {
          throw new DriveError(
            'quota',
            'The Google account is out of Drive storage, so the image could not be saved.',
            403,
          );
        }
        if (detail.includes('rateLimitExceeded') || detail.includes('userRateLimitExceeded')) {
          throw new DriveError('rate_limited', 'Drive is rate limiting us.', 403);
        }
        throw new DriveError(
          'http',
          'Drive refused the upload. Check that the destination folder exists and is owned by the connected account.',
          403,
        );
      }
      if (!response.ok) {
        throw new DriveError('http', `Drive returned HTTP ${response.status}.`, response.status);
      }

      let body2: { id?: string; webViewLink?: string };
      try {
        body2 = (await response.json()) as { id?: string; webViewLink?: string };
      } catch {
        throw new DriveError('malformed_response', 'Drive returned an unreadable response.');
      }
      if (typeof body2.id !== 'string' || body2.id.length === 0) {
        // Without an id we cannot prove the file landed, and reporting success
        // would lose the image silently — the exact failure this feature is
        // required to prevent.
        throw new DriveError('malformed_response', 'Drive did not return a file id.');
      }
      return { fileId: body2.id, webViewLink: body2.webViewLink ?? null };
    },
  };
}

/** Records uploads instead of performing them. The default when not configured. */
export function createMockGoogleDriveClient(
  sink: DriveUpload[] = [],
): GoogleDriveClient & { uploads: DriveUpload[] } {
  return {
    uploads: sink,
    async upload(file) {
      sink.push(file);
      const id = `mock-drive-${sink.length}-${file.filename}`;
      return { fileId: id, webViewLink: `https://drive.google.com/file/d/${id}/view` };
    },
  };
}

export function createUnconfiguredDriveClient(): GoogleDriveClient {
  return {
    async upload() {
      throw new DriveError(
        'not_configured',
        'Google Drive is not configured on this server.',
      );
    },
  };
}
