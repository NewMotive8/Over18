import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { characters, characterVisualAssets, generationJobs, generationResults } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import { CostLedger } from '../media-pipeline/cost-ledger.js';
import type { MediaJobDeps } from '../services/media-generation-service.js';
import type { GenerationConfiguration } from '../generation/config.js';
import { checkGenerationBarrier } from '../generation/barrier.js';
import {
  createGenerationJob,
  executeGenerationJob,
  getGenerationJob,
  submitGenerationJob,
} from '../generation/jobs.js';
import { executeResult, listResults, MAX_RESULT_ATTEMPTS } from '../generation/results.js';
import { deleteLibraryAsset } from '../services/library-upload-service.js';
import { getVisualAssetById } from '../services/visual-asset-service.js';
import {
  activateVisualIdentityVersion,
  createVisualIdentityVersion,
  getActiveVisualIdentity,
  retireVisualIdentityVersion,
} from '../services/visual-identity-service.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * P0.7 -- GENERATION GUARDRAILS.
 *
 * The generation system is not redesigned here. What this pins is the shape it
 * already has, plus the three guards it was missing:
 *
 *   ONE CANONICAL PATH     configuration -> job -> result -> provider ->
 *                          media-generation-service -> character asset ->
 *                          Review. No wrapper may write an asset another way.
 *   THE LIFECYCLE BARRIER  asked at submission AND again at commit, because a
 *                          provider call outlives the check that started it.
 *   BOUNDED, CLEAN FAILURE retries capped in the claim itself, and bytes that
 *                          will never become an asset removed rather than left.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;
const FIXTURES = join(testEnv.media.storageDir, '__p07__');
const IMAGE_FIXTURE = join(FIXTURES, 'seed.jpg');
const VIDEO_FIXTURE = join(FIXTURES, 'seed.mp4');

let on: TestContext;

function deps(overrides: Partial<MediaJobDeps> = {}): MediaJobDeps {
  return {
    providers: createMockProviders({ imageFixturePath: IMAGE_FIXTURE, videoFixturePath: VIDEO_FIXTURE }),
    ledger: new CostLedger(join(testEnv.media.storageDir, `ledger-p07-${Math.floor(performance.now() * 1000)}.json`)),
    storage: { storageDir: testEnv.media.storageDir, publicBaseUrl: null },
    ...overrides,
  };
}

/** Providers that run the real mock, then do something between call and commit. */
function providersThatDo(between: () => Promise<void>): MediaJobDeps {
  const base = deps();
  const image = base.providers.image;
  return {
    ...base,
    providers: {
      ...base.providers,
      image: {
        ...image,
        generateImage: async (request) => {
          const result = await image.generateImage(request);
          await between();
          return result;
        },
      },
    },
  };
}

const imageConfig = (over: Record<string, unknown> = {}): GenerationConfiguration =>
  ({
    type: 'image',
    characterId: LUNA.id,
    prompt: 'studio portrait, neutral lighting',
    modelId: 'mock:image',
    ...over,
  }) as GenerationConfiguration;

const generatedFilesFor = (characterId: string) => {
  const dir = join(testEnv.media.storageDir, characterId, 'generated');
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** Assets this character owns that GENERATION produced. */
const generatedAssetsFor = async (characterId: string) => {
  const rows = await on.db
    .select({ id: characterVisualAssets.id, origin: characterVisualAssets.origin })
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.characterId, characterId));
  return rows.filter((row) => row.origin === 'generated').map((row) => row.id);
};

