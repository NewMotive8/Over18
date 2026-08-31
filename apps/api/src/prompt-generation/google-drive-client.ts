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
  | 'not_configured'
  /** No refresh token at all: nobody has pressed Connect yet. */
  | 'not_connected'
  /**
   * The named folder is not addressable by this application.
   *
   * SPLIT OUT FROM `http` BECAUSE IT IS THE ONE FAILURE `drive.file` MAKES
   * LIKELY, and it demands a specific answer rather than a retry. Under that
   * scope a folder the operator created by hand is invisible to us, and Drive
   * reports invisible resources as 404 `notFound` — indistinguishable, without
   * this, from a folder that never existed. Production spent two rounds on a
   * bare "Drive returned HTTP 404" because this distinction was not drawn.
   */
  | 'folder_not_found';

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
  /**
   * Where the refresh token comes from, resolved PER EXCHANGE.
   *
   * A function rather than a string because the token now lives in the
   * database, put there by the operator pressing Connect. Baking it in at boot
   * would mean connecting Drive only took effect after a redeploy — which is
   * most of the problem this replaces.
   */
  refreshToken: () => Promise<string | null>;
  /**
   * A pre-configured destination, or null to let the caller supply one per
   * upload. NO LONGER REQUIRED: the destination is normally a folder this
   * application created for itself, whose id cannot be known in advance.
   */
  folderId: string | null;
  timeoutMs: number;
  tokenUrl?: string;
  uploadUrl?: string;
  /** The Drive metadata endpoint. Distinct from the upload endpoint. */
  filesUrl?: string;
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

/** What Drive knows about a folder we previously created. */
export interface DriveFolder {
  id: string;
  trashed: boolean;
}

export interface GoogleDriveClient {
  upload(file: DriveUpload): Promise<DriveUploadResult>;
  /**
   * Creates a folder in the account's My Drive root and returns its id.
   *
   * NO `parents` IS SENT, AND THAT IS THE WHOLE TRICK. `drive.file` permits
   * CREATING new items freely; what it forbids is ADDRESSING existing ones the
   * app did not create. Naming a parent would address one, so the folder is
   * created at the root, where it needs no parent — and because we created it,
   * every later call about it is inside the scope.
   */
  createFolder(name: string): Promise<DriveFolder>;
  /** The folder if we can still address it, or null if Drive says notFound. */
  getFolder(folderId: string): Promise<DriveFolder | null>;
}

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DEFAULT_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * The two OAuth fields an operator actually needs, and nothing else.
 *
 * A TOKEN ERROR BODY IS NOT SAFE TO ECHO WHOLESALE — it can carry the client
 * id, and a malformed request is reflected back with the parameters that were
 * sent. So this is an ALLOWLIST of exactly two Google-authored fields rather
 * than a redaction of everything else: `error` (a code such as
 * `invalid_grant`) and `error_description` (a sentence such as "Token has been
 * expired or revoked."). Any other key in the body is not read at all, so it
 * cannot leak by being overlooked.
 *
 * THREE INDEPENDENT GUARDS, because one is a single point of failure:
 *  1. the allowlist above;
 *  2. a character class per field — the code is an OAuth identifier and is
 *     reduced to `[a-z0-9_-]`, so a token pasted into that field could not
 *     survive intact; the description keeps only printable ASCII;
 *  3. a final sweep for the configured credentials themselves. If Google ever
 *     echoed one back inside these fields, it is replaced with `[redacted]`
 *     rather than travelling into an error message or a log line.
 */
function oauthErrorReason(
  body: string,
  secrets: readonly string[],
): { code: string | null; description: string | null } {
  const redact = (value: string): string => {
    let out = value;
    for (const secret of secrets) {
      if (secret.length >= 8) out = out.split(secret).join('[redacted]');
    }
    return out;
  };
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    const rawCode = typeof parsed.error === 'string' ? parsed.error : null;
    const rawDescription =
      typeof parsed.error_description === 'string' ? parsed.error_description : null;
    const code = rawCode
      ? redact(rawCode.trim().slice(0, 64)).replace(/[^a-zA-Z0-9_-]/g, '')
      : null;
    const description = rawDescription
      ? redact(rawDescription.trim().slice(0, 200)).replace(/[^\x20-\x7e]/g, '')
      : null;
    return { code: code || null, description: description || null };
  } catch {
    return { code: null, description: null };
  }
}

