import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { promptDriveConnections, promptDriveOauthStates } from '../db/schema.js';

/**
 * The Google Drive connection, made from Admin -> Generation rather than pasted
 * into an environment variable.
 *
 * WHY THIS EXISTS. The refresh token was previously minted by hand in the OAuth
 * Playground and set as `GOOGLE_OAUTH_REFRESH_TOKEN`. When Google refused it
 * with `invalid_grant: Token has been expired or revoked.` the only remedy was
 * a developer: open the Playground, re-mint, edit a Railway variable, wait for
 * a redeploy. That is a production dependency on a manual step, and it is the
 * step that failed. A Connect button makes re-authorising something the
 * operator does in ten seconds without a deploy.
 *
 * THE ENVIRONMENT VARIABLE STILL WORKS, and deliberately: it is the fallback
 * when no connection row exists. Deploying this changes nothing until Connect
 * is pressed, which is the ordering that avoids the mistake of removing a
 * setting before the code that replaces it is live.
 *
 * SCOPE IS UNCHANGED — `drive.file`, exactly as before. Nothing here widens
 * what the token can reach.
 */

export const DEFAULT_SLOT = 'default';
/** The only scope ever requested. Widening it is a deliberate code change. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** Ten minutes: long enough to read Google's consent screen, short enough. */
const STATE_TTL_MS = 10 * 60 * 1000;

export type ConnectionErrorKind =
  | 'no_key'
  | 'bad_key'
  | 'not_connected'
  | 'corrupt'
  | 'bad_state'
  | 'no_refresh_token';

export class DriveConnectionError extends Error {
  constructor(
    public readonly kind: ConnectionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DriveConnectionError';
  }
}

/* ------------------------------------------------------------------ *
 * Encryption at rest
 * ------------------------------------------------------------------ */

/**
 * AES-256-GCM, and GCM rather than CBC because it AUTHENTICATES.
 *
 * A tampered ciphertext fails to decrypt outright instead of producing
 * plausible rubbish that would then be sent to Google as a refresh token. The
 * key never leaves the server and is never stored beside the ciphertext.
 */
function keyFrom(rawKey: string | null): Buffer {
  if (!rawKey) {
    throw new DriveConnectionError(
      'no_key',
      'PROMPT_GENERATION_TOKEN_KEY is not set, so a Drive connection cannot be stored securely.',
    );
  }
  const key = Buffer.from(rawKey, 'base64');
  if (key.length !== 32) {
    throw new DriveConnectionError(
      'bad_key',
      'PROMPT_GENERATION_TOKEN_KEY must be 32 bytes encoded as base64.',
    );
  }
  return key;
}

export function encryptToken(
  plaintext: string,
  rawKey: string | null,
): { ciphertext: string; iv: string; tag: string } {
  const key = keyFrom(rawKey);
  // A fresh 12-byte IV per encryption. Reusing one under GCM is catastrophic,
  // so it is generated here rather than configured anywhere.
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptToken(
  parts: { ciphertext: string; iv: string; tag: string },
  rawKey: string | null,
): string {
  const key = keyFrom(rawKey);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parts.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, or the row was altered. Either way the value is not usable and
    // must not be sent anywhere. The message says nothing about the contents.
    throw new DriveConnectionError(
      'corrupt',
      'The stored Drive connection could not be decrypted. Reconnect Google Drive.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * The authorization URL
 * ------------------------------------------------------------------ */

export interface AuthorizationUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  /**
   * Endpoint override, defaulting to Google — the same idiom the Drive client
   * uses, so end-to-end verification drives the REAL consent redirect against a
   * local stand-in rather than a fake that shares no code with it.
   */
  authUrl?: string;
}

/**
 * `access_type=offline` is what makes Google return a refresh token at all.
 * `prompt=consent` is what makes it return a NEW one on re-authorising —
 * without it, an already-consented app gets an access token only, and
 * "reconnect" would silently leave the dead token in place.
 */
export function authorizationUrl(input: AuthorizationUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state: input.state,
  });
  return `${input.authUrl ?? AUTH_URL}?${params.toString()}`;
}

/* ------------------------------------------------------------------ *
 * State: minted, then consumed exactly once
 * ------------------------------------------------------------------ */