beforeAll(async () => {
  migrateTestDb();
  rmSync(testEnv.media.storageDir, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(IMAGE_FIXTURE, Buffer.from('fake-jpeg-bytes'));
  writeFileSync(VIDEO_FIXTURE, Buffer.from('fake-mp4-bytes'));
  // Real media providers, so the internal media routes are live in this context.
  on = await createTestContext({
    mediaProviders: createMockProviders({ imageFixturePath: IMAGE_FIXTURE, videoFixturePath: VIDEO_FIXTURE }),
  });
});
afterAll(async () => {
  await destroyTestContext(on);
  rmSync(testEnv.media.storageDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
  // Bytes outlive the database between tests, and several assertions here are
  // "nothing was left on disk" -- so each test starts with an empty tree.
  for (const character of [LUNA, EMBER]) {
    rmSync(join(testEnv.media.storageDir, character.id), { recursive: true, force: true });
  }
});

/* ================================================================== *
 * One canonical path
 * ================================================================== */

describe('one canonical generation-to-asset path', () => {
  it('every generated asset has a job and a result row behind it, and lands in Review', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const submitted = await submitGenerationJob(on.db, deps(), imageConfig());
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const asset = submitted.value.assets[0]!;
    const stored = (await getVisualAssetById(on.db, asset.id))!;
    expect({
      origin: stored.origin,
      status: stored.status,
      canonical: stored.isCanonical,
      identity: stored.visualIdentityId,
      published: stored.publishedAt,
    }).toEqual({
      origin: 'generated',
      status: 'under_review',
      canonical: false,
      identity: identity.id,
      published: null,
    });

    const results = await listResults(on.db, submitted.value.job.id);
    expect(results.map((r) => r.assetId)).toEqual([asset.id]);
    expect(results[0]!.status).toBe('succeeded');
  });

  it('the internal media route runs through the SAME job path, not a shortcut', async () => {
    const before = await on.db.select().from(generationJobs);
    const res = await on.app.inject({
      method: 'POST',
      url: '/internal/media/generate-image',
      headers: { 'x-internal-token': testEnv.media.internalToken! },
      payload: { characterId: LUNA.id, prompt: 'a calm studio portrait', contentRating: 'sfw' },
    });
    expect(res.statusCode).toBe(201);

    const after = await on.db.select().from(generationJobs);
    expect(after.length).toBe(before.length + 1);
    const job = after.find((j) => !before.some((b) => b.id === j.id))!;
    const results = await listResults(on.db, job.id);
    expect(results.map((r) => r.assetId)).toEqual([res.json().asset.id]);
  });

  /**
   * The structural half: no new wrapper may create a generated asset, or call a
   * provider, outside the one service that owns both.
   */
  it('only the media generation service writes generated assets or calls providers', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'test' && name !== 'media-pipeline') walk(full);
        } else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    const assetWriters: string[] = [];
    const providerCallers: string[] = [];
    for (const file of files) {
      const rel = relative(srcRoot, file).split('\\').join('/');
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/origin:\s*'generated'/.test(code)) assetWriters.push(rel);
      if (/\.generateImage\(|\.imageToVideo\(/.test(code)) providerCallers.push(rel);
    }
    expect(assetWriters).toEqual(['services/media-generation-service.ts']);
    expect(providerCallers).toEqual(['services/media-generation-service.ts']);
  });

  it('no route reaches the single-asset writers directly -- they go through jobs', () => {
    const routes = fileURLToPath(new URL('../routes', import.meta.url));
    for (const name of readdirSync(routes)) {
      const code = readFileSync(join(routes, name), 'utf8');
      expect({ name, direct: /generateImageJob|generateVideoJob/.test(code) }).toEqual({ name, direct: false });
    }
  });
});

/* ================================================================== *
 * The character lifecycle barrier
 * ================================================================== */

