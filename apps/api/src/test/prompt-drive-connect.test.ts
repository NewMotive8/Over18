import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  promptDriveConnections,
  promptDriveOauthStates,
  promptJobOutputs,
  promptJobs,
} from '../db/schema.js';
import {
  DRIVE_SCOPE,
  DriveConnectionError,
  authorizationUrl,
  clearConnection,
  connectionStatus,
  consumeState,
  createRefreshTokenSource,
  decryptToken,
  encryptToken,
  exchangeAuthorizationCode,
  mintState,
  storeConnection,
} from '../prompt-generation/drive-connection.js';
import { createGoogleDriveClient, DriveError } from '../prompt-generation/google-drive-client.js';
import { createDriveFolderResolver } from '../prompt-generation/drive-folder.js';
import { executeJob, type PromptRunnerDeps } from '../prompt-generation/runner.js';
import { addPromptFiles, createBatch } from '../prompt-generation/batches.js';
import { DEFAULT_PARAMS } from '../prompt-generation/config.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * CONNECT GOOGLE DRIVE — the replacement for a hand-minted refresh token.
 *
 * Production died on `invalid_grant: Token has been expired or revoked.`, and
 * the only remedy was a developer with the OAuth Playground and a Railway
 * variable. What this suite pins is that the same recovery is now a button, and
 * that making it a button did not put a credential anywhere it should not be:
 *
 *  1. the browser never receives a client secret or a token;
 *  2. the state is unguessable, single-use and expiring;
 *  3. the refresh token is encrypted at rest and unreadable with a wrong key;
 *  4. the scope requested is exactly `drive.file` and nothing more;
 *  5. connect / disconnect / reconnect behave as an operator would expect;
 *  6. the folder resolver is untouched, and an existing `drive_upload_failed`
 *     batch recovers with ZERO xAI calls once a connection exists.
 */

const KEY = 'Y2FmZWJhYmVkZWFkYmVlZmNhZmViYWJlZGVhZGJlZWY=';
const OTHER_KEY = Buffer.alloc(32, 7).toString('base64');

let on: TestContext;
let adminCookies: Record<string, string>;
let userCookies: Record<string, string>;
let spoolDir: string;

beforeAll(async () => {
  migrateTestDb();
  spoolDir = mkdtempSync(join(tmpdir(), 'connect-spool-'));
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));

beforeEach(async () => {
  await truncateAll(on);
  adminCookies = await register('connect.admin@example.com', 'admin');
  userCookies = await register('connect.user@example.com', 'user');
});

async function register(email: string, role: 'admin' | 'user') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'connect-drive-1' },
  });
  const cookie = extractSessionCookie(res)!;
  if (role === 'admin') {
    await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  }
  return { [cookie.name]: cookie.value };
}

/* ------------------------------------------------------------------ *
 * Encryption at rest
 * ------------------------------------------------------------------ */