export async function mintState(db: Db, startedBy: string | null, now = new Date()): Promise<string> {
  // Opportunistic sweep, so abandoned attempts do not accumulate forever.
  await db.delete(promptDriveOauthStates).where(lt(promptDriveOauthStates.expiresAt, now));
  const state = randomBytes(32).toString('base64url');
  await db.insert(promptDriveOauthStates).values({
    state,
    startedBy,
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
  });
  return state;
}

/**
 * Consumes a state, or refuses.
 *
 * SINGLE USE: the row is deleted as part of the check, so a replayed callback
 * finds nothing. The comparison is timing-safe, which costs nothing and
 * removes a whole class of argument about whether it matters here.
 */
export async function consumeState(db: Db, candidate: string, now = new Date()): Promise<boolean> {
  if (!candidate || candidate.length > 512) return false;
  const [row] = await db
    .select()
    .from(promptDriveOauthStates)
    .where(
      and(eq(promptDriveOauthStates.state, candidate), gt(promptDriveOauthStates.expiresAt, now)),
    )
    .limit(1);
  if (!row) return false;
  const a = Buffer.from(row.state);
  const b = Buffer.from(candidate);
  const matches = a.length === b.length && timingSafeEqual(a, b);
  await db.delete(promptDriveOauthStates).where(eq(promptDriveOauthStates.state, row.state));
  return matches;
}

/* ------------------------------------------------------------------ *
 * The connection itself
 * ------------------------------------------------------------------ */

export interface ConnectionStatus {
  connected: boolean;
  /** 'oauth' = connected here; 'env' = the legacy variable; 'none'. */
  source: 'oauth' | 'env' | 'none';
  googleAccountEmail: string | null;
  scope: string | null;
  connectedAt: string | null;
  lastUsedAt: string | null;
  lastErrorKind: string | null;
  lastErrorAt: string | null;
}

export interface StoreConnectionInput {
  refreshToken: string;
  googleAccountEmail: string | null;
  scope: string | null;
  connectedBy: string | null;
  encryptionKey: string | null;
}

export async function storeConnection(db: Db, input: StoreConnectionInput): Promise<void> {
  const parts = encryptToken(input.refreshToken, input.encryptionKey);
  await db
    .insert(promptDriveConnections)
    .values({
      slot: DEFAULT_SLOT,
      refreshTokenCiphertext: parts.ciphertext,
      refreshTokenIv: parts.iv,
      refreshTokenTag: parts.tag,
      googleAccountEmail: input.googleAccountEmail,
      scope: input.scope,
      connectedBy: input.connectedBy,
      connectedAt: new Date(),
      lastErrorKind: null,
      lastErrorAt: null,
    })
    .onConflictDoUpdate({
      target: promptDriveConnections.slot,
      set: {
        refreshTokenCiphertext: parts.ciphertext,
        refreshTokenIv: parts.iv,
        refreshTokenTag: parts.tag,
        googleAccountEmail: input.googleAccountEmail,
        scope: input.scope,
        connectedBy: input.connectedBy,
        connectedAt: new Date(),
        // Re-authorising clears the old failure; leaving it would make a
        // healthy connection permanently look broken.
        lastErrorKind: null,
        lastErrorAt: null,
      },
    });
}

export async function clearConnection(db: Db): Promise<boolean> {
  const rows = await db
    .delete(promptDriveConnections)
    .where(eq(promptDriveConnections.slot, DEFAULT_SLOT))
    .returning();
  return rows.length > 0;
}

export async function connectionStatus(
  db: Db,
  envRefreshTokenPresent: boolean,
): Promise<ConnectionStatus> {
  const [row] = await db
    .select()
    .from(promptDriveConnections)
    .where(eq(promptDriveConnections.slot, DEFAULT_SLOT))
    .limit(1);
  if (!row) {
    return {
      connected: envRefreshTokenPresent,
      source: envRefreshTokenPresent ? 'env' : 'none',
      googleAccountEmail: null,
      scope: envRefreshTokenPresent ? DRIVE_SCOPE : null,
      connectedAt: null,
      lastUsedAt: null,
      lastErrorKind: null,
      lastErrorAt: null,
    };
  }
  return {
    connected: true,
    source: 'oauth',
    googleAccountEmail: row.googleAccountEmail,
    scope: row.scope,
    connectedAt: row.connectedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastErrorKind: row.lastErrorKind,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
  };
}

