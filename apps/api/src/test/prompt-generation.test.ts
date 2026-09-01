import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { promptBatches, promptJobOutputs, promptJobs } from '../db/schema.js';
import {
  estimateCost,
  outputFilename,
  promptStem,
  readPromptFile,
  DEFAULT_PARAMS,
  PRICE_USD_PER_IMAGE,
} from '../prompt-generation/config.js';
import {
  RateLimiter,
  backoffDelayMs,
  parseRetryAfter,
} from '../prompt-generation/rate-limiter.js';
import {
  createXaiImageProvider,
  xaiErrorReason,
  XaiError,
  type GenerateRequest,
  type XaiImageProvider,
} from '../prompt-generation/xai-image-provider.js';
import {
  createGoogleDriveClient,
  createMockGoogleDriveClient,
  DriveError,
  type DriveUpload,
  type GoogleDriveClient,
} from '../prompt-generation/google-drive-client.js';
import { createNullDriveFolderResolver } from '../prompt-generation/drive-folder.js';
import {
  executeJob,
  recoverInterruptedPromptJobs,
  retryFailedInBatch,
  retryOutput,
  runBatch,
  MAX_OUTPUT_GENERATION_ATTEMPTS,
  MAX_OUTPUT_UPLOAD_ATTEMPTS,
  type PromptRunnerDeps,
} from '../prompt-generation/runner.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * Admin -> Generation: prompt files -> xAI -> Google Drive.
 *
 * The rules these exist to hold:
 *
 *  1. THE PROMPT IS NEVER MODIFIED. What the operator uploads is what the
 *     provider receives, byte for byte.
 *  2. ONE FILE IS ONE JOB IS EXACTLY TWO IMAGES, each independently tracked.
 *  3. ONE OUTPUT'S FAILURE NEVER TOUCHES ITS SIBLING.
 *  4. A PAID IMAGE IS NEVER THROWN AWAY. A Drive failure is retried as an
 *     upload, never as a regeneration.
 *  5. NOTHING IS EVER GENERATED TWICE. Not by a refresh, not by a restart, not
 *     by a retry of a sibling.
 *  6. NO CREDENTIAL AND NO SERVER PATH REACHES THE BROWSER.
 *  7. NOTHING REACHES THE OVER18 CONTENT SYSTEM.
 */

let on: TestContext;
let adminCookies: Record<string, string>;
let userCookies: Record<string, string>;
let spoolDir: string;
let driveUploads: DriveUpload[];
let seq = 0;

/** A provider whose behaviour each test sets. Never a network call. */
interface StubProvider extends XaiImageProvider {
  calls: GenerateRequest[];
  behaviour: (request: GenerateRequest, callIndex: number) => Promise<{ bytes: Buffer }[]>;
}

function stubXai(): StubProvider {
  const stub: StubProvider = {
    calls: [],
    behaviour: async (request) =>
      Array.from({ length: request.n }, (_u, i) => ({ bytes: Buffer.from(`image-${i + 1}`) })),
    async generate(request) {
      const index = stub.calls.length;
      stub.calls.push(request);
      return stub.behaviour(request, index);
    },
  };
  return stub;
}

interface StubDrive extends GoogleDriveClient {
  uploads: DriveUpload[];
  createdFolders: string[];
  failNext: (times: number, error?: Error) => void;
}

function stubDrive(): StubDrive {
  const uploads: DriveUpload[] = [];
  const createdFolders: string[] = [];
  let failures = 0;
  let failure: Error = new DriveError('http', 'Drive is unhappy.', 500);
  const client: StubDrive = {
    uploads,
    createdFolders,
    failNext(times, error) {
      failures = times;
      if (error) failure = error;
    },
    async createFolder(name) {
      createdFolders.push(name);
      return { id: `stub-folder-${createdFolders.length}`, trashed: false };
    },
    async getFolder(folderId) {
      return { id: folderId, trashed: false };
    },
    async upload(file) {
      if (failures > 0) {
        failures -= 1;
        throw failure;
      }
      uploads.push(file);
      const id = `drive-${uploads.length}`;
      return { fileId: id, webViewLink: `https://drive.example/${id}` };
    },
  };
  return client;
}

let xai: StubProvider;
let drive: StubDrive;
let deps: PromptRunnerDeps;

beforeAll(async () => {
  migrateTestDb();
  spoolDir = mkdtempSync(join(tmpdir(), 'over18-spool-'));
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));

beforeEach(async () => {
  await truncateAll(on);
  adminCookies = await register('prompt.admin@example.com', 'admin');
  userCookies = await register('prompt.user@example.com', 'user');
  xai = stubXai();
  drive = stubDrive();
  driveUploads = drive.uploads;
  deps = {
    xai,
    drive,
    spoolDir,
    // A fixed destination, so this suite keeps testing the runner rather than
    // the resolver. Resolution has its own suite.
    driveFolder: createNullDriveFolderResolver('folder-1'),
    concurrency: 2,
  };
});

async function register(email: string, role: 'admin' | 'user') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'prompt-generation-1' },
  });
  const cookie = extractSessionCookie(res)!;
  if (role === 'admin') {
    await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  }
  return { [cookie.name]: cookie.value };
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

async function makeBatch(cookies = adminCookies) {
  const res = await on.app.inject({
    method: 'POST',
    url: '/admin/prompt-generation/batches',
    payload: { name: `Batch ${++seq}` },
    cookies,
  });
  return res;
}

function multipart(files: Array<{ filename: string; body: string | Buffer }>): {
  headers: Record<string, string>;
  payload: Buffer;
} {
  const boundary = '----prompttest';
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8'),
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
}

async function uploadFiles(
  batchId: string,
  files: Array<{ filename: string; body: string | Buffer }>,
  cookies = adminCookies,
) {
  const { headers, payload } = multipart(files);
  return on.app.inject({
    method: 'POST',
    url: `/admin/prompt-generation/batches/${batchId}/files`,
    headers,
    payload,
    cookies,
  });
}

const getBatch = (batchId: string, cookies = adminCookies) =>
  on.app.inject({ method: 'GET', url: `/admin/prompt-generation/batches/${batchId}`, cookies });

/** Runs every queued job to completion, synchronously, for deterministic tests. */
async function drain(batchId: string) {
  const jobs = await on.db
    .select()
    .from(promptJobs)
    .where(eq(promptJobs.batchId, batchId));
  for (const job of jobs) {
    await executeJob(on.db, deps, job.id);
  }
}

/* ------------------------------------------------------------------ *
 * Pure ingestion rules
 * ------------------------------------------------------------------ */

describe('.txt ingestion', () => {
  it('accepts a .txt file and keeps the prompt EXACTLY as written', () => {
    // Leading newline, trailing spaces, inner double spaces, unicode, CRLF —
    // every one of these is a thing a real prompt file contains and a helpful
    // "clean-up" would destroy.
    const raw = '\n  A  woman   in a red dress\r\nunder neon — 35mm  \n\n';
    const result = readPromptFile({ filename: 'luna_001.txt', bytes: Buffer.from(raw, 'utf8') });
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.promptText).toBe(raw);
  });

  it('strips only a byte-order mark, because that is a file artefact', () => {
    const result = readPromptFile({
      filename: 'a.txt',
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]),
    });
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.promptText).toBe('hello');
  });

  it('refuses a non-.txt file', () => {
    const result = readPromptFile({ filename: 'luna.png', bytes: Buffer.from('x') });
    expect(result).toMatchObject({ accepted: false, reason: 'not_txt' });
  });

  it('refuses a whitespace-only file', () => {
    const result = readPromptFile({ filename: 'blank.txt', bytes: Buffer.from('   \n\t ') });
    expect(result).toMatchObject({ accepted: false, reason: 'empty' });
  });

  it('refuses a file far larger than a prompt', () => {
    const result = readPromptFile({
      filename: 'huge.txt',
      bytes: Buffer.alloc(512 * 1024, 0x61),
    });
    expect(result).toMatchObject({ accepted: false, reason: 'too_large' });
  });
});

describe('filenames', () => {
  it('turns luna_001.txt into luna_001_1.jpg and luna_001_2.jpg', () => {
    expect(outputFilename('luna_001.txt', 1)).toBe('luna_001_1.jpg');
    expect(outputFilename('luna_001.txt', 2)).toBe('luna_001_2.jpg');
  });

  it('extends past two without a change to the rule', () => {
    // The extensibility requirement, asserted rather than asserted-in-a-comment.
    expect(outputFilename('luna_001.txt', 3)).toBe('luna_001_3.jpg');
    expect(outputFilename('luna_001.txt', 10)).toBe('luna_001_10.jpg');
  });

  it('only strips a trailing .txt, leaving the operator’s dots alone', () => {
    expect(promptStem('set.2.final.txt')).toBe('set.2.final');
    expect(promptStem('UPPER.TXT')).toBe('UPPER');
    expect(promptStem('no-extension')).toBe('no-extension');
  });
});