describe('the character lifecycle barrier', () => {
  it('refuses a job for a character that does not exist, before anything is written', async () => {
    const jobsBefore = await on.db.select().from(generationJobs);
    const created = await createGenerationJob(on.db, imageConfig({ characterId: EMBER.id.replace(/.$/, '0') }));
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.errors[0]!.message).toContain('does not exist');
    expect(await on.db.select().from(generationJobs)).toHaveLength(jobsBefore.length);
  });

  it('refuses a job for a character with no active identity, and pays nothing', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    await retireVisualIdentityVersion(on.db, identity.id);

    const created = await createGenerationJob(on.db, imageConfig());
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.errors[0]!.message).toContain('no active visual identity');
    expect(generatedFilesFor(LUNA.id)).toEqual([]);
  });

  it('does NOT block an unpublished character -- that is the ordinary build journey', async () => {
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    const barrier = await checkGenerationBarrier(on.db, LUNA.id);
    expect(barrier.ok).toBe(true);

    const submitted = await submitGenerationJob(on.db, deps(), imageConfig());
    expect(submitted.ok).toBe(true);
    if (submitted.ok) expect(submitted.value.assets).toHaveLength(1);
  });

  /**
   * THE RACE THIS EXISTS FOR: the character passed the gate when the job was
   * created, and stopped being able to own content while the provider worked.
   */
  it('refuses to COMMIT when the character became ineligible mid-generation, and removes the bytes', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const midFlight = providersThatDo(async () => {
      await retireVisualIdentityVersion(on.db, identity.id);
    });

    const submitted = await submitGenerationJob(on.db, midFlight, imageConfig());
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    expect(submitted.value.assets).toHaveLength(0);
    expect(submitted.value.job.status).toBe('failed');
    const results = await listResults(on.db, submitted.value.job.id);
    expect(results[0]!.status).toBe('failed');
    expect((results[0]!.error as { kind: string }).kind).toBe('character_unavailable');

    // Nothing was written into the asset table, and no file was left behind.
    expect(results[0]!.assetId).toBeNull();
    expect(await generatedAssetsFor(LUNA.id)).toEqual([]);
    expect(generatedFilesFor(LUNA.id)).toEqual([]);
  });

  it('refuses to commit for a character deleted mid-generation, and leaves no file', async () => {
    const midFlight = providersThatDo(async () => {
      await on.db.delete(characters).where(eq(characters.id, LUNA.id));
    });
    const created = await createGenerationJob(on.db, imageConfig());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const executed = await executeGenerationJob(on.db, midFlight, created.value.id).catch(() => null);
    // Whether her row cascaded away or the write simply failed, the outcome is
    // the same: no generated asset, and no bytes left behind.
    expect(await generatedAssetsFor(LUNA.id)).toEqual([]);
    expect(generatedFilesFor(LUNA.id)).toEqual([]);
    expect(executed?.assets ?? []).toEqual([]);
  });

  it('is one question, asked the same way at both ends', async () => {
    const ok = await checkGenerationBarrier(on.db, LUNA.id);
    expect(ok.ok).toBe(true);
    const missing = await checkGenerationBarrier(on.db, EMBER.id.replace(/.$/, '0'));
    expect(missing).toMatchObject({ ok: false, reason: 'character_not_found' });
    const identity = (await getActiveVisualIdentity(on.db, EMBER.id))!;
    await retireVisualIdentityVersion(on.db, identity.id);
    expect(await checkGenerationBarrier(on.db, EMBER.id)).toMatchObject({
      ok: false,
      reason: 'no_active_identity',
    });
  });
});

/* ================================================================== *
 * Bounded retries and partial runs
 * ================================================================== */