/**
 * Google's machine-readable failure reason, pulled out of a DRIVE error body.
 *
 * A Drive error body describes a FILE — an id, a name, a reason like
 * `notFound` or `storageQuotaExceeded` — so it is read whole. The token
 * endpoint is a different shape with different risks and has its own reader
 * above; this function is never pointed at it.
 */
function driveErrorReason(body: string): { reason: string | null; message: string | null } {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    };
    const reason = parsed.error?.errors?.[0]?.reason ?? null;
    const message = parsed.error?.message ?? null;
    return {
      reason: typeof reason === 'string' ? reason.slice(0, 64) : null,
      // Bounded: enough to name the resource, never enough to carry a payload.
      message: typeof message === 'string' ? message.slice(0, 200) : null,
    };
  } catch {
    return { reason: null, message: null };
  }
}

export function createGoogleDriveClient(
  config: DriveConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): GoogleDriveClient {
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const uploadUrl = config.uploadUrl ?? DEFAULT_UPLOAD_URL;
  const filesUrl = config.filesUrl ?? DEFAULT_FILES_URL;
  /**
   * The values that must never appear in a message or a log, whatever Google
   * sends back. Held here so the check is against the ACTUAL configured
   * credentials rather than a guess at their shape.
   */
  const staticSecrets = [config.clientId, config.clientSecret].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

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
    const refreshToken = await config.refreshToken();
    if (!refreshToken) {
      /**
       * NOT `auth`, BECAUSE THE ANSWER IS DIFFERENT. `auth` means Google
       * refused what we sent and the operator should re-authorise; this means
       * we had nothing to send and the operator should CONNECT. Telling them to
       * re-authorise a connection that was never made sends them looking for a
       * broken thing that does not exist.
       */
      throw new DriveError(
        'not_connected',
        'Google Drive is not connected. Connect it in Admin -> Generation.',
      );
    }
    // The live token joins the redaction set for this exchange only, so it can
    // never survive into a message even if Google echoed it back.
    const secrets = [...staticSecrets, refreshToken];
    let response: Response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: refreshToken,
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
      /**
       * WHY THE BODY IS READ HERE NOW, AFTER BEING REFUSED ON PURPOSE.
       *
       * The original message named only an HTTP status, and production spent a
       * round of diagnosis on "HTTP 400" that `invalid_grant` +
       * "Token has been expired or revoked." would have answered instantly:
       * one says something is wrong, the other says go and re-authorise.
       * `oauthErrorReason` reads exactly two Google-authored fields and
       * nothing else, so the reason reaches the operator while the rest of the
       * body — including anything reflected back from our own request — is
       * never touched.
       */
      const detail = oauthErrorReason(await response.text().catch(() => ''), secrets);
      const reason = [detail.code, detail.description].filter(Boolean).join(': ');
      throw new DriveError(
        'auth',
        `Google refused the refresh token (HTTP ${response.status}${
          reason ? ` — ${reason}` : ''
        }). Re-authorise the Drive connection.`,
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

  /** One authenticated JSON request against the Drive metadata endpoint. */
  async function filesRequest(
    url: string,
    init: { method: 'GET' | 'POST'; body?: string },
    what: string,
  ): Promise<Response> {
    const token = await accessToken();
    try {
      return await fetchImpl(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new DriveError('timeout', `The Drive ${what} request timed out.`);
      }
      throw new DriveError('network', `The Drive ${what} request could not be sent.`);
    }
  }

  return {
    async createFolder(name) {
      const response = await filesRequest(
        `${filesUrl}?fields=id%2Ctrashed&supportsAllDrives=true`,
        { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER_MIME }) },
        'folder creation',
      );
      if (response.status === 401) {
        cachedToken = null;
        throw new DriveError('auth', 'Drive rejected our access token.', 401);
      }
      if (!response.ok) {
        const detail = driveErrorReason(await response.text().catch(() => ''));
        if (detail.reason === 'storageQuotaExceeded') {
          throw new DriveError(
            'quota',
            'The Google account is out of Drive storage, so the destination folder could not be created.',
            403,
          );
        }
        throw new DriveError(
          'http',
          `Drive refused to create the destination folder (HTTP ${response.status}${
            detail.reason ? `, ${detail.reason}` : ''
          }).`,
          response.status,
        );
      }
      let body: { id?: string; trashed?: boolean };
      try {
        body = (await response.json()) as { id?: string; trashed?: boolean };
      } catch {
        throw new DriveError('malformed_response', 'Drive returned an unreadable folder response.');
      }
      if (typeof body.id !== 'string' || body.id.length === 0) {
        // Without an id the folder is unusable and, worse, unrecorded — a
        // second attempt would create another one. Fail instead.
        throw new DriveError('malformed_response', 'Drive did not return a folder id.');
      }
      return { id: body.id, trashed: body.trashed === true };
    },

    async getFolder(folderId) {
      const response = await filesRequest(
        `${filesUrl}/${encodeURIComponent(folderId)}?fields=id%2Ctrashed&supportsAllDrives=true`,
        { method: 'GET' },
        'folder lookup',
      );
      if (response.status === 401) {
        cachedToken = null;
        throw new DriveError('auth', 'Drive rejected our access token.', 401);
      }
      // 404 here is the EXPECTED answer for a folder we no longer own or that
      // was never ours, so it is a value rather than an error: the caller makes
      // a new folder instead of failing every upload for ever.
      if (response.status === 404) return null;
      if (!response.ok) {
        const detail = driveErrorReason(await response.text().catch(() => ''));
        throw new DriveError(
          'http',
          `Drive could not confirm the destination folder (HTTP ${response.status}${
            detail.reason ? `, ${detail.reason}` : ''
          }).`,
          response.status,
        );
      }
      let body: { id?: string; trashed?: boolean };
      try {
        body = (await response.json()) as { id?: string; trashed?: boolean };
      } catch {
        throw new DriveError('malformed_response', 'Drive returned an unreadable folder response.');
      }
      if (typeof body.id !== 'string' || body.id.length === 0) return null;
      return { id: body.id, trashed: body.trashed === true };
    },

    async upload(file) {
      const token = await accessToken();
      const folderId = file.folderId ?? config.folderId;
      if (!folderId) {
        throw new DriveError(
          'not_configured',
          'No Google Drive destination folder has been resolved.',
        );
      }

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
      if (response.status === 404) {
        /**
         * THE PARENT FOLDER IS THE ONLY RESOURCE THIS REQUEST NAMES, so a 404
         * is always about it. Under `drive.file` that most often means the
         * folder is real and owned by the operator but was created by hand, so
         * this application cannot address it — a distinction Google expresses
         * only as `notFound`, and which no amount of retrying will change.
         */
        const detail = driveErrorReason(await response.text().catch(() => ''));
        throw new DriveError(
          'folder_not_found',
          `Drive cannot see the destination folder${
            detail.reason ? ` (${detail.reason})` : ''
          }. Under the drive.file scope this app can only use a folder it created itself.`,
          404,
        );
      }
      if (!response.ok) {
        const detail = driveErrorReason(await response.text().catch(() => ''));
        throw new DriveError(
          'http',
          `Drive returned HTTP ${response.status}${detail.reason ? ` (${detail.reason})` : ''}.`,
          response.status,
        );
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

/**
 * Records uploads instead of performing them. The default when not configured.
 *
 * It MODELS FOLDER OWNERSHIP rather than ignoring it: `createFolder` mints an
 * id and remembers it, and `getFolder` answers null for anything it did not
 * mint. That is the `drive.file` rule in miniature, so the resolver's
 * create-once, reuse-and-verify logic is exercised identically offline and in
 * production instead of only being reached when a credential exists.
 */
export function createMockGoogleDriveClient(
  sink: DriveUpload[] = [],
): GoogleDriveClient & { uploads: DriveUpload[]; folders: Map<string, DriveFolder> } {
  const folders = new Map<string, DriveFolder>();
  return {
    uploads: sink,
    folders,
    async createFolder(name) {
      const folder: DriveFolder = { id: `mock-folder-${folders.size + 1}-${name}`, trashed: false };
      folders.set(folder.id, folder);
      return folder;
    },
    async getFolder(folderId) {
      return folders.get(folderId) ?? null;
    },
    async upload(file) {
      sink.push(file);
      const id = `mock-drive-${sink.length}-${file.filename}`;
      return { fileId: id, webViewLink: `https://drive.google.com/file/d/${id}/view` };
    },
  };
}

export function createUnconfiguredDriveClient(): GoogleDriveClient {
  const refuse = (): never => {
    throw new DriveError('not_configured', 'Google Drive is not configured on this server.');
  };
  return {
    async upload() {
      return refuse();
    },
    async createFolder() {
      return refuse();
    },
    async getFolder() {
      return refuse();
    },
  };
}