describe('cost estimate', () => {
  it('is prompts × outputs × price', () => {
    const estimate = estimateCost(10, 2, DEFAULT_PARAMS);
    expect(estimate.images).toBe(20);
    expect(estimate.pricePerImageUsd).toBe(PRICE_USD_PER_IMAGE['2k'].medium);
    expect(estimate.totalUsd).toBe(Math.round(20 * 0.08 * 100) / 100);
  });

  it('prices every documented resolution/quality pair distinctly', () => {
    const at = (resolution: '1k' | '2k', quality: 'low' | 'medium') =>
      estimateCost(1, 1, { resolution, quality }).totalUsd;
    expect(at('1k', 'low')).toBe(0.04);
    expect(at('1k', 'medium')).toBe(0.06);
    expect(at('2k', 'low')).toBe(0.06);
    expect(at('2k', 'medium')).toBe(0.08);
  });

  it('is zero for an empty batch, never NaN', () => {
    expect(estimateCost(0, 2, DEFAULT_PARAMS).totalUsd).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Rate limiting and 429s
 * ------------------------------------------------------------------ */

describe('rate limiting', () => {
  it('paces requests once the bucket is empty', async () => {
    let clock = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter({
      requestsPerSecond: 2,
      maxConcurrent: 10,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    // The bucket starts full (2), so the first two run immediately and the
    // third has to wait — a ceiling on sustained rate, not a fixed delay.
    await limiter.run(async () => 1);
    await limiter.run(async () => 2);
    expect(slept).toHaveLength(0);
    await limiter.run(async () => 3);
    expect(slept.length).toBeGreaterThan(0);
  });

  it('never exceeds its concurrency limit', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 1000, maxConcurrent: 2 });
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('releases its slot even when the task throws', async () => {
    // The failure that would otherwise wedge a whole batch after one bad prompt.
    const limiter = new RateLimiter({ requestsPerSecond: 1000, maxConcurrent: 1 });
    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(limiter.run(async () => 'fine')).resolves.toBe('fine');
  });

  it('obeys Retry-After over its own backoff', () => {
    expect(backoffDelayMs(0, 7)).toBe(7000);
    expect(backoffDelayMs(5, 2)).toBe(2000);
    // And caps an absurd value rather than sleeping for an hour.
    expect(backoffDelayMs(0, 9999)).toBe(60_000);
  });

  it('uses full jitter when the provider says nothing', () => {
    // Jitter matters: without it a batch that hits one 429 retries in lockstep.
    expect(backoffDelayMs(0, null, () => 0)).toBe(0);
    expect(backoffDelayMs(0, null, () => 0.999)).toBeLessThanOrEqual(1000);
    expect(backoffDelayMs(3, null, () => 0.999)).toBeLessThanOrEqual(8000);
  });

  it('parses Retry-After in both documented forms', () => {
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('not-a-date')).toBeNull();
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(future)!).toBeGreaterThan(0);
  });
});

describe('xAI response handling', () => {
  const limiter = () => new RateLimiter({ requestsPerSecond: 1000, maxConcurrent: 4 });
  const config = {
    baseUrl: 'https://xai.example/v1',
    apiKey: 'secret-key',
    model: 'grok-imagine-image-2.0',
    timeoutMs: 1000,
    maxAttempts: 3,
  };

  it('sends the documented request shape and decodes base64', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const provider = createXaiImageProvider(
      config,
      limiter(),
      (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from('one').toString('base64') }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    );
    const images = await provider.generate({
      prompt: 'exact  prompt\n',
      n: 2,
      params: DEFAULT_PARAMS,
    });
    expect(images).toHaveLength(1);
    expect(images[0]!.bytes.toString()).toBe('one');
    expect(seen!.url).toBe('https://xai.example/v1/images/generations');
    const body = JSON.parse(String(seen!.init.body));
    // The prompt is passed through untouched.
    expect(body.prompt).toBe('exact  prompt\n');
    expect(body).toMatchObject({
      model: 'grok-imagine-image-2.0',
      n: 2,
      aspect_ratio: '2:3',
      resolution: '2k',
      quality: 'medium',
      response_format: 'b64_json',
    });
  });

  it('retries a 429, honouring Retry-After, then succeeds', async () => {
    let call = 0;
    const provider = createXaiImageProvider(
      config,
      limiter(),
      (async () => {
        call += 1;
        if (call === 1) {
          return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
        }
        return new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from('ok').toString('base64') }] }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
      async () => {},
    );
    const images = await provider.generate({ prompt: 'p', n: 1, params: DEFAULT_PARAMS });
    expect(call).toBe(2);
    expect(images).toHaveLength(1);
  });

  it('gives up on a 429 once attempts are spent, and says so', async () => {
    const provider = createXaiImageProvider(
      { ...config, maxAttempts: 2 },
      limiter(),
      (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch,
      async () => {},
    );
    await expect(
      provider.generate({ prompt: 'p', n: 1, params: DEFAULT_PARAMS }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('does NOT retry an auth failure — the key will not fix itself', async () => {
    let calls = 0;
    const provider = createXaiImageProvider(
      config,
      limiter(),
      (async () => {
        calls += 1;
        return new Response('{}', { status: 401 });
      }) as unknown as typeof fetch,
      async () => {},
    );
    await expect(
      provider.generate({ prompt: 'p', n: 1, params: DEFAULT_PARAMS }),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toBe(1);
  });

  it('treats malformed JSON and a missing data array as malformed, not as zero images', async () => {
    const bad = createXaiImageProvider(
      { ...config, maxAttempts: 1 },
      limiter(),
      (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
    );
    await expect(bad.generate({ prompt: 'p', n: 1, params: DEFAULT_PARAMS })).rejects.toMatchObject(
      { kind: 'malformed_response' },
    );

    const noList = createXaiImageProvider(
      { ...config, maxAttempts: 1 },
      limiter(),
      (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
    );
    await expect(
      noList.generate({ prompt: 'p', n: 1, params: DEFAULT_PARAMS }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('drops an entry that decodes to nothing rather than spooling a broken file', async () => {
    const provider = createXaiImageProvider(
      config,
      limiter(),
      (async () =>
        new Response(JSON.stringify({ data: [{ b64_json: '' }, { url: 'https://x' }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    await expect(
      provider.generate({ prompt: 'p', n: 2, params: DEFAULT_PARAMS }),
    ).resolves.toEqual([]);
  });

  it('never puts the API key or a provider body into an error', async () => {
    const provider = createXaiImageProvider(
      { ...config, maxAttempts: 1 },
      limiter(),
      (async () =>
        new Response('{"error":"the key secret-key is bad and the prompt was X"}', {
          status: 400,
        })) as unknown as typeof fetch,
    );
    const error = (await provider
      .generate({ prompt: 'p', n: 1, params: DEFAULT_PARAMS })
      .catch((e) => e)) as XaiError;
    expect(error.message).not.toContain('secret-key');
    expect(error.message).not.toContain('prompt was X');
  });
});

/* ------------------------------------------------------------------ *
 * Google Drive
 * ------------------------------------------------------------------ */

describe('Google Drive client', () => {
  const config = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: async () => 'refresh-token',
    folderId: 'folder-1',
    timeoutMs: 1000,
    tokenUrl: 'https://oauth.example/token',
    uploadUrl: 'https://upload.example/files',
  };

  it('exchanges the refresh token once and reuses the access token', async () => {
    let tokenCalls = 0;
    let uploadCalls = 0;
    const client = createGoogleDriveClient(config, (async (url: string) => {
      if (url.startsWith('https://oauth.example')) {
        tokenCalls += 1;
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
          status: 200,
        });
      }
      uploadCalls += 1;
      return new Response(JSON.stringify({ id: 'f1', webViewLink: 'https://drive/f1' }), {
        status: 200,
      });
    }) as unknown as typeof fetch);

    await client.upload({ filename: 'a_1.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('x') });
    await client.upload({ filename: 'a_2.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('y') });
    // 200 images must not mean 200 token exchanges.
    expect(tokenCalls).toBe(1);
    expect(uploadCalls).toBe(2);
  });

  it('sends multipart metadata naming the file and its parent folder', async () => {
    let body = '';
    let uploadUrl = '';
    const client = createGoogleDriveClient(config, (async (url: string, init: RequestInit) => {
      if (url.startsWith('https://oauth.example')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
          status: 200,
        });
      }
      uploadUrl = url;
      body = Buffer.from(init.body as Uint8Array).toString('utf8');
      return new Response(JSON.stringify({ id: 'f1', webViewLink: 'https://drive/f1' }), {
        status: 200,
      });
    }) as unknown as typeof fetch);

    const result = await client.upload({
      filename: 'luna_001_1.jpg',
      mimeType: 'image/jpeg',
      bytes: Buffer.from('bytes'),
      folderId: 'target-folder',
    });
    expect(uploadUrl).toContain('uploadType=multipart');
    expect(body).toContain('"name":"luna_001_1.jpg"');
    expect(body).toContain('"parents":["target-folder"]');
    expect(result).toEqual({ fileId: 'f1', webViewLink: 'https://drive/f1' });
  });

  it('NEVER asks Drive to make anything public', async () => {
    const seen: string[] = [];
    const client = createGoogleDriveClient(config, (async (url: string) => {
      seen.push(url);
      if (url.startsWith('https://oauth.example')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ id: 'f1' }), { status: 200 });
    }) as unknown as typeof fetch);
    await client.upload({ filename: 'a.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('x') });
    // Privacy here is the ABSENCE of a permissions call, so absence is asserted.
    expect(seen.some((u) => u.includes('permissions'))).toBe(false);
  });

  it('tells a full Drive apart from a rate limit, because only one is worth retrying', async () => {
    const make = (detail: string) =>
      createGoogleDriveClient(config, (async (url: string) => {
        if (url.startsWith('https://oauth.example')) {
          return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response(detail, { status: 403 });
      }) as unknown as typeof fetch);

    const quota = (await make('{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}')
      .upload({ filename: 'a.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('x') })
      .catch((e) => e)) as DriveError;
    expect(quota.kind).toBe('quota');
    expect(quota.retryable).toBe(false);

    const limited = (await make('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}')
      .upload({ filename: 'a.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('x') })
      .catch((e) => e)) as DriveError;
    expect(limited.kind).toBe('rate_limited');
    expect(limited.retryable).toBe(true);
  });

  it('refuses to call a missing file id a success', async () => {
    const client = createGoogleDriveClient(config, (async (url: string) => {
      if (url.startsWith('https://oauth.example')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ webViewLink: 'https://drive/?' }), { status: 200 });
    }) as unknown as typeof fetch);
    await expect(
      client.upload({ filename: 'a.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('x') }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('never leaks the client secret or refresh token in an auth error', async () => {
    const client = createGoogleDriveClient(config, (async () =>
      new Response('{"error":"invalid_grant refresh-token client-secret"}', {
        status: 400,
      })) as unknown as typeof fetch);
    const error = (await client
      .upload({ filename: 'a.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('x') })
      .catch((e) => e)) as DriveError;
    expect(error.message).not.toContain('refresh-token');
    expect(error.message).not.toContain('client-secret');
  });
});

/* ------------------------------------------------------------------ *
 * The job state machine
 * ------------------------------------------------------------------ */

describe('two outputs per prompt', () => {
  async function batchWith(files: Array<{ filename: string; body: string }>) {
    const created = await makeBatch();
    const batchId = created.json().batch.id as string;
    await uploadFiles(batchId, files);
    return batchId;
  }

  it('creates exactly two output rows, ordinals 1 and 2, before anything runs', async () => {
    const batchId = await batchWith([{ filename: 'luna_001.txt', body: 'a prompt' }]);
    const batch = (await getBatch(batchId)).json().batch;
    expect(batch.jobs).toHaveLength(1);
    const job = batch.jobs[0];
    expect(job.requestedOutputs).toBe(2);
    expect(job.outputs.map((o: { ordinal: number }) => o.ordinal)).toEqual([1, 2]);
    expect(job.outputs.map((o: { outputFilename: string }) => o.outputFilename)).toEqual([
      'luna_001_1.jpg',
      'luna_001_2.jpg',
    ]);
    expect(job.outputs.every((o: { status: string }) => o.status === 'pending')).toBe(true);
  });

  it('asks the provider for both images in ONE request', async () => {
    const batchId = await batchWith([{ filename: 'luna_001.txt', body: 'a prompt' }]);
    await drain(batchId);
    expect(xai.calls).toHaveLength(1);
    expect(xai.calls[0]!.n).toBe(2);
  });

  it('sends the stored prompt verbatim to the provider', async () => {
    const raw = '  spaced   prompt\nline two  ';
    const batchId = await batchWith([{ filename: 'p.txt', body: raw }]);
    await drain(batchId);
    expect(xai.calls[0]!.prompt).toBe(raw);
  });

  it('uploads both images independently and records both Drive ids', async () => {
    const batchId = await batchWith([{ filename: 'luna_001.txt', body: 'a prompt' }]);
    await drain(batchId);
    const job = (await getBatch(batchId)).json().batch.jobs[0];
    expect(job.status).toBe('completed');
    expect(job.succeededCount).toBe(2);
    expect(job.outputs.map((o: { driveFileId: string }) => o.driveFileId)).toEqual([
      'drive-1',
      'drive-2',
    ]);
    expect(driveUploads.map((u) => u.filename)).toEqual(['luna_001_1.jpg', 'luna_001_2.jpg']);
    // The folder recorded ON THE BATCH is what is used, not whatever the
    // runner's current default happens to be. A batch run last month must
    // still be explainable after the configured destination changes.
    expect(driveUploads.every((u) => u.folderId === 'test-drive-folder')).toBe(true);
  });
});

describe('duplicate filenames', () => {
  it('refuses the same filename twice WITHIN a batch', async () => {
    const created = await makeBatch();
    const batchId = created.json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'luna_001.txt', body: 'first' }]);
    const second = await uploadFiles(batchId, [{ filename: 'luna_001.txt', body: 'second' }]);
    expect(second.json().added).toBe(0);
    expect(second.json().outcomes[0]).toMatchObject({ reason: 'duplicate_in_batch' });
    // And the ORIGINAL prompt is untouched — a duplicate must not overwrite.
    const job = (await getBatch(batchId)).json().batch.jobs[0];
    expect(job.originalFilename).toBe('luna_001.txt');
    await drain(batchId);
    expect(xai.calls[0]!.prompt).toBe('first');
  });

  it('ALLOWS the same filename in a different batch', async () => {
    const a = (await makeBatch()).json().batch.id as string;
    const b = (await makeBatch()).json().batch.id as string;
    expect((await uploadFiles(a, [{ filename: 'luna_001.txt', body: 'x' }])).json().added).toBe(1);
    expect((await uploadFiles(b, [{ filename: 'luna_001.txt', body: 'y' }])).json().added).toBe(1);
  });
});

describe('partial success', () => {
  async function oneJob(body = 'prompt') {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'luna_001.txt', body }]);
    return batchId;
  }

  it('keeps output 1 completed when output 2 fails its Drive upload', async () => {
    const batchId = await oneJob();
    // The first upload succeeds; the second fails. The sibling must survive.
    let uploads = 0;
    drive.upload = async (file) => {
      uploads += 1;
      if (uploads === 2) throw new DriveError('http', 'Drive is unhappy.', 500);
      driveUploads.push(file);
      return { fileId: `drive-${uploads}`, webViewLink: `https://drive.example/${uploads}` };
    };

    await drain(batchId);
    const job = (await getBatch(batchId)).json().batch.jobs[0];
    expect(job.status).toBe('partial');
    expect(job.succeededCount).toBe(1);
    expect(job.failedCount).toBe(1);
    expect(job.outputs[0]).toMatchObject({ status: 'completed', driveFileId: 'drive-1' });
    expect(job.outputs[1]).toMatchObject({ status: 'drive_upload_failed', driveFileId: null });
  });

  it('creates only the MISSING output when the provider returns fewer than asked', async () => {
    const batchId = await oneJob();
    xai.behaviour = async (request, callIndex) =>
      callIndex === 0
        ? [{ bytes: Buffer.from('only-one') }] // asked for 2, got 1
        : Array.from({ length: request.n }, () => ({ bytes: Buffer.from('top-up') }));

    await drain(batchId);
    let job = (await getBatch(batchId)).json().batch.jobs[0];
    expect(job.status).toBe('partial');
    expect(job.outputs[0]!.status).toBe('completed');
    expect(job.outputs[1]!.status).toBe('failed');

    // The top-up asks for ONE image, not two — the successful one is not redone.
    await executeJob(on.db, deps, job.id);
    expect(xai.calls[1]!.n).toBe(1);
    job = (await getBatch(batchId)).json().batch.jobs[0];
    expect(job.status).toBe('completed');
    expect(job.succeededCount).toBe(2);
  });

  it('fails both outputs when generation fails outright, and neither is uploaded', async () => {
    const batchId = await oneJob();
    xai.behaviour = async () => {
      throw new XaiError('http', 'The image provider returned HTTP 500.', 500);
    };
    await drain(batchId);
    const job = (await getBatch(batchId)).json().batch.jobs[0];
    expect(job.status).toBe('failed');
    expect(job.outputs.every((o: { status: string }) => o.status === 'failed')).toBe(true);
    expect(driveUploads).toHaveLength(0);
  });
});

describe('retrying one output', () => {
  it('re-uploads from the spool WITHOUT paying for a new image', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'luna_001.txt', body: 'p' }]);
    drive.failNext(1); // output 1's upload fails; output 2 succeeds
    await drain(batchId);

    let job = (await getBatch(batchId)).json().batch.jobs[0];
    expect(job.status).toBe('partial');
    const failed = job.outputs.find((o: { status: string }) => o.status === 'drive_upload_failed');
    expect(failed).toBeDefined();
    const callsBefore = xai.calls.length;

    // The image already exists on disk, so the retry is an upload.
    const [row] = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.id, failed.id));
    expect(row!.spoolPath).toBeTruthy();
    expect(existsSync(row!.spoolPath!)).toBe(true);

    const res = await on.app.inject({
      method: 'POST',
      url: `/admin/prompt-generation/outputs/${failed.id}/retry`,
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(202);
    await executeJob(on.db, deps, job.id);

    // NOT ONE ADDITIONAL GENERATION. This is the assertion the whole
    // spool-before-upload design exists to make true.
    expect(xai.calls.length).toBe(callsBefore);
    job = (await getBatch(batchId)).json().batch.jobs[0];
    expect(job.status).toBe('completed');
    expect(job.outputs.every((o: { status: string }) => o.status === 'completed')).toBe(true);
  });

  it('refuses to retry a completed output, because that would duplicate the file', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    await drain(batchId);
    const job = (await getBatch(batchId)).json().batch.jobs[0];
    const res = await on.app.inject({
      method: 'POST',
      url: `/admin/prompt-generation/outputs/${job.outputs[0]!.id}/retry`,
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_completed');
    expect(driveUploads).toHaveLength(2);
  });

  it('leaves the completed sibling completely alone when retrying the other', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    drive.failNext(1);
    await drain(batchId);
    let job = (await getBatch(batchId)).json().batch.jobs[0];
    const good = job.outputs.find((o: { status: string }) => o.status === 'completed');
    const bad = job.outputs.find((o: { status: string }) => o.status !== 'completed');
    const goodDriveId = good.driveFileId;

    await retryOutput(on.db, deps, bad.id);
    await executeJob(on.db, deps, job.id);

    job = (await getBatch(batchId)).json().batch.jobs[0];
    const stillGood = job.outputs.find((o: { id: string }) => o.id === good.id);
    // Same row, same Drive id, one upload — untouched in every observable way.
    expect(stillGood.driveFileId).toBe(goodDriveId);
    expect(stillGood.status).toBe('completed');
  });
});

describe('restart safety', () => {
  it('re-uploads a generated-but-unsaved image instead of regenerating it', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    drive.failNext(2, new DriveError('network', 'Drive unreachable.'));
    await drain(batchId);
    const callsBefore = xai.calls.length;

    // Simulate a crash mid-upload: both rows sat in `uploading`.
    await on.db.update(promptJobOutputs).set({ status: 'uploading' });
    await on.db.update(promptJobs).set({ status: 'uploading' });

    const summary = await recoverInterruptedPromptJobs(on.db, deps);
    expect(summary.requeuedUploads).toBe(2);

    const [job] = await on.db.select().from(promptJobs).where(eq(promptJobs.batchId, batchId));
    await executeJob(on.db, deps, job!.id);

    expect(xai.calls.length).toBe(callsBefore); // nothing regenerated
    const detail = (await getBatch(batchId)).json().batch.jobs[0];
    expect(detail.status).toBe('completed');
  });

  it('NEVER regenerates a completed output after a restart', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    await drain(batchId);
    const callsBefore = xai.calls.length;
    const uploadsBefore = driveUploads.length;

    await recoverInterruptedPromptJobs(on.db, deps);
    const [job] = await on.db.select().from(promptJobs).where(eq(promptJobs.batchId, batchId));
    await executeJob(on.db, deps, job!.id);

    expect(xai.calls.length).toBe(callsBefore);
    expect(driveUploads.length).toBe(uploadsBefore);
  });

  it('abandons a job that has been recovered too many times rather than looping', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    await on.db.update(promptJobs).set({ status: 'generating', attempts: 99 });
    const summary = await recoverInterruptedPromptJobs(on.db, deps);
    expect(summary.abandonedJobs).toBe(1);
    const detail = (await getBatch(batchId)).json().batch.jobs[0];
    expect(detail.status).toBe('failed');
    expect(detail.error.kind).toBe('abandoned');
  });

  it('reading the queue never starts work — a refresh cannot restart a job', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    await drain(batchId);
    const calls = xai.calls.length;
    // Ten refreshes.
    for (let i = 0; i < 10; i += 1) await getBatch(batchId);
    expect(xai.calls.length).toBe(calls);
  });
});

/* ------------------------------------------------------------------ *
 * Batch controls
 * ------------------------------------------------------------------ */

describe('batch controls', () => {
  it('refuses to start an empty batch', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    const res = await on.app.inject({
      method: 'POST',
      url: `/admin/prompt-generation/batches/${batchId}/start`,
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('empty_batch');
  });

  it('reports the cost BEFORE the batch can be started', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [
      { filename: 'a.txt', body: 'p' },
      { filename: 'b.txt', body: 'p' },
      { filename: 'c.txt', body: 'p' },
    ]);
    const res = await on.app.inject({
      method: 'GET',
      url: `/admin/prompt-generation/batches/${batchId}/estimate`,
      cookies: adminCookies,
    });
    expect(res.json().estimate).toMatchObject({ prompts: 3, outputsPerPrompt: 2, images: 6 });
    // And the batch has still not started.
    expect((await getBatch(batchId)).json().batch.status).toBe('draft');
  });

  it('starting twice does not run the batch twice', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    const first = await on.app.inject({
      method: 'POST',
      url: `/admin/prompt-generation/batches/${batchId}/start`,
      cookies: adminCookies,
    });
    const second = await on.app.inject({
      method: 'POST',
      url: `/admin/prompt-generation/batches/${batchId}/start`,
      cookies: adminCookies,
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().reason).toBe('already_running');
  });

  it('pause stops the batch being running', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    await on.app.inject({
      method: 'POST',
      url: `/admin/prompt-generation/batches/${batchId}/start`,
      cookies: adminCookies,
    });
    const paused = await on.app.inject({
      method: 'POST',
      url: `/admin/prompt-generation/batches/${batchId}/pause`,
      cookies: adminCookies,
    });
    expect(paused.json().batch.status).toBe('paused');
  });

  it('retry failed touches only the jobs that are not complete', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [
      { filename: 'ok.txt', body: 'a good prompt' },
      { filename: 'bad.txt', body: 'a doomed prompt' },
    ]);
    /**
     * FAIL THE DOOMED PROMPT, NOT "THE SECOND CALL".
     *
     * This used to throw on call number two, which quietly assumed the two
     * jobs reached the provider in upload order. They do not: the runner's
     * concurrency is 2, so both are in flight at once and which one arrives
     * second is a race. The test therefore passed or failed by luck, and it
     * was luck rather than the code that decided. Keying the failure to the
     * prompt makes it deterministic under any interleaving.
     */
    xai.behaviour = async (request) => {
      if (request.prompt === 'a doomed prompt') throw new XaiError('http', 'boom', 500);
      return Array.from({ length: request.n }, () => ({ bytes: Buffer.from('img') }));
    };
    await drain(batchId);
    const before = (await getBatch(batchId)).json().batch.jobs;
    const okJob = before.find((j: { originalFilename: string }) => j.originalFilename === 'ok.txt');
    expect(okJob.status).toBe('completed');

    xai.behaviour = async (request) =>
      Array.from({ length: request.n }, () => ({ bytes: Buffer.from('img') }));
    const res = await on.app.inject({
      method: 'POST',
      url: `/admin/prompt-generation/batches/${batchId}/retry-failed`,
      cookies: adminCookies,
    });
    expect(res.json().retried).toBe(1);

    const after = (await getBatch(batchId)).json().batch.jobs;
    const okAfter = after.find((j: { originalFilename: string }) => j.originalFilename === 'ok.txt');
    // The completed job's outputs are byte-identical — same ids, same Drive ids.
    expect(okAfter.outputs.map((o: { driveFileId: string }) => o.driveFileId)).toEqual(
      okJob.outputs.map((o: { driveFileId: string }) => o.driveFileId),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Authorization and isolation
 * ------------------------------------------------------------------ */

describe('admin authorization', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/admin/prompt-generation/settings'],
    ['GET', '/admin/prompt-generation/batches'],
    ['POST', '/admin/prompt-generation/batches'],
  ];

  it('401s an anonymous caller and 403s a signed-in non-admin', async () => {
    for (const [method, url] of routes) {
      expect((await on.app.inject({ method: method as 'GET', url })).statusCode).toBe(401);
      expect(
        (await on.app.inject({ method: method as 'GET', url, cookies: userCookies })).statusCode,
      ).toBe(403);
    }
  });

  it('refuses a non-admin on every per-resource route too', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    const job = (await getBatch(batchId)).json().batch.jobs[0];
    const guarded: Array<[string, string]> = [
      ['GET', `/admin/prompt-generation/batches/${batchId}`],
      ['POST', `/admin/prompt-generation/batches/${batchId}/start`],
      ['POST', `/admin/prompt-generation/batches/${batchId}/pause`],
      ['POST', `/admin/prompt-generation/batches/${batchId}/retry-failed`],
      ['POST', `/admin/prompt-generation/jobs/${job.id}/retry`],
      ['POST', `/admin/prompt-generation/outputs/${job.outputs[0]!.id}/retry`],
    ];
    for (const [method, url] of guarded) {
      expect(
        (await on.app.inject({ method: method as 'GET', url, cookies: userCookies })).statusCode,
      ).toBe(403);
    }
    // And a non-admin cannot upload prompt files either.
    expect((await uploadFiles(batchId, [{ filename: 'x.txt', body: 'p' }], userCookies)).statusCode).toBe(403);
  });
});

describe('credential and path isolation', () => {
  it('never sends a key, a secret or a server path to the browser', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    await drain(batchId);

    const payloads = [
      (await getBatch(batchId)).payload,
      (await on.app.inject({ method: 'GET', url: '/admin/prompt-generation/settings', cookies: adminCookies })).payload,
      (await on.app.inject({ method: 'GET', url: '/admin/prompt-generation/batches', cookies: adminCookies })).payload,
    ];
    for (const payload of payloads) {
      expect(payload).not.toContain('spoolPath');
      expect(payload).not.toContain('spool_path');
      expect(payload).not.toContain(spoolDir);
      expect(payload).not.toContain('apiKey');
      expect(payload).not.toContain('refreshToken');
      expect(payload).not.toContain('clientSecret');
      expect(payload).not.toContain('XAI_API_KEY');
    }
  });

  it('documents that the API quality parameter is not the web app control', async () => {
    const res = await on.app.inject({
      method: 'GET',
      url: '/admin/prompt-generation/settings',
      cookies: adminCookies,
    });
    // The claim we are explicitly forbidden from making must not appear, and
    // the honest note must.
    expect(res.json().qualityNote).toMatch(/not documented as equivalent/i);
    expect(res.json().params).toMatchObject({ aspectRatio: '2:3', resolution: '2k', quality: 'medium' });
  });
});

describe('isolation from Over18 content', () => {
  it('creates no character asset, and the Content Library stays empty', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [
      { filename: 'a.txt', body: 'p' },
      { filename: 'b.txt', body: 'p' },
    ]);
    await drain(batchId);

    const assets = await on.pool.query('SELECT count(*)::int AS n FROM character_visual_assets');
    expect(assets.rows[0].n).toBe(0);

    const library = await on.app.inject({
      method: 'GET',
      url: '/admin/content/library',
      cookies: adminCookies,
    });
    expect(library.json().assets).toEqual([]);

    // And nothing reached the public surfaces either.
    const home = await on.app.inject({ method: 'GET', url: '/api/home' });
    expect(home.json().categories).toEqual([]);
    expect(home.json().hero).toEqual([]);
  });

  it('writes only its own three tables', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    await drain(batchId);
    for (const table of [
      'character_visual_assets',
      'app_category_assets',
      'home_hero_clips',
      'content_inbox',
      'generation_jobs',
      'generation_results',
    ]) {
      const result = await on.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect({ table, n: result.rows[0].n }).toEqual({ table, n: 0 });
    }
  });
});

describe('the mock Drive client', () => {
  it('records uploads so a batch can be exercised with no credentials', async () => {
    const mock = createMockGoogleDriveClient();
    const result = await mock.upload({
      filename: 'a_1.jpg',
      mimeType: 'image/jpeg',
      bytes: Buffer.from('x'),
    });
    expect(result.fileId).toContain('a_1.jpg');
    expect(mock.uploads).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Lifecycle regressions
 *
 * Four ways this feature could get stuck or spend money twice, each one
 * reachable from the Admin UI with no unusual input. They are grouped because
 * they share one subject: what happens on the SECOND failure, and on the retry
 * after it.
 * ------------------------------------------------------------------ */

/** The one job of a single-prompt batch. */
async function onlyJob(batchId: string) {
  const [job] = await on.db.select().from(promptJobs).where(eq(promptJobs.batchId, batchId));
  return job!;
}

async function outputsOf(jobId: string) {
  return on.db
    .select()
    .from(promptJobOutputs)
    .where(eq(promptJobOutputs.jobId, jobId))
    .orderBy(promptJobOutputs.ordinal);
}

/**
 * Waits for background work started with `setImmediate` to reach a terminal
 * batch status, so an assertion cannot read a half-finished run.
 */
async function settleBatch(batchId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [batch] = await on.db.select().from(promptBatches).where(eq(promptBatches.id, batchId));
    if (batch && batch.status === 'completed') return batch;
    if (Date.now() > deadline) {
      throw new Error(`batch ${batchId} never settled (status ${batch?.status ?? 'missing'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('one execution per job (no double generation)', () => {
  it('generates ONCE when the same job is executed twice concurrently', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'luna_001.txt', body: 'p' }]);
    const job = await onlyJob(batchId);

    /**
     * The provider is held open so both executions are genuinely in flight at
     * the same time. Without the gate the first could finish before the second
     * even claims, and the test would pass for the wrong reason.
     */
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    xai.behaviour = async (request) => {
      await gate;
      return Array.from({ length: request.n }, (_u, i) => ({
        bytes: Buffer.from(`image-${i + 1}`),
      }));
    };

    const first = executeJob(on.db, deps, job.id);
    const second = executeJob(on.db, deps, job.id);
    release();
    await Promise.all([first, second]);

    // THE ASSERTION THIS WHOLE FIX EXISTS FOR: one prompt, one paid call.
    expect(xai.calls).toHaveLength(1);
    expect(xai.calls[0]!.n).toBe(2);
    expect(driveUploads).toHaveLength(2);
    const outputs = await outputsOf(job.id);
    expect(outputs.map((o) => o.status)).toEqual(['completed', 'completed']);
  });

  it('refuses to execute a job that is already being executed', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    const job = await onlyJob(batchId);
    // The state a claim leaves behind. A second execution must decline it.
    await on.db.update(promptJobs).set({ status: 'generating' }).where(eq(promptJobs.id, job.id));

    await executeJob(on.db, deps, job.id);

    expect(xai.calls).toHaveLength(0);
    expect(driveUploads).toHaveLength(0);
  });

  it('generates each prompt once when two drains race over one batch', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [
      { filename: 'a.txt', body: 'prompt a' },
      { filename: 'b.txt', body: 'prompt b' },
    ]);
    await on.db
      .update(promptBatches)
      .set({ status: 'running' })
      .where(eq(promptBatches.id, batchId));

    // Two concurrent drains — what a retry used to cause by scheduling the
    // jobs itself AND restarting the batch.
    await Promise.all([runBatch(on.db, deps, batchId), runBatch(on.db, deps, batchId)]);

    expect(xai.calls).toHaveLength(2);
    expect(xai.calls.map((c) => c.prompt).sort()).toEqual(['prompt a', 'prompt b']);
    expect(driveUploads).toHaveLength(4);
  });

  it('Retry failed schedules the batch drain only, never the jobs as well', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    // Generation fails, so the retry has to REGENERATE — the case where a
    // duplicate schedule would be billed twice.
    xai.behaviour = async () => {
      throw new XaiError('http', 'provider is down', 500);
    };
    await drain(batchId);
    const job = await onlyJob(batchId);
    expect((await outputsOf(job.id)).every((o) => o.status === 'failed')).toBe(true);

    xai.behaviour = async (request) =>
      Array.from({ length: request.n }, (_u, i) => ({ bytes: Buffer.from(`image-${i + 1}`) }));
    const callsBefore = xai.calls.length;

    const { retried } = await retryFailedInBatch(on.db, deps, batchId);
    expect(retried).toBe(1);
    await settleBatch(batchId);

    // Exactly one further generation for the one job that needed regenerating.
    expect(xai.calls.length - callsBefore).toBe(1);
    expect((await outputsOf(job.id)).map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(driveUploads).toHaveLength(2);
  });
});

describe('a spent upload budget is terminal, not stuck', () => {
  /** A job whose images exist and whose upload budget is already gone. */
  async function jobWithSpentUploadBudget() {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    drive.failNext(2, new DriveError('network', 'Drive unreachable.'));
    await drain(batchId);
    const job = await onlyJob(batchId);
    // The bytes are on disk; only the uploads have been spent.
    await on.db
      .update(promptJobOutputs)
      .set({ status: 'generated', uploadAttempts: MAX_OUTPUT_UPLOAD_ATTEMPTS })
      .where(eq(promptJobOutputs.jobId, job.id));
    await on.db.update(promptJobs).set({ status: 'queued' }).where(eq(promptJobs.id, job.id));
    await on.db
      .update(promptBatches)
      .set({ status: 'running', completedAt: null })
      .where(eq(promptBatches.id, batchId));
    return { batchId, job };
  }

  it('records a reason instead of leaving the output in generated', async () => {
    const { job } = await jobWithSpentUploadBudget();
    await executeJob(on.db, deps, job.id);

    const outputs = await outputsOf(job.id);
    // NOT `generated`. That status is counted as in flight, and it is what
    // used to pin the job to `uploading` for ever.
    expect(outputs.map((o) => o.status)).toEqual(['drive_upload_failed', 'drive_upload_failed']);
    for (const output of outputs) {
      expect((output.error as { kind: string }).kind).toBe('drive_upload_attempts_exhausted');
      // The paid bytes are still held, which is why this is retryable at all.
      expect(output.spoolPath).toBeTruthy();
      expect(existsSync(output.spoolPath!)).toBe(true);
    }
  });

  it('lets the job and the batch reach a terminal status', async () => {
    const { batchId, job } = await jobWithSpentUploadBudget();
    await executeJob(on.db, deps, job.id);

    const [row] = await on.db.select().from(promptJobs).where(eq(promptJobs.id, job.id));
    expect(row!.status).toBe('failed');
    expect(row!.completedAt).not.toBeNull();
    const [batch] = await on.db.select().from(promptBatches).where(eq(promptBatches.id, batchId));
    expect(batch!.status).toBe('completed');
  });

  it('is recoverable with Retry failed, and costs nothing at the provider', async () => {
    const { batchId, job } = await jobWithSpentUploadBudget();
    await executeJob(on.db, deps, job.id);
    const callsBefore = xai.calls.length;

    const { retried } = await retryFailedInBatch(on.db, deps, batchId);
    expect(retried).toBe(1);
    await settleBatch(batchId);

    const outputs = await outputsOf(job.id);
    expect(outputs.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(outputs.every((o) => o.driveFileId !== null)).toBe(true);
    // The images were already paid for. Recovery is an upload, never a purchase.
    expect(xai.calls.length).toBe(callsBefore);
  });
});

describe('generation and upload budgets are separate', () => {
  it('does not spend generation attempts on failed Drive uploads', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);

    drive.failNext(2, new DriveError('network', 'Drive unreachable.'));
    await drain(batchId);
    const job = await onlyJob(batchId);

    let outputs = await outputsOf(job.id);
    expect(outputs.map((o) => o.status)).toEqual(['drive_upload_failed', 'drive_upload_failed']);
    for (const output of outputs) {
      expect(output.attempts).toBe(1); // one generation, which succeeded
      expect(output.uploadAttempts).toBe(1);
    }

    // A second and third round of Drive failures.
    for (const round of [2, 3]) {
      drive.failNext(2, new DriveError('network', 'Drive unreachable.'));
      await executeJob(on.db, deps, job.id);
      outputs = await outputsOf(job.id);
      for (const output of outputs) {
        // THE POINT: three Drive outages, and the generation budget is
        // untouched. Sharing one column is what used to make this output
        // permanently ineligible to be generated again.
        expect(output.attempts).toBe(1);
        expect(output.uploadAttempts).toBe(round);
      }
    }

    // And not one extra image was bought along the way.
    expect(xai.calls).toHaveLength(1);
  });

  it('still enforces the generation attempt limit', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    xai.behaviour = async () => {
      throw new XaiError('http', 'provider is down', 500);
    };
    const job = await onlyJob(batchId);

    // One more pass than the budget allows.
    for (let i = 0; i < MAX_OUTPUT_GENERATION_ATTEMPTS + 1; i += 1) {
      await executeJob(on.db, deps, job.id);
    }

    expect(xai.calls).toHaveLength(MAX_OUTPUT_GENERATION_ATTEMPTS);
    const outputs = await outputsOf(job.id);
    for (const output of outputs) {
      expect(output.status).toBe('failed');
      expect(output.attempts).toBe(MAX_OUTPUT_GENERATION_ATTEMPTS);
      expect(output.uploadAttempts).toBe(0);
    }
  });

  it('never regenerates an image whose only problem was the upload', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    drive.failNext(2, new DriveError('network', 'Drive unreachable.'));
    await drain(batchId);
    const job = await onlyJob(batchId);

    // Three more refusals — four in all, which stays one inside the upload
    // budget so the fifth attempt is a real upload rather than the exhaustion
    // branch. Exhaustion has its own tests.
    for (let i = 0; i < 3; i += 1) {
      drive.failNext(2, new DriveError('network', 'Drive unreachable.'));
      await executeJob(on.db, deps, job.id);
    }
    await executeJob(on.db, deps, job.id);

    // One generation for the whole story, however many uploads it took.
    expect(xai.calls).toHaveLength(1);
    const outputs = await outputsOf(job.id);
    expect(outputs.every((o) => o.attempts === 1)).toBe(true);
    expect(outputs.map((o) => o.status)).toEqual(['completed', 'completed']);
  });
});

describe('a lost spool file becomes regenerable', () => {
  /** A batch whose outputs have bytes recorded but no file on disk. */
  async function jobWithLostSpoolFile() {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    drive.failNext(2, new DriveError('network', 'Drive unreachable.'));
    await drain(batchId);
    const job = await onlyJob(batchId);
    for (const output of await outputsOf(job.id)) {
      expect(output.spoolPath).toBeTruthy();
      unlinkSync(output.spoolPath!); // the volume lost them
    }
    return { batchId, job };
  }

  it('clears the stale path and says the image must be generated again', async () => {
    const { job } = await jobWithLostSpoolFile();
    await executeJob(on.db, deps, job.id);

    const outputs = await outputsOf(job.id);
    for (const output of outputs) {
      expect(output.status).toBe('failed');
      // A path pointing at nothing is what sent every future retry back into
      // the upload branch, where it failed on exactly this read.
      expect(output.spoolPath).toBeNull();
      expect((output.error as { kind: string }).kind).toBe('spool_missing');
    }
  });

  it('regenerates on retry instead of retrying an upload for ever', async () => {
    const { batchId, job } = await jobWithLostSpoolFile();
    await executeJob(on.db, deps, job.id);
    const callsBefore = xai.calls.length;

    const { retried } = await retryFailedInBatch(on.db, deps, batchId);
    expect(retried).toBe(1);
    await settleBatch(batchId);

    // The bytes were gone, so this time the provider IS called — that is the
    // only correct answer, and the old code could never reach it.
    expect(xai.calls.length).toBe(callsBefore + 1);
    const outputs = await outputsOf(job.id);
    expect(outputs.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(outputs.every((o) => o.spoolPath === null)).toBe(true);
  });

  it('sends a retry to upload while bytes remain, and to generation once they do not', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    drive.failNext(2, new DriveError('network', 'Drive unreachable.'));
    await drain(batchId);
    const job = await onlyJob(batchId);
    const outputs = await outputsOf(job.id);

    // Bytes present -> the retry is an upload.
    await retryOutput(on.db, deps, outputs[0]!.id);
    let [reloaded] = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.id, outputs[0]!.id));
    expect(reloaded!.status).toBe('drive_upload_failed');

    // Sibling, bytes now gone -> the retry is a regeneration.
    unlinkSync(outputs[1]!.spoolPath!);
    await executeJob(on.db, deps, job.id);
    const [lost] = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.id, outputs[1]!.id));
    expect(lost!.spoolPath).toBeNull();
    await retryOutput(on.db, deps, lost!.id);
    [reloaded] = await on.db
      .select()
      .from(promptJobOutputs)
      .where(eq(promptJobOutputs.id, outputs[1]!.id));
    expect(reloaded!.status).toBe('pending');
  });

  it('never regenerates a completed image, whatever happens to the spool', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    await drain(batchId);
    const job = await onlyJob(batchId);
    const callsBefore = xai.calls.length;

    const outputs = await outputsOf(job.id);
    expect(outputs.every((o) => o.status === 'completed')).toBe(true);
    // A completed output has already had its spool copy removed; running the
    // job again must still find nothing to do.
    await executeJob(on.db, deps, job.id);

    expect(xai.calls.length).toBe(callsBefore);
    const after = await outputsOf(job.id);
    expect(after.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(after.map((o) => o.driveFileId)).toEqual(outputs.map((o) => o.driveFileId));
  });
});

/* ------------------------------------------------------------------ *
 * The provider's reason, allowlisted
 *
 * "HTTP 400" is true and useless. These pin the two named fields that are
 * read, and the two values that must never survive being read: our API key
 * and the operator's prompt.
 * ------------------------------------------------------------------ */

describe('naming why the image provider refused', () => {
  const SECRET = 'xai-key-abcdefghijklmnop';
  const PROMPT = 'a very specific prompt that the provider might echo back at us';

  it("reads xAI's flat {code, error} shape", () => {
    const detail = xaiErrorReason(
      JSON.stringify({ code: 'invalid_request:bad-parameter', error: 'resolution is invalid.' }),
      [],
    );
    expect(detail.code).toBe('invalid_request:bad-parameter');
    expect(detail.description).toBe('resolution is invalid.');
  });

  it('reads the nested OpenAI-compatible {error:{code,message}} shape too', () => {
    const detail = xaiErrorReason(
      JSON.stringify({ error: { code: 'content_policy_violation', message: 'Prompt rejected.' } }),
      [],
    );
    expect(detail.code).toBe('content_policy_violation');
    expect(detail.description).toBe('Prompt rejected.');
  });

  it('reads ONLY the two named fields, however much else the body carries', () => {
    const detail = xaiErrorReason(
      JSON.stringify({
        code: 'moderation:refused',
        error: 'That prompt was refused.',
        // None of the below is an allowlisted field, so none of it is read.
        api_key: SECRET,
        authorization: `Bearer ${SECRET}`,
        prompt: PROMPT,
        request: { prompt: PROMPT, key: SECRET },
        account_id: 'acct_should_not_appear',
      }),
      [SECRET, PROMPT],
    );
    expect(detail.code).toBe('moderation:refused');
    expect(detail.description).toBe('That prompt was refused.');
    const rendered = `${detail.code} ${detail.description}`;
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(PROMPT);
    expect(rendered).not.toContain('acct_should_not_appear');
  });

  it('redacts the key and the prompt even INSIDE the allowlisted fields', () => {
    const detail = xaiErrorReason(
      JSON.stringify({
        code: 'invalid_request',
        error: `The prompt "${PROMPT}" was refused, key ${SECRET}.`,
      }),
      [SECRET, PROMPT],
    );
    expect(detail.description).toContain('[redacted]');
    expect(detail.description).not.toContain(SECRET);
    expect(detail.description).not.toContain(PROMPT);
  });

  it('reduces the code to an identifier, so a pasted key cannot survive in it', () => {
    const detail = xaiErrorReason(
      JSON.stringify({ code: 'bad code! with spaces/and slashes', error: 'x' }),
      [],
    );
    expect(detail.code).toBe('badcodewithspacesandslashes');
  });

  it('bounds the description rather than carrying a payload', () => {
    const detail = xaiErrorReason(JSON.stringify({ error: 'x'.repeat(5000) }), []);
    expect(detail.description!.length).toBeLessThanOrEqual(200);
  });

  it('yields no reason at all for an unreadable body, instead of throwing', () => {
    expect(xaiErrorReason('<html>502 Bad Gateway</html>', [])).toEqual({
      code: null,
      description: null,
    });
    expect(xaiErrorReason('', [])).toEqual({ code: null, description: null });
  });

  it('names the reason in the HTTP error the operator actually sees', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ code: 'content_policy_violation', error: 'Prompt rejected.' }),
        { status: 400 },
      )) as unknown as typeof fetch;
    const provider = createXaiImageProvider(
      { baseUrl: 'https://stub/v1', apiKey: SECRET, model: 'm', timeoutMs: 1000, maxAttempts: 1 },
      new RateLimiter({ requestsPerSecond: 100, maxConcurrent: 4 }),
      fetchImpl,
      async () => {},
    );
    const error = await provider
      .generate({ prompt: PROMPT, n: 2, params: DEFAULT_PARAMS })
      .catch((e) => e as XaiError);
    expect(error).toBeInstanceOf(XaiError);
    expect((error as XaiError).kind).toBe('http');
    // The whole point: the message now says WHY.
    expect((error as XaiError).message).toContain('content_policy_violation');
    expect((error as XaiError).message).not.toContain(SECRET);
    // ...and the provider's PROSE still never travels, per this file's rule
    // that an error body can carry the prompt.
    expect((error as XaiError).message).not.toContain('Prompt rejected.');
  });

  it('names the reason on a 429 too, so quota is distinguishable from pacing', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: 'credits:exhausted', error: 'Out of credits.' }), {
        status: 429,
      })) as unknown as typeof fetch;
    const provider = createXaiImageProvider(
      { baseUrl: 'https://stub/v1', apiKey: SECRET, model: 'm', timeoutMs: 1000, maxAttempts: 1 },
      new RateLimiter({ requestsPerSecond: 100, maxConcurrent: 4 }),
      fetchImpl,
      async () => {},
    );
    const error = await provider
      .generate({ prompt: PROMPT, n: 1, params: DEFAULT_PARAMS })
      .catch((e) => e as XaiError);
    expect((error as XaiError).kind).toBe('rate_limited');
    expect((error as XaiError).message).toContain('credits:exhausted');
  });

  it('still refuses to read an auth body, because the answer is always the same', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: 'leaked', error: `key ${SECRET} for acct_12345` }), {
        status: 401,
      })) as unknown as typeof fetch;
    const provider = createXaiImageProvider(
      { baseUrl: 'https://stub/v1', apiKey: SECRET, model: 'm', timeoutMs: 1000, maxAttempts: 1 },
      new RateLimiter({ requestsPerSecond: 100, maxConcurrent: 4 }),
      fetchImpl,
      async () => {},
    );
    const error = await provider
      .generate({ prompt: PROMPT, n: 1, params: DEFAULT_PARAMS })
      .catch((e) => e as XaiError);
    expect((error as XaiError).kind).toBe('auth');
    expect((error as XaiError).message).toBe('The image provider refused our credentials.');
    expect((error as XaiError).message).not.toContain('acct_12345');
  });

  it('leaves retry semantics exactly as they were', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 'invalid_request', error: 'nope' }), {
        status: 400,
      });
    }) as unknown as typeof fetch;
    const provider = createXaiImageProvider(
      { baseUrl: 'https://stub/v1', apiKey: SECRET, model: 'm', timeoutMs: 1000, maxAttempts: 3 },
      new RateLimiter({ requestsPerSecond: 100, maxConcurrent: 4 }),
      fetchImpl,
      async () => {},
    );
    await provider.generate({ prompt: PROMPT, n: 1, params: DEFAULT_PARAMS }).catch(() => {});
    // A 400 is still not retryable. Naming it must not make us pay for it 3x.
    expect(calls).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * A refused image is terminal
 *
 * The provider generates for ~100s and then refuses the result. That is not a
 * failed attempt to be repeated — it is an answer. These pin that it is
 * classified apart from ordinary 4xx, never retried automatically, and that
 * genuinely transient failures are untouched by the distinction.
 * ------------------------------------------------------------------ */

describe('an image the provider refuses is terminal, not a spent attempt', () => {
  const KEY = 'xai-key-abcdefghijklmnop';
  const MODERATED = JSON.stringify({
    code: 'imagine:content-moderated',
    error: 'Generated image rejected by content moderation.',
  });

  const providerReturning = (status: number, body: string, onCall?: () => void) =>
    createXaiImageProvider(
      { baseUrl: 'https://stub/v1', apiKey: KEY, model: 'm', timeoutMs: 1000, maxAttempts: 3 },
      new RateLimiter({ requestsPerSecond: 1000, maxConcurrent: 4 }),
      (async () => {
        onCall?.();
        return new Response(body, { status });
      }) as unknown as typeof fetch,
      async () => {},
    );

  /* --- 1. the refusal is its own kind, and it is terminal --- */

  it('classifies a moderation refusal apart from an ordinary 4xx', async () => {
    const error = (await providerReturning(400, MODERATED)
      .generate({ prompt: 'p', n: 2, params: DEFAULT_PARAMS })
      .catch((e) => e)) as XaiError;
    expect(error.kind).toBe('content_moderated');
    expect(error.status).toBe(400);
    // The reason code still reaches the operator.
    expect(error.message).toContain('imagine:content-moderated');
    // ...and the provider's prose still does not.
    expect(error.message).not.toContain('Generated image rejected by content moderation.');
  });

  it('is not retryable, unlike a 4xx that merely means we asked wrongly', async () => {
    const moderated = (await providerReturning(400, MODERATED)
      .generate({ prompt: 'p', n: 1, params: DEFAULT_PARAMS })
      .catch((e) => e)) as XaiError;
    expect(moderated.retryable).toBe(false);
    expect(new XaiError('content_moderated', 'x', 400).retryable).toBe(false);
  });

  it('still reports a NON-moderation 400 as a plain http failure', async () => {
    const error = (await providerReturning(400, JSON.stringify({ code: 'invalid-argument' }))
      .generate({ prompt: 'p', n: 1, params: DEFAULT_PARAMS })
      .catch((e) => e)) as XaiError;
    expect(error.kind).toBe('http');
    expect(error.message).toContain('invalid-argument');
  });

  /* --- 2. no second generation attempt --- */

  it('asks the provider exactly once, never maxAttempts times', async () => {
    let calls = 0;
    await providerReturning(400, MODERATED, () => {
      calls += 1;
    })
      .generate({ prompt: 'p', n: 2, params: DEFAULT_PARAMS })
      .catch(() => {});
    expect(calls).toBe(1);
  });

  it('does not spend another generation attempt on the next pass over the job', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    const job = await onlyJob(batchId);

    xai.behaviour = async () => {
      throw new XaiError('content_moderated', 'refused — imagine:content-moderated', 400);
    };
    await executeJob(on.db, deps, job.id);

    let outputs = await outputsOf(job.id);
    expect(outputs.map((o) => o.status)).toEqual(['failed', 'failed']);
    for (const output of outputs) {
      expect((output.error as { kind: string }).kind).toBe('xai_content_moderated');
    }
    const callsAfterFirst = xai.calls.length;
    expect(callsAfterFirst).toBe(1);

    // Every later automatic pass: a batch drain, or the boot recovery sweep.
    await executeJob(on.db, deps, job.id);
    await executeJob(on.db, deps, job.id);

    // THE POINT: not one further request, and the budget is untouched.
    expect(xai.calls.length).toBe(callsAfterFirst);
    outputs = await outputsOf(job.id);
    expect(outputs.every((o) => o.attempts === 1)).toBe(true);
    expect(outputs.every((o) => o.status === 'failed')).toBe(true);
  });

  it('lets the job and batch reach a terminal status rather than hanging', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    const job = await onlyJob(batchId);
    // The batch has to be RUNNING for finaliseBatch to close it — a draft batch
    // staying draft is correct, not a hang.
    await on.db
      .update(promptBatches)
      .set({ status: 'running' })
      .where(eq(promptBatches.id, batchId));
    xai.behaviour = async () => {
      throw new XaiError('content_moderated', 'refused — imagine:content-moderated', 400);
    };
    await executeJob(on.db, deps, job.id);

    const [row] = await on.db.select().from(promptJobs).where(eq(promptJobs.id, job.id));
    expect(row!.status).toBe('failed');
    expect(row!.completedAt).not.toBeNull();
    const [batch] = await on.db.select().from(promptBatches).where(eq(promptBatches.id, batchId));
    expect(batch!.status).toBe('completed');
  });

  /* --- 3. transient failures are untouched --- */

  it('still retries a 5xx inside one call, up to the attempt budget', async () => {
    let calls = 0;
    await providerReturning(500, JSON.stringify({ code: 'internal' }), () => {
      calls += 1;
    })
      .generate({ prompt: 'p', n: 1, params: DEFAULT_PARAMS })
      .catch(() => {});
    expect(calls).toBe(3);
  });

  it('keeps timeout, network and rate_limited retryable', () => {
    expect(new XaiError('timeout', 'x').retryable).toBe(true);
    expect(new XaiError('network', 'x').retryable).toBe(true);
    expect(new XaiError('rate_limited', 'x', 429).retryable).toBe(true);
    expect(new XaiError('http', 'x', 503).retryable).toBe(true);
    expect(new XaiError('http', 'x', 400).retryable).toBe(false);
  });

  it('still spends another generation attempt on a TRANSIENT failure', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    const job = await onlyJob(batchId);

    xai.behaviour = async () => {
      throw new XaiError('http', 'provider is down', 500);
    };
    await executeJob(on.db, deps, job.id);
    expect(xai.calls).toHaveLength(1);

    // A transient failure MUST still be picked up by the next pass — the whole
    // point of separating the kinds is that this behaviour does not change.
    await executeJob(on.db, deps, job.id);
    expect(xai.calls).toHaveLength(2);
    const outputs = await outputsOf(job.id);
    expect(outputs.every((o) => o.attempts === 2)).toBe(true);
  });

  it('recovers a transient failure when the provider comes back', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    const job = await onlyJob(batchId);

    xai.behaviour = async () => {
      throw new XaiError('network', 'unreachable');
    };
    await executeJob(on.db, deps, job.id);
    xai.behaviour = async (request) =>
      Array.from({ length: request.n }, (_u, i) => ({ bytes: Buffer.from(`image-${i + 1}`) }));
    await executeJob(on.db, deps, job.id);

    const outputs = await outputsOf(job.id);
    expect(outputs.map((o) => o.status)).toEqual(['completed', 'completed']);
  });

  /* --- 4. the ordinary lifecycle is unchanged --- */

  it('leaves a clean generate-and-upload untouched', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'luna_001.txt', body: 'a prompt' }]);
    const job = await onlyJob(batchId);
    await executeJob(on.db, deps, job.id);

    expect(xai.calls).toHaveLength(1);
    expect(xai.calls[0]!.n).toBe(2);
    expect(driveUploads).toHaveLength(2);
    const outputs = await outputsOf(job.id);
    expect(outputs.map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(outputs.every((o) => o.driveFileId !== null)).toBe(true);
    expect(outputs.every((o) => o.spoolPath === null)).toBe(true);
    expect(outputs.every((o) => o.attempts === 1)).toBe(true);
    const [row] = await on.db.select().from(promptJobs).where(eq(promptJobs.id, job.id));
    expect(row!.status).toBe('completed');
    expect(row!.succeededCount).toBe(2);
  });

  it('leaves the Drive-failure path untouched — still re-uploads, never regenerates', async () => {
    const batchId = (await makeBatch()).json().batch.id as string;
    await uploadFiles(batchId, [{ filename: 'a.txt', body: 'p' }]);
    const job = await onlyJob(batchId);
    drive.failNext(2, new DriveError('network', 'Drive unreachable.'));
    await executeJob(on.db, deps, job.id);

    let outputs = await outputsOf(job.id);
    expect(outputs.map((o) => o.status)).toEqual(['drive_upload_failed', 'drive_upload_failed']);
    await executeJob(on.db, deps, job.id);

    outputs = await outputsOf(job.id);
    expect(outputs.map((o) => o.status)).toEqual(['completed', 'completed']);
    // One generation for the whole story: a Drive failure is not a moderation
    // failure and neither is a reason to buy the image twice.
    expect(xai.calls).toHaveLength(1);
  });
});