describe('retries stay bounded wherever they are driven from', () => {
  it('an exhausted result cannot be claimed, even by a direct caller', async () => {
    const created = await createGenerationJob(on.db, imageConfig());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [result] = await listResults(on.db, created.value.id);

    await on.db
      .update(generationResults)
      .set({ attempts: MAX_RESULT_ATTEMPTS, status: 'failed' })
      .where(eq(generationResults.id, result!.id));
    const exhausted = (await listResults(on.db, created.value.id))[0]!;

    const outcome = await executeResult(
      on.db,
      deps(),
      created.value.effectiveConfig as never,
      exhausted,
    );
    expect(outcome.claimed).toBe(false);
    expect(outcome.asset).toBeNull();
    // No provider ran: no attempt was spent and no bytes were produced.
    const after = (await listResults(on.db, created.value.id))[0]!;
    expect(after.attempts).toBe(MAX_RESULT_ATTEMPTS);
    expect(generatedFilesFor(LUNA.id)).toEqual([]);
  });

  it('a partial run keeps its successes and leaves the failure retryable', async () => {
    let calls = 0;
    const base = deps();
    const flaky: MediaJobDeps = {
      ...base,
      providers: {
        ...base.providers,
        image: {
          ...base.providers.image,
          generateImage: async (request) => {
            calls += 1;
            if (calls === 2) throw new Error('provider had a bad moment');
            return base.providers.image.generateImage(request);
          },
        },
      },
    };

    const submitted = await submitGenerationJob(on.db, flaky, imageConfig({ quantity: 3 }));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const job = await getGenerationJob(on.db, submitted.value.job.id);
    expect(job!.status).toBe('partial');
    expect(submitted.value.assets).toHaveLength(2);
    const results = await listResults(on.db, job!.id);
    expect(results.filter((r) => r.status === 'succeeded')).toHaveLength(2);
    const failed = results.find((r) => r.status === 'failed')!;
    expect(failed.attempts).toBe(1);
    expect(failed.assetId).toBeNull();
  });
});

/* ================================================================== *
 * Deletion and cleanup
 * ================================================================== */

describe('deletion leaves generation history honest', () => {
  it('deleting a generated asset unlinks its result and keeps the job', async () => {
    const submitted = await submitGenerationJob(on.db, deps(), imageConfig());
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const asset = submitted.value.assets[0]!;
    const path = (asset.provenance as Record<string, unknown>).storagePath as string;
    expect(existsSync(path)).toBe(true);

    await deleteLibraryAsset(on.db, { storageDir: testEnv.media.storageDir }, asset.id);

    const results = await listResults(on.db, submitted.value.job.id);
    expect(results[0]).toMatchObject({ status: 'succeeded', assetId: null });
    expect(await getGenerationJob(on.db, submitted.value.job.id)).not.toBeNull();
    // The Library delete owns the bytes; generation leaves no second copy.
    expect(existsSync(path)).toBe(false);
  });

  it('deleting a character takes its jobs, results and assets with it', async () => {
    const submitted = await submitGenerationJob(on.db, deps(), imageConfig());
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    await on.db.delete(characters).where(eq(characters.id, LUNA.id));

    expect(await on.db.select().from(generationJobs).where(eq(generationJobs.characterId, LUNA.id))).toEqual([]);
    expect(await on.db.select().from(generationResults).where(eq(generationResults.jobId, submitted.value.job.id))).toEqual([]);
    expect(await on.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.characterId, LUNA.id))).toEqual([]);
  });

  it('generation follows the ACTIVE identity version, and leaves older content on its own', async () => {
    // The other half of P0.6: existing content keeps its version (pinned there),
    // and new generation binds to whatever is active now -- through the barrier.
    const first = await submitGenerationJob(on.db, deps(), imageConfig());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const v1AssetId = first.value.assets[0]!.id;
    const v1 = (await getActiveVisualIdentity(on.db, LUNA.id))!;

    const draft = await createVisualIdentityVersion(on.db, LUNA.id, { apparentAgeBand: 'adult' }, { label: 'v2' });
    const v2 = await activateVisualIdentityVersion(on.db, draft.id);

    const barrier = await checkGenerationBarrier(on.db, LUNA.id);
    expect(barrier).toMatchObject({ ok: true, identityId: v2.id });

    const second = await submitGenerationJob(on.db, deps(), imageConfig());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.assets[0]!.visualIdentityId).toBe(v2.id);
    // And the earlier asset did not move.
    expect((await getVisualAssetById(on.db, v1AssetId))!.visualIdentityId).toBe(v1.id);
  });
});
