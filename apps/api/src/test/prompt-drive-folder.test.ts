import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { promptDriveFolders } from '../db/schema.js';
import {
  DEFAULT_FOLDER_NAME,
  DEFAULT_SLOT,
  createDriveFolderResolver,
  createNullDriveFolderResolver,
} from '../prompt-generation/drive-folder.js';
import {
  DriveError,
  createGoogleDriveClient,
  createMockGoogleDriveClient,
  type DriveFolder,
  type DriveUpload,
  type GoogleDriveClient,
} from '../prompt-generation/google-drive-client.js';
import { executeJob, retryJob, type PromptRunnerDeps } from '../prompt-generation/runner.js';
import { addPromptFiles, createBatch } from '../prompt-generation/batches.js';
import { DEFAULT_PARAMS } from '../prompt-generation/config.js';
import { promptJobOutputs, promptJobs } from '../db/schema.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * THE DESTINATION FOLDER, AND WHY IT IS CREATED RATHER THAN CONFIGURED.
 *
 * Production failed with a valid refresh token, a folder that existed, an id
 * that was correct, and a 404 on every upload. The cause was the OAuth scope:
 * `drive.file` reaches only files "that you open with an app or that the user
 * shares with an app while using the Google Picker API or the app's file
 * picker". A folder the operator made by hand is none of those, so Drive
 * reports it as `notFound` — the same answer it gives for a folder that never
 * existed, which is what made the failure so hard to read.
 *
 * The fix is not a wider scope. It is to create our own folder, which is
 * inside `drive.file` by construction, and remember its id forever.
 *
 * WHAT THIS SUITE PINS:
 *  1. The folder is created when first needed.
 *  2. A restart reuses it and does NOT create a second one.
 *  3. Images actually land in the created folder.
 *  4. Concurrent first-use creates exactly one folder.
 *  5. An already-recorded, still-present folder is left completely alone.
 *  6. An authentication failure never invents a folder to paper over itself.
 */

let on: TestContext;
let spoolDir: string;

beforeAll(async () => {
  migrateTestDb();
  spoolDir = mkdtempSync(join(tmpdir(), 'over18-folder-spool-'));
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));
beforeEach(async () => {
  await truncateAll(on);
});

/**
 * A Drive that enforces the `drive.file` rule instead of ignoring it.
 *
 * `getFolder` answers null for anything this client did not create, which is
 * exactly how Google behaves under that scope — and is what makes a
 * hand-made folder unusable. Without that rule a stub would happily "find"
 * folders the real API never would, and the suite would prove nothing.
 */
function scopedDrive(options: { failCreate?: Error; failGet?: Error } = {}) {
  const folders = new Map<string, DriveFolder>();
  const uploads: DriveUpload[] = [];
  let created = 0;
  let gets = 0;
  const client: GoogleDriveClient = {
    async createFolder(_name) {
      if (options.failCreate) throw options.failCreate;
      created += 1;
      const folder: DriveFolder = { id: `drive-folder-${created}`, trashed: false };
      folders.set(folder.id, folder);
      return folder;
    },
    async getFolder(folderId) {
      gets += 1;
      if (options.failGet) throw options.failGet;
      return folders.get(folderId) ?? null;
    },
    async upload(file) {
      const parent = file.folderId ?? null;
      // The real API refuses a parent it cannot see. So does this.
      if (!parent || !folders.has(parent)) {
        throw new DriveError('folder_not_found', 'Drive cannot see the destination folder.', 404);
      }
      uploads.push(file);
      return { fileId: `file-${uploads.length}`, webViewLink: null };
    },
  };
  return {
    client,
    uploads,
    folders,
    get createCalls() {
      return created;
    },
    get getCalls() {
      return gets;
    },
    /** Simulates the operator putting the folder in the bin. */
    trash(folderId: string) {
      const folder = folders.get(folderId);
      if (folder) folders.set(folderId, { ...folder, trashed: true });
    },
    /** Simulates a folder that exists in the account but not for THIS app. */
    forget(folderId: string) {
      folders.delete(folderId);
    },
  };
}