describe('the refresh token at rest', () => {
  it('round-trips through AES-256-GCM', () => {
    const parts = encryptToken('1//super-secret-refresh-token', KEY);
    expect(decryptToken(parts, KEY)).toBe('1//super-secret-refresh-token');
  });

  it('never stores the plaintext, in any column', async () => {
    await storeConnection(on.db, {
      refreshToken: '1//super-secret-refresh-token',
      googleAccountEmail: 'someone@example.com',
      scope: DRIVE_SCOPE,
      connectedBy: null,
      encryptionKey: KEY,
    });
    const [row] = await on.db.select().from(promptDriveConnections);
    expect(JSON.stringify(row)).not.toContain('super-secret-refresh-token');
    // And the raw database bytes do not either.
    const raw = await on.pool.query('SELECT * FROM prompt_drive_connections');
    expect(JSON.stringify(raw.rows)).not.toContain('super-secret-refresh-token');
  });

  it('a different key cannot read it, and fails closed', () => {
    const parts = encryptToken('1//super-secret-refresh-token', KEY);
    expect(() => decryptToken(parts, OTHER_KEY)).toThrow(DriveConnectionError);
    try {
      decryptToken(parts, OTHER_KEY);
    } catch (error) {
      // GCM authenticates, so a wrong key is a REFUSAL rather than plausible
      // rubbish that would then be sent to Google as a refresh token.
      expect((error as DriveConnectionError).kind).toBe('corrupt');
      expect((error as Error).message).not.toContain('super-secret');
    }
  });

  it('a tampered ciphertext is refused rather than decrypted', () => {
    const parts = encryptToken('1//super-secret-refresh-token', KEY);
    const flipped = Buffer.from(parts.ciphertext, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() =>
      decryptToken({ ...parts, ciphertext: flipped.toString('base64') }, KEY),
    ).toThrow(DriveConnectionError);
  });

  it('refuses to encrypt at all without a key, rather than storing plaintext', () => {
    expect(() => encryptToken('x', null)).toThrow(DriveConnectionError);
    expect(() => encryptToken('x', 'too-short')).toThrow(DriveConnectionError);
  });

  it('uses a fresh IV every time, so identical tokens differ on disk', () => {
    const a = encryptToken('same-token', KEY);
    const b = encryptToken('same-token', KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

/* ------------------------------------------------------------------ *
 * The authorization URL
 * ------------------------------------------------------------------ */

describe('the authorization URL', () => {
  it('requests exactly drive.file, offline, with forced consent', () => {
    const url = new URL(
      authorizationUrl({
        clientId: 'client-id.apps.googleusercontent.com',
        redirectUri: 'https://api.example/admin/prompt-generation/drive/callback',
        state: 'abc',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    // `offline` is what yields a refresh token at all; `consent` is what yields
    // a NEW one on reconnect, without which "reconnect" would silently keep a
    // dead token.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('abc');
    // No incremental widening: the scope we ask for is the scope we get.
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
  });

  it('cannot smuggle a wider scope, whatever the caller does', () => {
    const url = new URL(
      authorizationUrl({ clientId: 'c', redirectUri: 'https://api.example/cb', state: 's' }),
    );
    expect(url.searchParams.get('scope')).not.toContain('auth/drive ');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual([DRIVE_SCOPE]);
  });
});

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

describe('the state parameter', () => {
  it('is long, random, and different every time', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) seen.add(await mintState(on.db, null));
    expect(seen.size).toBe(20);
    for (const state of seen) expect(state.length).toBeGreaterThanOrEqual(40);
  });

  it('is single use — a replayed callback finds nothing', async () => {
    const state = await mintState(on.db, null);
    expect(await consumeState(on.db, state)).toBe(true);
    expect(await consumeState(on.db, state)).toBe(false);
  });

  it('refuses an unknown, empty or absurd state', async () => {
    expect(await consumeState(on.db, 'never-minted')).toBe(false);
    expect(await consumeState(on.db, '')).toBe(false);
    expect(await consumeState(on.db, 'x'.repeat(5000))).toBe(false);
  });

  it('expires, and an expired one is refused', async () => {
    const state = await mintState(on.db, null, new Date(Date.now() - 60 * 60 * 1000));
    expect(await consumeState(on.db, state)).toBe(false);
  });

  it('sweeps expired rows rather than accumulating them forever', async () => {
    await mintState(on.db, null, new Date(Date.now() - 60 * 60 * 1000));
    await mintState(on.db, null, new Date(Date.now() - 60 * 60 * 1000));
    expect(await on.db.select().from(promptDriveOauthStates)).toHaveLength(2);
    await mintState(on.db, null);
    // The two stale rows are gone; only the fresh one remains.
    expect(await on.db.select().from(promptDriveOauthStates)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * The code exchange
 * ------------------------------------------------------------------ */

describe('the authorization-code exchange', () => {
  const base = {
    code: 'one-time-code',
    clientId: 'client-id.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-the-client-secret',
    redirectUri: 'https://api.example/admin/prompt-generation/drive/callback',
    tokenUrl: 'https://oauth.example/token',
    userinfoUrl: 'https://userinfo.example/me',
  };

  it('sends the code and the secret server-side, and returns the refresh token', async () => {
    const sent: { url: string; body: string }[] = [];
    const result = await exchangeAuthorizationCode(base, (async (url: string, init: { body?: string }) => {
      sent.push({ url, body: init.body ?? '' });
      if (url.startsWith('https://userinfo.example')) {
        return new Response(JSON.stringify({ email: 'owner@example.com' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          refresh_token: '1//the-refresh-token',
          access_token: 'ya29.access',
          scope: DRIVE_SCOPE,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);

    expect(result.refreshToken).toBe('1//the-refresh-token');
    expect(result.scope).toBe(DRIVE_SCOPE);
    expect(result.email).toBe('owner@example.com');
    const token = sent.find((s) => s.url.startsWith('https://oauth.example'))!;
    expect(token.body).toContain('grant_type=authorization_code');
    expect(token.body).toContain('code=one-time-code');
  });

  it('refuses when Google returns no refresh token, rather than storing an access token', async () => {
    // Without a refresh token the "connection" would die within the hour, and
    // would look connected the whole time.
    const error = await exchangeAuthorizationCode(base, (async () =>
      new Response(JSON.stringify({ access_token: 'ya29.only' }), {
        status: 200,
      })) as unknown as typeof fetch).catch((e: unknown) => e as DriveConnectionError);
    expect((error as DriveConnectionError).kind).toBe('no_refresh_token');
  });

  it('surfaces Google’s reason on a refused code, without echoing our secret', async () => {
    const error = (await exchangeAuthorizationCode(base, (async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Bad Request',
          client_secret: 'GOCSPX-the-client-secret',
        }),
        { status: 400 },
      )) as unknown as typeof fetch).catch((e: unknown) => e)) as DriveConnectionError;
    expect(error.message).toContain('invalid_grant');
    expect(error.message).not.toContain('GOCSPX');
  });

  it('still connects when the email lookup fails — it is a nicety, not the token', async () => {
    const result = await exchangeAuthorizationCode(base, (async (url: string) => {
      if (url.startsWith('https://userinfo.example')) throw new Error('network');
      return new Response(
        JSON.stringify({ refresh_token: '1//t', access_token: 'a', scope: DRIVE_SCOPE }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);
    expect(result.refreshToken).toBe('1//t');
    expect(result.email).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Routes: authorization, and what reaches the browser
 * ------------------------------------------------------------------ */

describe('the connect routes', () => {
  const connect = (cookies = adminCookies) =>
    on.app.inject({ method: 'POST', url: '/admin/prompt-generation/drive/connect', cookies });

  it('is refused to anonymous callers and to ordinary users', async () => {
    expect(
      (await on.app.inject({ method: 'POST', url: '/admin/prompt-generation/drive/connect' }))
        .statusCode,
    ).toBe(401);
    expect((await connect(userCookies)).statusCode).toBe(403);
    expect(
      (
        await on.app.inject({
          method: 'POST',
          url: '/admin/prompt-generation/drive/disconnect',
          cookies: userCookies,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('refuses when the OAuth client is not configured, rather than half-starting', async () => {
    // testEnv has no client id, which is production's shape before setup.
    const res = await connect();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_configured');
  });

  it('settings report the connection without ever returning a token', async () => {
    await storeConnection(on.db, {
      refreshToken: '1//super-secret-refresh-token',
      googleAccountEmail: 'owner@example.com',
      scope: DRIVE_SCOPE,
      connectedBy: null,
      encryptionKey: KEY,
    });
    const res = await on.app.inject({
      method: 'GET',
      url: '/admin/prompt-generation/settings',
      cookies: adminCookies,
    });
    const body = res.json();
    expect(body.driveConnection.connected).toBe(true);
    expect(body.driveConnection.source).toBe('oauth');
    expect(body.driveConnection.googleAccountEmail).toBe('owner@example.com');
    // The whole payload, swept.
    for (const forbidden of [
      'super-secret-refresh-token',
      'refresh_token',
      'ciphertext',
      'client_secret',
      'Bearer',
    ]) {
      expect(res.payload).not.toContain(forbidden);
    }
  });

  it('disconnect removes the stored connection', async () => {
    await storeConnection(on.db, {
      refreshToken: '1//t',
      googleAccountEmail: 'owner@example.com',
      scope: DRIVE_SCOPE,
      connectedBy: null,
      encryptionKey: KEY,
    });
    const res = await on.app.inject({
      method: 'POST',
      url: '/admin/prompt-generation/drive/disconnect',
      cookies: adminCookies,
    });
    expect(res.json().disconnected).toBe(true);
    expect(await on.db.select().from(promptDriveConnections)).toHaveLength(0);
    expect((await connectionStatus(on.db, false)).connected).toBe(false);
  });

  it('the callback refuses a bad state and does NOT store anything', async () => {
    const res = await on.app.inject({
      method: 'GET',
      url: '/admin/prompt-generation/drive/callback?code=x&state=forged',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('drive=failed');
    expect(res.headers.location).toContain('reason=bad_state');
    expect(await on.db.select().from(promptDriveConnections)).toHaveLength(0);
  });

  it('a cancelled consent screen is reported as cancelled, not as a failure', async () => {
    const res = await on.app.inject({
      method: 'GET',
      url: '/admin/prompt-generation/drive/callback?error=access_denied&state=whatever',
    });
    expect(res.headers.location).toContain('drive=cancelled');
  });
});

/* ------------------------------------------------------------------ *
 * Reconnecting, and status
 * ------------------------------------------------------------------ */

describe('connect, reconnect and status', () => {
  it('reconnecting REPLACES the token and clears the previous failure', async () => {
    await storeConnection(on.db, {
      refreshToken: 'old-token',
      googleAccountEmail: 'owner@example.com',
      scope: DRIVE_SCOPE,
      connectedBy: null,
      encryptionKey: KEY,
    });
    await on.db
      .update(promptDriveConnections)
      .set({ lastErrorKind: 'auth', lastErrorAt: new Date() });

    await storeConnection(on.db, {
      refreshToken: 'new-token',
      googleAccountEmail: 'owner@example.com',
      scope: DRIVE_SCOPE,
      connectedBy: null,
      encryptionKey: KEY,
    });

    const rows = await on.db.select().from(promptDriveConnections);
    expect(rows).toHaveLength(1); // replaced, never duplicated
    expect(rows[0]!.lastErrorKind).toBeNull();
    const source = createRefreshTokenSource({
      db: on.db,
      encryptionKey: KEY,
      envRefreshToken: null,
    });
    expect(await source()).toBe('new-token');
  });

  it('falls back to the environment variable until something is connected', async () => {
    const source = createRefreshTokenSource({
      db: on.db,
      encryptionKey: KEY,
      envRefreshToken: 'legacy-env-token',
    });
    expect(await source()).toBe('legacy-env-token');
    expect((await connectionStatus(on.db, true)).source).toBe('env');

    await storeConnection(on.db, {
      refreshToken: 'connected-token',
      googleAccountEmail: null,
      scope: DRIVE_SCOPE,
      connectedBy: null,
      encryptionKey: KEY,
    });
    // The connection WINS once it exists — otherwise pressing Connect would
    // appear to work while the dead env token kept being used.
    expect(await source()).toBe('connected-token');
    expect((await connectionStatus(on.db, true)).source).toBe('oauth');
  });

  it('reports nothing connected when there is neither', async () => {
    const status = await connectionStatus(on.db, false);
    expect(status).toMatchObject({ connected: false, source: 'none', googleAccountEmail: null });
  });

  it('after disconnect the token source returns null, so uploads say NOT CONNECTED', async () => {
    await storeConnection(on.db, {
      refreshToken: 't',
      googleAccountEmail: null,
      scope: DRIVE_SCOPE,
      connectedBy: null,
      encryptionKey: KEY,
    });
    await clearConnection(on.db);
    const source = createRefreshTokenSource({
      db: on.db,
      encryptionKey: KEY,
      envRefreshToken: null,
    });
    expect(await source()).toBeNull();

    const client = createGoogleDriveClient({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: source,
      folderId: null,
      timeoutMs: 1000,
      tokenUrl: 'https://oauth.example/token',
      uploadUrl: 'https://upload.example/files',
      filesUrl: 'https://files.example/files',
    });
    const error = (await client.createFolder('x').catch((e: unknown) => e)) as DriveError;
    // NOT `auth`: the operator must be told to CONNECT, not to re-authorise a
    // connection that was never made.
    expect(error.kind).toBe('not_connected');
    expect(error.message).toContain('Connect it in Admin');
  });
});

/* ------------------------------------------------------------------ *
 * End to end: a connection makes an existing failed batch recoverable
 * ------------------------------------------------------------------ */

describe('recovering an existing drive_upload_failed batch once connected', () => {
  it('uploads the spooled images with ZERO xAI calls, into the app-created folder', async () => {
    /**
     * PRODUCTION'S EXACT SHAPE: a batch with no recorded destination whose
     * outputs are `drive_upload_failed` with their paid images still spooled.
     */
    const batch = await createBatch(on.db, {
      name: 'stranded batch',
      params: DEFAULT_PARAMS,
      driveFolderId: null,
    });
    await addPromptFiles(on.db, batch.id, [
      { filename: 'luna_001.txt', bytes: Buffer.from('a real prompt', 'utf8') },
    ]);
    const [job] = await on.db.select().from(promptJobs).where(eq(promptJobs.batchId, batch.id));
    const outputs = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.jobId, job!.id));
    for (const output of outputs) {
      const path = join(spoolDir, `paid-${job!.id}-${output.ordinal}.jpg`);
      await writeFile(path, Buffer.from(`PAID IMAGE ${output.ordinal}`));
      await on.db
        .update(promptJobOutputs)
        .set({ status: 'drive_upload_failed', spoolPath: path, generatedAt: new Date() })
        .where(eq(promptJobOutputs.id, output.id));
    }

    // Connect, exactly as the operator would.
    await storeConnection(on.db, {
      refreshToken: '1//a-working-refresh-token',
      googleAccountEmail: 'owner@example.com',
      scope: DRIVE_SCOPE,
      connectedBy: null,
      encryptionKey: KEY,
    });

    const xaiCalls: unknown[] = [];
    const folders = new Set<string>();
    const uploaded: { filename: string; folderId?: string; bytes: string }[] = [];
    let sentRefreshToken: string | null = null;

    const client = createGoogleDriveClient(
      {
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: createRefreshTokenSource({
          db: on.db,
          encryptionKey: KEY,
          envRefreshToken: null,
        }),
        folderId: null,
        timeoutMs: 1000,
        tokenUrl: 'https://oauth.example/token',
        uploadUrl: 'https://upload.example/files',
        filesUrl: 'https://files.example/files',
      },
      (async (url: string, init: { body?: string | Uint8Array }) => {
        if (url.startsWith('https://oauth.example')) {
          sentRefreshToken = new URLSearchParams(String(init.body)).get('refresh_token');
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
            status: 200,
          });
        }
        if (url.startsWith('https://files.example')) {
          const id = `folder-${folders.size + 1}`;
          folders.add(id);
          return new Response(JSON.stringify({ id, trashed: false }), { status: 200 });
        }
        const raw = Buffer.from(init.body as Uint8Array).toString('binary');
        const name = /"name":"([^"]+)"/.exec(raw)?.[1] ?? '';
        const parent = /"parents":\["([^"]+)"\]/.exec(raw)?.[1];
        uploaded.push({ filename: name, folderId: parent, bytes: raw });
        return new Response(
          JSON.stringify({ id: `file-${uploaded.length}`, webViewLink: 'https://drive/x' }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const deps: PromptRunnerDeps = {
      xai: {
        async generate(request) {
          xaiCalls.push(request);
          return [{ bytes: Buffer.from('REGENERATED') }];
        },
      },
      drive: client,
      spoolDir,
      driveFolder: createDriveFolderResolver({
        db: on.db,
        drive: client,
        configuredFolderId: null,
      }),
      concurrency: 1,
    };

    /**
     * `executeJob` DIRECTLY, and deliberately NOT `retryJob` first.
     *
     * `retryJob` ends with `scheduleJob`, which fires the same job on a
     * `setImmediate`. Calling it here and then awaiting `executeJob` runs the
     * job TWICE concurrently: one pass claims an output into `uploading` while
     * the other has already read it, and the assertion then sees a row mid-
     * flight. The rows are put in exactly the state `retryJob` produces —
     * `drive_upload_failed`, attempts 0 — so this exercises the same path
     * without racing itself. `retryJob`'s own semantics have their own tests.
     */
    await executeJob(on.db, deps, job!.id);

    const after = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.jobId, job!.id));

    expect(after.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(after.every((o) => o.driveFileId !== null)).toBe(true);
    expect(after.every((o) => o.driveWebViewLink !== null)).toBe(true);
    // The images that went up are the PAID ones, byte for byte.
    expect(uploaded).toHaveLength(2);
    expect(uploaded.every((u) => u.bytes.includes('PAID IMAGE'))).toBe(true);
    expect(uploaded.every((u) => u.folderId === 'folder-1')).toBe(true);
    // Exactly one folder, and the resolver is the thing that made it.
    expect(folders.size).toBe(1);
    // Nothing regenerated, nothing spent.
    expect(xaiCalls).toHaveLength(0);
    // And the token that reached Google is the CONNECTED one, decrypted.
    expect(sentRefreshToken).toBe('1//a-working-refresh-token');
    // Spool files are released only after a Drive id exists.
    expect(after.every((o) => o.spoolPath === null)).toBe(true);
  });

  it('an existing batch is not touched merely by connecting or disconnecting', async () => {
    const batch = await createBatch(on.db, {
      name: 'untouched',
      params: DEFAULT_PARAMS,
      driveFolderId: null,
    });
    await addPromptFiles(on.db, batch.id, [
      { filename: 'luna_001.txt', bytes: Buffer.from('p', 'utf8') },
    ]);
    const [job] = await on.db.select().from(promptJobs).where(eq(promptJobs.batchId, batch.id));
    const path = join(spoolDir, `untouched-${job!.id}.jpg`);
    await writeFile(path, Buffer.from('PAID'));
    await on.db
      .update(promptJobOutputs)
      .set({ status: 'drive_upload_failed', spoolPath: path })
      .where(eq(promptJobOutputs.jobId, job!.id));
    const before = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.jobId, job!.id));

    await storeConnection(on.db, {
      refreshToken: 't',
      googleAccountEmail: null,
      scope: DRIVE_SCOPE,
      connectedBy: null,
      encryptionKey: KEY,
    });
    await clearConnection(on.db);

    const after = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.jobId, job!.id));
    expect(after).toEqual(before);
    expect((await readFile(path)).toString()).toBe('PAID');
  });
});