/**
 * Records that Google refused us, as a KIND only.
 *
 * This is what turns "it stopped working" into a sentence on the screen next
 * to a Reconnect button, instead of an investigation.
 */
export async function recordConnectionError(db: Db, kind: string): Promise<void> {
  await db
    .update(promptDriveConnections)
    .set({ lastErrorKind: kind.slice(0, 64), lastErrorAt: new Date() })
    .where(eq(promptDriveConnections.slot, DEFAULT_SLOT));
}

export async function markConnectionUsed(db: Db): Promise<void> {
  await db
    .update(promptDriveConnections)
    .set({ lastUsedAt: new Date(), lastErrorKind: null, lastErrorAt: null })
    .where(eq(promptDriveConnections.slot, DEFAULT_SLOT));
}

/**
 * The refresh token the Drive client should use right now.
 *
 * READ PER EXCHANGE, NOT AT BOOT. That is the whole point: pressing Connect
 * has to take effect on the next upload, not on the next deploy.
 */
export function createRefreshTokenSource(options: {
  db: Db;
  encryptionKey: string | null;
  envRefreshToken: string | null;
}): () => Promise<string | null> {
  return async () => {
    const [row] = await options.db
      .select()
      .from(promptDriveConnections)
      .where(eq(promptDriveConnections.slot, DEFAULT_SLOT))
      .limit(1);
    if (!row) return options.envRefreshToken;
    return decryptToken(
      {
        ciphertext: row.refreshTokenCiphertext,
        iv: row.refreshTokenIv,
        tag: row.refreshTokenTag,
      },
      options.encryptionKey,
    );
  };
}

/* ------------------------------------------------------------------ *
 * The authorization-code exchange
 * ------------------------------------------------------------------ */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export interface ExchangeResult {
  refreshToken: string;
  scope: string | null;
  /** Best effort. A connection without it still works. */
  email: string | null;
}

export interface ExchangeInput {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  timeoutMs?: number;
}

/**
 * Swaps Google's one-time code for a refresh token. SERVER SIDE ONLY.
 *
 * This is the step that must never move to the browser: it carries the client
 * secret. The browser's entire involvement is being redirected to Google and
 * back with an opaque code, which is worthless without the secret held here.
 */
export async function exchangeAuthorizationCode(
  input: ExchangeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const response = await fetchImpl(input.tokenUrl ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // Same rule as everywhere else: two named fields, nothing else read.
    let code: string | null = null;
    let description: string | null = null;
    try {
      const body = (await response.json()) as { error?: unknown; error_description?: unknown };
      if (typeof body.error === 'string') code = body.error.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '');
      if (typeof body.error_description === 'string') {
        description = body.error_description.slice(0, 200).replace(/[^\x20-\x7e]/g, '');
      }
    } catch {
      /* an unreadable body just means no reason to show */
    }
    const reason = [code, description].filter(Boolean).join(': ');
    throw new DriveConnectionError(
      'bad_state',
      `Google refused the authorization code (HTTP ${response.status}${reason ? ` — ${reason}` : ''}).`,
    );
  }

  const body = (await response.json()) as {
    refresh_token?: unknown;
    access_token?: unknown;
    scope?: unknown;
  };
  if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
    /**
     * Google returns a refresh token only when it feels like it — chiefly on
     * FIRST consent. `prompt=consent` is what forces one every time, so if we
     * are here that parameter has been lost, and storing the access token
     * instead would produce a connection that dies within the hour.
     */
    throw new DriveConnectionError(
      'no_refresh_token',
      'Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.',
    );
  }

  let email: string | null = null;
  if (typeof body.access_token === 'string' && body.access_token.length > 0) {
    // Best effort, and deliberately non-fatal: knowing WHICH account was
    // connected prevents images quietly landing in the wrong Drive, but a
    // failure here must not lose a refresh token we already hold.
    try {
      const who = await fetchImpl(input.userinfoUrl ?? USERINFO_URL, {
        headers: { authorization: `Bearer ${body.access_token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (who.ok) {
        const profile = (await who.json()) as { email?: unknown };
        if (typeof profile.email === 'string') email = profile.email.slice(0, 320);
      }
    } catch {
      /* non-fatal */
    }
  }

  return {
    refreshToken: body.refresh_token,
    scope: typeof body.scope === 'string' ? body.scope.slice(0, 512) : null,
    email,
  };
}