async function recordedRows() {
  return on.db.select().from(promptDriveFolders);
}

/* ------------------------------------------------------------------ *
 * 1. Folder creation
 * ------------------------------------------------------------------ */

describe('creating the destination folder', () => {
  it('creates a folder on first use and records it', async () => {
    const drive = scopedDrive();
    const resolver = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    });

    const view = await resolver.ensure();

    expect(view.source).toBe('app_created');
    expect(view.folderId).toBe('drive-folder-1');
    expect(view.folderName).toBe(DEFAULT_FOLDER_NAME);
    expect(drive.createCalls).toBe(1);

    const rows = await recordedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slot).toBe(DEFAULT_SLOT);
    expect(rows[0]!.driveFolderId).toBe('drive-folder-1');
    expect(rows[0]!.folderName).toBe(DEFAULT_FOLDER_NAME);
  });

  it('creates it with NO parent, which is what keeps drive.file sufficient', async () => {
    // Naming a parent would mean addressing a folder we did not create — the
    // one thing this scope forbids. The root needs no parent, so there is
    // nothing to address.
    const calls: { url: string; body: unknown }[] = [];
    const client = createGoogleDriveClient(
      {
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
        folderId: null,
        timeoutMs: 1000,
        tokenUrl: 'https://oauth.example/token',
        uploadUrl: 'https://upload.example/files',
        filesUrl: 'https://files.example/files',
      },
      (async (url: string, init: { body?: string }) => {
        if (url.startsWith('https://oauth.example')) {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
        return new Response(JSON.stringify({ id: 'new-folder', trashed: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    );

    const folder = await client.createFolder('Over18 Generated Images');

    expect(folder).toEqual({ id: 'new-folder', trashed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.startsWith('https://files.example/files')).toBe(true);
    expect(calls[0]!.body).toEqual({
      name: 'Over18 Generated Images',
      mimeType: 'application/vnd.google-apps.folder',
    });
    // The absence is the assertion: no parent, and nothing that would share it.
    expect(Object.keys(calls[0]!.body as object)).not.toContain('parents');
    expect(JSON.stringify(calls[0]!.body)).not.toContain('permission');
  });

  it('never makes a folder public — there is no permissions call anywhere', async () => {
    const urls: string[] = [];
    const client = createGoogleDriveClient(
      {
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
        folderId: null,
        timeoutMs: 1000,
        tokenUrl: 'https://oauth.example/token',
        uploadUrl: 'https://upload.example/files',
        filesUrl: 'https://files.example/files',
      },
      (async (url: string) => {
        urls.push(url);
        if (url.startsWith('https://oauth.example')) {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ id: 'new-folder' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    );

    await client.createFolder('Over18 Generated Images');
    await client.upload({
      filename: 'a_1.jpg',
      mimeType: 'image/jpeg',
      bytes: Buffer.from('x'),
      folderId: 'new-folder',
    });

    expect(urls.some((u) => u.includes('permissions'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Reuse after restart
 * ------------------------------------------------------------------ */

describe('reuse after a restart', () => {
  it('a fresh resolver reuses the recorded folder and creates nothing', async () => {
    const drive = scopedDrive();
    const first = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    });
    const created = await first.ensure();

    // A NEW resolver over the same database is what a redeploy looks like: the
    // process memory is gone, the row is not.
    const afterRestart = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    });
    const reused = await afterRestart.ensure();

    expect(reused.folderId).toBe(created.folderId);
    expect(reused.source).toBe('app_created');
    expect(drive.createCalls).toBe(1);
    expect(await recordedRows()).toHaveLength(1);
  });

  it('ten consecutive deployments still share one folder', async () => {
    const drive = scopedDrive();
    const ids: (string | null)[] = [];
    for (let i = 0; i < 10; i += 1) {
      const resolver = createDriveFolderResolver({
        db: on.db,
        drive: drive.client,
        configuredFolderId: null,
      });
      ids.push((await resolver.ensure()).folderId);
    }
    expect(new Set(ids).size).toBe(1);
    expect(drive.createCalls).toBe(1);
    expect(await recordedRows()).toHaveLength(1);
  });

  it('verifies at most once per process, not once per call', async () => {
    const drive = scopedDrive();
    await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();

    const resolver = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    });
    await resolver.ensure();
    await resolver.ensure();
    await resolver.ensure();

    // One lookup for this process. Verifying per upload would add a Google
    // round trip to every single image.
    expect(drive.getCalls).toBe(1);
    expect(drive.createCalls).toBe(1);
  });

  it('replaces the folder only when Drive says it is really gone', async () => {
    const drive = scopedDrive();
    const first = await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();

    drive.forget(first.folderId!);

    const next = await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();

    expect(next.folderId).not.toBe(first.folderId);
    expect(drive.createCalls).toBe(2);
    // Still ONE row: the record is repointed, never duplicated.
    const rows = await recordedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.driveFolderId).toBe(next.folderId);
  });

  it('replaces a folder the operator moved to the bin', async () => {
    const drive = scopedDrive();
    const first = await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();

    drive.trash(first.folderId!);

    const next = await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();

    expect(next.folderId).not.toBe(first.folderId);
    expect(await recordedRows()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Uploading into the app-created folder
 * ------------------------------------------------------------------ */

describe('uploading into the created folder', () => {
  it('a whole job generates and lands both images in the folder the app made', async () => {
    const drive = scopedDrive();
    const deps: PromptRunnerDeps = {
      xai: {
        async generate(request) {
          return Array.from({ length: request.n }, (_u, i) => ({
            bytes: Buffer.from(`image-${i + 1}`),
          }));
        },
      },
      drive: drive.client,
      spoolDir,
      driveFolder: createDriveFolderResolver({
        db: on.db,
        drive: drive.client,
        configuredFolderId: null,
      }),
      concurrency: 1,
    };

    const batch = await createBatch(on.db, {
      name: 'folder batch',
      params: DEFAULT_PARAMS,
      // No destination recorded: this is a batch created before any folder
      // existed, so the runner must resolve one.
      driveFolderId: null,
    });
    await addPromptFiles(on.db, batch.id, [
      { filename: 'luna_001.txt', bytes: Buffer.from('a prompt', 'utf8') },
    ]);
    const [job] = await on.db.select().from(promptJobs).where(eq(promptJobs.batchId, batch.id));

    await executeJob(on.db, deps, job!.id);

    expect(drive.createCalls).toBe(1);
    expect(drive.uploads).toHaveLength(2);
    expect(drive.uploads.map((u) => u.filename)).toEqual(['luna_001_1.jpg', 'luna_001_2.jpg']);
    expect(drive.uploads.every((u) => u.folderId === 'drive-folder-1')).toBe(true);
    expect(drive.folders.has('drive-folder-1')).toBe(true);
  });

  it('a hand-made folder is refused by the scope, which is the bug being fixed', async () => {
    const drive = scopedDrive();
    // The operator's own folder: real, owned by them, and invisible to this
    // app because the app did not create it.
    await expect(
      drive.client.upload({
        filename: 'luna_001_1.jpg',
        mimeType: 'image/jpeg',
        bytes: Buffer.from('x'),
        folderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
      }),
    ).rejects.toMatchObject({ kind: 'folder_not_found', status: 404 });
  });

  it('reports 404 on upload as folder_not_found, with Google’s own reason', async () => {
    const client = createGoogleDriveClient(
      {
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
        folderId: 'hand-made-folder',
        timeoutMs: 1000,
        tokenUrl: 'https://oauth.example/token',
        uploadUrl: 'https://upload.example/files',
      },
      (async (url: string) => {
        if (url.startsWith('https://oauth.example')) {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            error: {
              code: 404,
              message: 'File not found: hand-made-folder.',
              errors: [{ domain: 'global', reason: 'notFound' }],
            },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    );

    const error = await client
      .upload({ filename: 'a_1.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('x') })
      .catch((e: unknown) => e as DriveError);

    expect(error).toBeInstanceOf(DriveError);
    expect((error as DriveError).kind).toBe('folder_not_found');
    // The reason Google gave, which the first implementation discarded and
    // which cost two rounds of production diagnosis to recover.
    expect((error as DriveError).message).toContain('notFound');
    expect((error as DriveError).message).toContain('drive.file');
    // Not retryable: no amount of trying again makes an unowned folder visible.
    expect((error as DriveError).retryable).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 4. No duplicate creation
 * ------------------------------------------------------------------ */

describe('no duplicate folder creation', () => {
  it('twenty concurrent callers on one resolver create exactly one folder', async () => {
    const drive = scopedDrive();
    const resolver = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    });

    const views = await Promise.all(Array.from({ length: 20 }, () => resolver.ensure()));

    expect(new Set(views.map((v) => v.folderId)).size).toBe(1);
    expect(drive.createCalls).toBe(1);
    expect(await recordedRows()).toHaveLength(1);
  });

  it('two independent resolvers racing still agree on one folder', async () => {
    // Two API processes booting together. The in-flight promise cannot help
    // here; the unique slot index is what does.
    const drive = scopedDrive();
    const a = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    });
    const b = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    });

    const [first, second] = await Promise.all([a.ensure(), b.ensure()]);

    expect(first.folderId).toBe(second.folderId);
    const rows = await recordedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.driveFolderId).toBe(first.folderId);
  });

  it('the slot is unique at the database level, not just in code', async () => {
    await on.db
      .insert(promptDriveFolders)
      .values({ slot: DEFAULT_SLOT, driveFolderId: 'a', folderName: 'n' });
    await expect(
      on.db
        .insert(promptDriveFolders)
        .values({ slot: DEFAULT_SLOT, driveFolderId: 'b', folderName: 'n' }),
    ).rejects.toThrow();
  });

  it('peek never creates anything, however often it is polled', async () => {
    const drive = scopedDrive();
    const resolver = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    });

    for (let i = 0; i < 25; i += 1) {
      const view = await resolver.peek();
      expect(view.folderId).toBeNull();
      expect(view.source).toBe('none');
    }
    expect(drive.createCalls).toBe(0);
    expect(await recordedRows()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Unchanged when the folder is already app-owned
 * ------------------------------------------------------------------ */

describe('an existing app-owned folder is left alone', () => {
  it('the recorded row is not rewritten, only its verification stamp', async () => {
    const drive = scopedDrive();
    const created = await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();
    const before = (await recordedRows())[0]!;

    await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();

    const after = (await recordedRows())[0]!;
    expect(after.id).toBe(before.id);
    expect(after.driveFolderId).toBe(created.folderId);
    expect(after.folderName).toBe(before.folderName);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(drive.createCalls).toBe(1);
  });

  it('peek reports the recorded folder without touching Drive at all', async () => {
    const drive = scopedDrive();
    await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();
    const getsAfterCreate = drive.getCalls;

    const view = await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).peek();

    expect(view).toEqual({
      folderId: 'drive-folder-1',
      source: 'app_created',
      folderName: DEFAULT_FOLDER_NAME,
    });
    expect(drive.getCalls).toBe(getsAfterCreate);
    expect(drive.createCalls).toBe(1);
  });

  it('an explicit override wins and suppresses creation entirely', async () => {
    const drive = scopedDrive();
    const resolver = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: '  legacy-folder-id  ',
    });

    const ensured = await resolver.ensure();
    const peeked = await resolver.peek();

    // Trimmed: an id pasted out of a browser can carry a trailing newline, and
    // an untrimmed one produces a 404 indistinguishable from a missing folder.
    expect(ensured).toEqual({
      folderId: 'legacy-folder-id',
      source: 'configured',
      folderName: null,
    });
    expect(peeked.source).toBe('configured');
    expect(drive.createCalls).toBe(0);
    expect(await recordedRows()).toHaveLength(0);
  });

  it('a blank override is treated as unset rather than as a destination', async () => {
    const drive = scopedDrive();
    const view = await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: '   ',
    }).ensure();
    expect(view.source).toBe('app_created');
    expect(drive.createCalls).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Drive authentication failures
 * ------------------------------------------------------------------ */

describe('authentication failures', () => {
  it('a refused refresh token surfaces as auth and creates no folder', async () => {
    const drive = scopedDrive({
      failCreate: new DriveError('auth', 'Google refused the refresh token (HTTP 400).', 400),
    });
    const resolver = createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    });

    await expect(resolver.ensure()).rejects.toMatchObject({ kind: 'auth' });
    // Nothing half-written: a failed creation must not leave a row pointing at
    // a folder that does not exist.
    expect(await recordedRows()).toHaveLength(0);
  });

  it('an auth failure during verification does NOT mint a replacement folder', async () => {
    const drive = scopedDrive();
    const created = await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();

    const broken = scopedDrive({
      failGet: new DriveError('auth', 'Drive rejected our access token.', 401),
    });
    // Point the broken client at the same recorded row.
    const resolver = createDriveFolderResolver({
      db: on.db,
      drive: broken.client,
      configuredFolderId: null,
    });

    await expect(resolver.ensure()).rejects.toMatchObject({ kind: 'auth' });
    // An expired token is not evidence the folder is gone. Creating one here
    // would scatter images across a new folder per outage.
    expect(broken.createCalls).toBe(0);
    const rows = await recordedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.driveFolderId).toBe(created.folderId);
  });

  it('a transient lookup failure keeps using the recorded folder', async () => {
    const drive = scopedDrive();
    const created = await createDriveFolderResolver({
      db: on.db,
      drive: drive.client,
      configuredFolderId: null,
    }).ensure();

    const flaky = scopedDrive({
      failGet: new DriveError('network', 'The Drive folder lookup request could not be sent.'),
    });
    const view = await createDriveFolderResolver({
      db: on.db,
      drive: flaky.client,
      configuredFolderId: null,
    }).ensure();

    expect(view.folderId).toBe(created.folderId);
    expect(flaky.createCalls).toBe(0);
  });

  it('a 401 on folder creation drops the cached token so the next try re-exchanges', async () => {
    let tokenCalls = 0;
    let createCalls = 0;
    const client = createGoogleDriveClient(
      {
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
        folderId: null,
        timeoutMs: 1000,
        tokenUrl: 'https://oauth.example/token',
        uploadUrl: 'https://upload.example/files',
        filesUrl: 'https://files.example/files',
      },
      (async (url: string) => {
        if (url.startsWith('https://oauth.example')) {
          tokenCalls += 1;
          return new Response(JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        createCalls += 1;
        if (createCalls === 1) return new Response('{}', { status: 401 });
        return new Response(JSON.stringify({ id: 'folder-after-retry' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    );

    await expect(client.createFolder('x')).rejects.toMatchObject({ kind: 'auth', status: 401 });
    const folder = await client.createFolder('x');

    expect(folder.id).toBe('folder-after-retry');
    expect(tokenCalls).toBe(2);
  });

  it('the token error stays body-free even now that Drive errors are read', async () => {
    const client = createGoogleDriveClient(
      {
        clientId: 'client-id-that-must-not-leak',
        clientSecret: 'secret-that-must-not-leak',
        refreshToken: 'refresh-that-must-not-leak',
        folderId: null,
        timeoutMs: 1000,
        tokenUrl: 'https://oauth.example/token',
        uploadUrl: 'https://upload.example/files',
        filesUrl: 'https://files.example/files',
      },
      (async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
            client_id: 'client-id-that-must-not-leak',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    );

    const error = (await client.createFolder('x').catch((e: unknown) => e)) as DriveError;

    expect(error.kind).toBe('auth');
    // A TOKEN body echoes the client id and sometimes the refresh token, so it
    // is still never read. A DRIVE body describes a file and is safe. The two
    // are deliberately not treated the same way.
    expect(error.message).not.toContain('must-not-leak');
    expect(error.message).not.toContain('invalid_grant');
  });

  it('an unconfigured Drive refuses folder work instead of pretending', async () => {
    const resolver = createNullDriveFolderResolver(null);
    expect(await resolver.ensure()).toEqual({
      folderId: null,
      source: 'none',
      folderName: null,
    });
    expect(await recordedRows()).toHaveLength(0);
  });

  it('the offline mock still models ownership, so the same path is exercised', async () => {
    const mock = createMockGoogleDriveClient();
    const resolver = createDriveFolderResolver({
      db: on.db,
      drive: mock,
      configuredFolderId: null,
    });

    const first = await resolver.ensure();
    const second = await createDriveFolderResolver({
      db: on.db,
      drive: mock,
      configuredFolderId: null,
    }).ensure();

    expect(first.folderId).toBe(second.folderId);
    expect(mock.folders.size).toBe(1);
    // And it refuses to "find" a folder it never made, exactly as Drive does.
    expect(await mock.getFolder('a-folder-someone-made-by-hand')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 7. The reason a destination could not be resolved is REPORTED
 * ------------------------------------------------------------------ */

/**
 * WHAT THESE PIN, AND WHY THEY EXIST.
 *
 * The first cut of the resolver was wired into `executeJob` behind a bare
 * `catch`. A refusal from Google therefore reached the operator as the fixed
 * sentence "No Google Drive destination folder is configured" — the very same
 * string this feature used before a resolver existed. In production that sent
 * the diagnosis after a missing setting which was in fact already correct,
 * and cost a deploy cycle. These tests make the two situations distinguishable
 * and keep them that way.
 */
describe('why a destination could not be resolved', () => {
  /** Rebuilds a batch whose destination is null and whose images are spooled. */
  async function spooledJobWithNoDestination() {
    const batch = await createBatch(on.db, {
      name: 'no destination',
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
      const path = join(spoolDir, `resolved-${job!.id}-${output.ordinal}.jpg`);
      await writeFile(path, Buffer.from(`PAID IMAGE ${output.ordinal}`));
      await on.db
        .update(promptJobOutputs)
        .set({ status: 'drive_upload_failed', spoolPath: path, generatedAt: new Date() })
        .where(eq(promptJobOutputs.id, output.id));
    }
    return job!.id;
  }

  /** A Drive that cannot make a folder, and must never be asked to upload. */
  function refusingDrive(error: Error): GoogleDriveClient {
    return {
      async createFolder() {
        throw error;
      },
      async getFolder() {
        return null;
      },
      async upload() {
        throw new Error('upload must not be reached without a folder');
      },
    };
  }

  function depsWith(drive: GoogleDriveClient, xaiCalls: unknown[]): PromptRunnerDeps {
    return {
      xai: {
        async generate(request) {
          xaiCalls.push(request);
          return [{ bytes: Buffer.from('REGENERATED') }];
        },
      },
      drive,
      spoolDir,
      driveFolder: createDriveFolderResolver({ db: on.db, drive, configuredFolderId: null }),
      concurrency: 1,
    };
  }

  it('records the REAL reason when Google refuses to create the folder', async () => {
    const jobId = await spooledJobWithNoDestination();
    const xaiCalls: unknown[] = [];
    await executeJob(
      on.db,
      depsWith(
        refusingDrive(
          new DriveError('auth', 'Google refused the refresh token (HTTP 400).', 400),
        ),
        xaiCalls,
      ),
      jobId,
    );

    const outputs = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.jobId, jobId));
    for (const output of outputs) {
      const error = output.error as { kind: string; message: string };
      expect(error.kind).toBe('drive_auth');
      expect(error.message).toContain('refused the refresh token');
      // The sentence that sent production looking for a setting that was
      // already correct must NOT be what an operator sees here.
      expect(error.message).not.toBe('No Google Drive destination folder is configured.');
    }
    expect(xaiCalls).toHaveLength(0);
  });

  it('distinguishes a folder Drive refused from Drive not being set up at all', async () => {
    const jobId = await spooledJobWithNoDestination();
    const xaiCalls: unknown[] = [];
    // No credentials at all: the resolver resolves to nothing WITHOUT throwing,
    // which is the genuine "not configured" case and keeps its own wording.
    await executeJob(
      on.db,
      {
        ...depsWith(createMockGoogleDriveClient(), xaiCalls),
        driveFolder: createNullDriveFolderResolver(null),
      },
      jobId,
    );

    const [output] = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.jobId, jobId));
    const error = output!.error as { kind: string; message: string };
    expect(error.kind).toBe('drive_not_configured');
    expect(error.message).toBe('No Google Drive destination folder is configured.');
    expect(xaiCalls).toHaveLength(0);
  });

  it('carries no credential into the recorded reason, whatever Google said', async () => {
    const jobId = await spooledJobWithNoDestination();
    const xaiCalls: unknown[] = [];
    await executeJob(
      on.db,
      depsWith(
        refusingDrive(
          // The shape the real client produces for a refused token: body-free
          // by construction, because a token body echoes the credentials.
          new DriveError(
            'auth',
            'Google refused the refresh token (HTTP 400). Re-authorise the Drive connection.',
            400,
          ),
        ),
        xaiCalls,
      ),
      jobId,
    );

    const outputs = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.jobId, jobId));
    const serialised = JSON.stringify(outputs.map((o) => o.error));
    for (const secret of [
      'refresh_token',
      'client_secret',
      'client_id',
      'invalid_grant',
      'Bearer',
      'access_token',
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('leaves the paid images spooled and regenerates nothing, however often it is retried', async () => {
    const jobId = await spooledJobWithNoDestination();
    const xaiCalls: unknown[] = [];
    const deps = depsWith(refusingDrive(new DriveError('auth', 'refused', 400)), xaiCalls);

    for (let i = 0; i < 4; i += 1) {
      await retryJob(on.db, deps, jobId);
      await executeJob(on.db, deps, jobId);
    }

    const outputs = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.jobId, jobId));
    expect(outputs.every((o) => o.status === 'drive_upload_failed')).toBe(true);
    expect(outputs.every((o) => o.spoolPath !== null)).toBe(true);
    for (const output of outputs) {
      // The bytes are untouched — still the image that was paid for.
      expect((await readFile(output.spoolPath!)).toString('utf8')).toContain('PAID IMAGE');
    }
    expect(xaiCalls).toHaveLength(0);
  });

  it('once the refusal is resolved the same batch recovers with no new generation', async () => {
    const jobId = await spooledJobWithNoDestination();
    const xaiCalls: unknown[] = [];
    await executeJob(
      on.db,
      depsWith(refusingDrive(new DriveError('auth', 'refused', 400)), xaiCalls),
      jobId,
    );

    // Google starts working again. Nothing else changes.
    const healthy = scopedDrive();
    const deps = depsWith(healthy.client, xaiCalls);
    await retryJob(on.db, deps, jobId);
    await executeJob(on.db, deps, jobId);

    const outputs = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.jobId, jobId));
    expect(outputs.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(outputs.every((o) => o.driveFileId !== null)).toBe(true);
    expect(healthy.createCalls).toBe(1);
    expect(healthy.uploads.every((u) => u.folderId === 'drive-folder-1')).toBe(true);
    expect(xaiCalls).toHaveLength(0);
  });
});
