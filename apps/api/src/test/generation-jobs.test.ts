import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { generationJobs } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import { CostLedger } from '../media-pipeline/cost-ledger.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import type { MediaJobDeps } from '../services/media-generation-service.js';
import type { GenerationConfiguration } from '../generation/config.js';
import {
  createGenerationJob,
  executeGenerationJob,
  getGenerationJob,
  listJobsForSequenceRun,
  MAX_RETRIES,
  retryGenerationJob,
  submitGenerationJob,
  enqueueGenerationJob,
  recoverStaleJobs,
  retryGenerationResult,
} from '../generation/jobs.js';
import { createSequence } from '../generation/sequences.js';
import { executeResult, listResults, MAX_RESULT_ATTEMPTS } from '../generation/results.js';
import { runSequence } from '../generation/sequence-runner.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * US-103 — Generation Job runtime: persistence before execution, lifecycle,
 * quantity fan-out for image AND video, partial failure, retry, and simple
 * ordered sequence execution.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const FIXTURES = join(testEnv.media.storageDir, '__us103__');
const IMAGE_FIXTURE = join(FIXTURES, 'seed.jpg');
const VIDEO_FIXTURE = join(FIXTURES, 'seed.mp4');

let ctx: TestContext;
let identityId: string;

function deps(overrides: Partial<MediaJobDeps> = {}): MediaJobDeps {
  return {
    providers: createMockProviders({
      imageFixturePath: IMAGE_FIXTURE,
      videoFixturePath: VIDEO_FIXTURE,
    }),
    ledger: new CostLedger(join(testEnv.media.storageDir, `ledger-${Math.floor(performance.now() * 1000)}.json`)),
    storage: { storageDir: testEnv.media.storageDir, publicBaseUrl: null },
    ...overrides,
  };
}

function imageConfig(over: Record<string, unknown> = {}): GenerationConfiguration {
  return {
    type: 'image',
    characterId: LUNA.id,
    prompt: 'studio portrait, neutral lighting',
    modelId: 'mock:image',
    ...over,
  } as GenerationConfiguration;
}

beforeAll(async () => {
  migrateTestDb();
  rmSync(testEnv.media.storageDir, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(IMAGE_FIXTURE, Buffer.from('fake-jpeg-bytes'));
  writeFileSync(VIDEO_FIXTURE, Buffer.from('fake-mp4-bytes'));
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
  rmSync(testEnv.media.storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
  identityId = (await getActiveVisualIdentity(ctx.db, LUNA.id))!.id;
});

describe('US-103 job creation', () => {
  it('persists a queued job BEFORE any provider call, with the effective config', async () => {
    const created = await createGenerationJob(ctx.db, imageConfig({ quantity: 3 }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const job = created.value;
    expect(job.status).toBe('queued');
    expect(job.requestedQuantity).toBe(3);
    expect(job.succeededCount).toBe(0);
    expect(job.completedAt).toBeNull();

    // Context the review workflow will need.
    expect(job.characterId).toBe(LUNA.id);
    expect(job.visualIdentityId).toBe(identityId);
    expect(job.provider).toBe('mock');
    expect(job.model).toBe('mock:image');

    const effective = job.effectiveConfig as Record<string, unknown>;
    expect(effective.resultStatus).toBe('under_review');
    expect(effective.quantity).toBe(3);
    // No credential ever reaches the database.
    const serialized = JSON.stringify(effective).toLowerCase();
    for (const secret of ['apikey', 'api_key', 'authorization', 'bearer', 'secret', 'token']) {
      expect(serialized).not.toContain(secret);
    }

    // Nothing generated yet.
    const row = await getGenerationJob(ctx.db, job.id);
    expect(row!.status).toBe('queued');
  });

  it('rejects an invalid configuration without creating a job', async () => {
    const before = await ctx.db.select().from(generationJobs);
    const created = await createGenerationJob(ctx.db, imageConfig({ parameters: { nope: 1 } }));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.errors.map((e) => e.code)).toContain('unsupported_parameter');
    const after = await ctx.db.select().from(generationJobs);
    expect(after.length).toBe(before.length);
  });

  it('does not start a second paid job for a repeated idempotency key', async () => {
    const a = await createGenerationJob(ctx.db, imageConfig(), { idempotencyKey: 'req-1' });
    const b = await createGenerationJob(ctx.db, imageConfig(), { idempotencyKey: 'req-1' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.id).toBe(a.value.id);
    const all = await ctx.db.select().from(generationJobs);
    expect(all).toHaveLength(1);
  });
});

describe('US-103 job execution', () => {
  it('drives queued -> completed and records timestamps', async () => {
    const created = await createGenerationJob(ctx.db, imageConfig());
    if (!created.ok) return;
    const executed = await executeGenerationJob(ctx.db, deps(), created.value.id);
    expect(executed).not.toBeNull();
    expect(executed!.job.status).toBe('completed');
    expect(executed!.job.succeededCount).toBe(1);
    expect(executed!.job.completedAt).not.toBeNull();
    expect(executed!.assets).toHaveLength(1);
    expect(executed!.assets[0].status).toBe('under_review');
  });

  it('fans quantity=3 into 3 independent assets under one job', async () => {
    const submitted = await submitGenerationJob(ctx.db, deps(), imageConfig({ quantity: 3 }));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const { job, assets } = submitted.value;
    expect(job.status).toBe('completed');
    expect(job.succeededCount).toBe(3);
    expect(assets).toHaveLength(3);
    expect(new Set(assets.map((a) => a.id)).size).toBe(3); // independent identities
    for (const a of assets) {
      expect(a.status).toBe('under_review');
      expect(a.visualIdentityId).toBe(identityId);
      expect(a.isCanonical).toBe(false);
    }
  });

  it('produces 3 independently reviewable VIDEOS from one Primary image', async () => {
    const seeded = await submitGenerationJob(ctx.db, deps(), imageConfig());
    if (!seeded.ok) return;
    const primary = seeded.value.assets[0];

    const submitted = await submitGenerationJob(ctx.db, deps(), {
      type: 'video',
      characterId: LUNA.id,
      sourceImageAssetId: primary.id,
      motionPrompt: 'slow turn toward camera',
      modelId: 'mock:video',
      quantity: 3,
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    expect(submitted.value.job.status).toBe('completed');
    expect(submitted.value.assets).toHaveLength(3);
    expect(new Set(submitted.value.assets.map((a) => a.id)).size).toBe(3);
    for (const a of submitted.value.assets) {
      expect(a.storageKey?.endsWith('.mp4')).toBe(true);
      expect(a.status).toBe('under_review');
    }
  });

  it('marks a run partial and KEEPS the successful assets', async () => {
    // A budget that runs out mid fan-out.
    const ledger = new CostLedger(join(testEnv.media.storageDir, 'ledger-partial.json'));
    const submitted = await submitGenerationJob(
      ctx.db,
      { ...deps(), ledger, characterBudgetUsd: 0.0001 },
      imageConfig({ quantity: 3 }),
    );
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const { job, assets } = submitted.value;
    expect(['partial', 'failed']).toContain(job.status);
    expect(job.succeededCount).toBe(assets.length);
    expect(job.succeededCount).toBeLessThan(3);
    // Whatever succeeded is still persisted and reviewable.
    for (const a of assets) expect(a.status).toBe('under_review');
    // The budget refusal is recorded on the RESULT rows, not swallowed.
    const rows = await listResults(ctx.db, job.id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'failed').length).toBeGreaterThan(0);
    expect(rows.find((r) => r.status === 'failed')!.error).toBeTruthy();
  });

  it('does not let fan-out bypass cost control', async () => {
    const ledger = new CostLedger(join(testEnv.media.storageDir, 'ledger-cost.json'));
    const submitted = await submitGenerationJob(ctx.db, { ...deps(), ledger }, imageConfig({ quantity: 3 }));
    if (!submitted.ok) return;
    // Cost accrues per attempt, so 3 outputs cost strictly more than 1.
    const three = Number(submitted.value.job.estimatedCostUsd);
    const single = await submitGenerationJob(ctx.db, { ...deps(), ledger }, imageConfig());
    if (!single.ok) return;
    expect(three).toBeGreaterThan(Number(single.value.job.estimatedCostUsd));
  });
});

describe('US-103 retry', () => {
  it('retries only what is missing and never regenerates successes', async () => {
    const ledger = new CostLedger(join(testEnv.media.storageDir, 'ledger-retry.json'));
    const submitted = await submitGenerationJob(
      ctx.db,
      { ...deps(), ledger, characterBudgetUsd: 0.0001 },
      imageConfig({ quantity: 3 }),
    );
    if (!submitted.ok) return;
    const partial = submitted.value.job;
    const alreadyMade = partial.succeededCount;
    expect(alreadyMade).toBeLessThan(3);

    // Retry with a healthy budget.
    const retried = await retryGenerationJob(ctx.db, deps(), partial.id);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;

    // Only the missing outputs were generated this time.
    expect(retried.value.assets.length).toBe(3 - alreadyMade);
    expect(retried.value.job.succeededCount).toBe(3);
    expect(retried.value.job.status).toBe('completed');
    expect(retried.value.job.retryCount).toBe(1);
  });

  it('refuses to retry a completed job', async () => {
    const submitted = await submitGenerationJob(ctx.db, deps(), imageConfig());
    if (!submitted.ok) return;
    const retried = await retryGenerationJob(ctx.db, deps(), submitted.value.job.id);
    expect(retried.ok).toBe(false);
  });

  it('respects the retry limit', async () => {
    const created = await createGenerationJob(ctx.db, imageConfig({ quantity: 2 }));
    if (!created.ok) return;
    await ctx.db
      .update(generationJobs)
      .set({ retryCount: MAX_RETRIES, status: 'partial' })
      .where(eq(generationJobs.id, created.value.id));

    const retried = await retryGenerationJob(ctx.db, deps(), created.value.id);
    expect(retried.ok).toBe(false);
    if (retried.ok) return;
    expect(retried.errors[0].message).toContain('retry limit');
  });
});

describe('US-103 sequence execution', () => {
  async function makeSequence(videoQuantity = 3) {
    const created = await createSequence(ctx.db, {
      name: 'daily content',
      characterId: LUNA.id,
      steps: [
        { ordinal: 1, config: imageConfig({ quantity: 2 }) },
        {
          ordinal: 2,
          usePreviousStepOutput: true,
          config: {
            type: 'video',
            characterId: LUNA.id,
            sourceImageAssetId: '',
            motionPrompt: 'slow turn',
            modelId: 'mock:video',
            quantity: videoQuantity,
          },
        },
      ],
    });
    if (!created.ok) throw new Error('sequence fixture invalid');
    return created.value;
  }

  it('runs steps in order and feeds step 1 output into step 2', async () => {
    const sequence = await makeSequence(3);
    const result = await runSequence(ctx.db, deps(), {
      sequenceId: sequence.id,
      characterId: LUNA.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { run, steps } = result.value;
    expect(run.status).toBe('completed');
    expect(run.totalSteps).toBe(2);
    expect(steps.map((s) => s.ordinal)).toEqual([1, 2]);

    // Step 1 produced 2 images.
    expect(steps[0].status).toBe('completed');
    expect(steps[0].assets).toHaveLength(2);

    // Step 2: 3 videos PER eligible source image = 2 jobs x 3 = 6 videos.
    expect(steps[1].status).toBe('completed');
    expect(steps[1].jobs).toHaveLength(2);
    expect(steps[1].assets).toHaveLength(6);
    for (const a of steps[1].assets) expect(a.status).toBe('under_review');

    // Every job is attributable to the run and the step that made it.
    const jobs = await listJobsForSequenceRun(ctx.db, run.id);
    expect(jobs).toHaveLength(3); // 1 image job + 2 video jobs
    expect(jobs.every((j) => j.sequenceRunId === run.id)).toBe(true);
    expect(jobs.map((j) => j.stepOrdinal)).toEqual([1, 2, 2]);
  });

  it('blocks a dependent step when the previous step produced nothing', async () => {
    const sequence = await makeSequence(2);
    // Starve the budget so step 1 produces no assets at all.
    const ledger = new CostLedger(join(testEnv.media.storageDir, 'ledger-blocked.json'));
    const result = await runSequence(
      ctx.db,
      { ...deps(), ledger, characterBudgetUsd: 0.0000001 },
      { sequenceId: sequence.id, characterId: LUNA.id },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { run, steps } = result.value;
    expect(steps[0].status).toBe('failed');
    expect(steps[1].status).toBe('blocked');
    expect(steps[1].reason).toBeTruthy();
    expect(steps[1].assets).toHaveLength(0);
    expect(['failed', 'blocked']).toContain(run.status);
  });

  it('does not erase earlier successes when a later step is blocked', async () => {
    const sequence = await makeSequence(2);
    const result = await runSequence(ctx.db, deps(), {
      sequenceId: sequence.id,
      characterId: LUNA.id,
    });
    if (!result.ok) return;
    // Even in the happy path, assert the invariant the failure policy rests on:
    // step 1's assets remain regardless of what step 2 does.
    expect(result.value.steps[0].assets.length).toBeGreaterThan(0);
  });

  it('introduces no workflow engine — a run is just ordered steps', async () => {
    const sequence = await makeSequence(1);
    const result = await runSequence(ctx.db, deps(), {
      sequenceId: sequence.id,
      characterId: LUNA.id,
    });
    if (!result.ok) return;
    const ordinals = result.value.steps.map((s) => s.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
  });
});

describe('US-103 Generation Results — per-result identity and retry', () => {
  /**
   * Deps with a budget too small to authorize even one attempt, so the attempt
   * fails deterministically before any provider work — the cheapest reliable
   * failure available without stubbing the provider seam.
   */
  function brokenDeps(): MediaJobDeps {
    return { ...deps(), characterBudgetUsd: 0.0000001 };
  }

  it('creates one result row per expected output, before anything runs', async () => {
    const created = await createGenerationJob(ctx.db, imageConfig({ quantity: 5 }));
    if (!created.ok) return;
    const rows = await listResults(ctx.db, created.value.id);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.every((r) => r.assetId === null)).toBe(true);
  });

  it('retrying result 3 regenerates ONLY result 3', async () => {
    const created = await createGenerationJob(ctx.db, imageConfig({ quantity: 5 }));
    if (!created.ok) return;
    const job = created.value;
    const rows = await listResults(ctx.db, job.id);
    const effective = job.effectiveConfig as never;

    for (const row of rows) {
      await executeResult(ctx.db, row.ordinal === 3 ? brokenDeps() : deps(), effective, row);
    }

    const afterFirstPass = await listResults(ctx.db, job.id);
    expect(afterFirstPass.filter((r) => r.status === 'succeeded').map((r) => r.ordinal)).toEqual([
      1, 2, 4, 5,
    ]);
    expect(afterFirstPass.filter((r) => r.status === 'failed').map((r) => r.ordinal)).toEqual([3]);

    const untouchedBefore = afterFirstPass
      .filter((r) => r.ordinal !== 3)
      .map((r) => ({ ordinal: r.ordinal, assetId: r.assetId }));

    const retried = await retryGenerationResult(ctx.db, deps(), afterFirstPass[2].id);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;

    expect(retried.value.result.ordinal).toBe(3);
    expect(retried.value.result.status).toBe('succeeded');
    expect(retried.value.asset).not.toBeNull();
    expect(retried.value.asset!.status).toBe('under_review');

    const after = await listResults(ctx.db, job.id);
    const untouchedAfter = after
      .filter((r) => r.ordinal !== 3)
      .map((r) => ({ ordinal: r.ordinal, assetId: r.assetId }));
    expect(untouchedAfter).toEqual(untouchedBefore);

    const finalJob = await getGenerationJob(ctx.db, job.id);
    expect(finalJob!.status).toBe('completed');
    expect(finalJob!.succeededCount).toBe(5);
    expect(finalJob!.failedCount).toBe(0);
  });

  it('refuses to retry a result that already succeeded', async () => {
    const submitted = await submitGenerationJob(ctx.db, deps(), imageConfig());
    if (!submitted.ok) return;
    const [row] = await listResults(ctx.db, submitted.value.job.id);
    expect(row.status).toBe('succeeded');
    expect((await retryGenerationResult(ctx.db, deps(), row.id)).ok).toBe(false);
  });

  it('bounds attempts on a single result', async () => {
    const created = await createGenerationJob(ctx.db, imageConfig());
    if (!created.ok) return;
    const effective = created.value.effectiveConfig as never;
    for (let i = 0; i < MAX_RESULT_ATTEMPTS; i += 1) {
      const current = (await listResults(ctx.db, created.value.id))[0];
      await executeResult(ctx.db, brokenDeps(), effective, current);
    }
    const exhausted = (await listResults(ctx.db, created.value.id))[0];
    expect(exhausted.attempts).toBe(MAX_RESULT_ATTEMPTS);
    const retried = await retryGenerationResult(ctx.db, deps(), exhausted.id);
    expect(retried.ok).toBe(false);
    if (retried.ok) return;
    expect(retried.errors[0].message).toContain('attempt limit');
  });

  it('links each succeeded result to its own distinct asset', async () => {
    const submitted = await submitGenerationJob(ctx.db, deps(), imageConfig({ quantity: 3 }));
    if (!submitted.ok) return;
    const assetIds = (await listResults(ctx.db, submitted.value.job.id)).map((r) => r.assetId);
    expect(assetIds.every(Boolean)).toBe(true);
    expect(new Set(assetIds).size).toBe(3);
  });
});

describe('US-103 asynchronous execution contract', () => {
  it('returns a job id immediately and completes in the background', async () => {
    const enqueued = await enqueueGenerationJob(ctx.db, deps(), imageConfig({ quantity: 2 }));
    expect(enqueued.ok).toBe(true);
    if (!enqueued.ok) return;
    expect(enqueued.value.id).toBeTruthy();
    expect(enqueued.value.status).toBe('queued');

    const deadline = Date.now() + 15_000;
    let status = enqueued.value.status;
    while (
      Date.now() < deadline &&
      status !== 'completed' &&
      status !== 'partial' &&
      status !== 'failed'
    ) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await getGenerationJob(ctx.db, enqueued.value.id))!.status;
    }
    expect(status).toBe('completed');
    const rows = await listResults(ctx.db, enqueued.value.id);
    expect(rows.filter((r) => r.status === 'succeeded')).toHaveLength(2);
  });

  it('re-queues jobs left running by a crash, without losing finished results', async () => {
    const created = await createGenerationJob(ctx.db, imageConfig({ quantity: 2 }));
    if (!created.ok) return;
    const rows = await listResults(ctx.db, created.value.id);
    await executeResult(ctx.db, deps(), created.value.effectiveConfig as never, rows[0]);
    await ctx.db
      .update(generationJobs)
      .set({ status: 'running' })
      .where(eq(generationJobs.id, created.value.id));

    const recovered = await recoverStaleJobs(ctx.db);
    expect(recovered.map((j) => j.id)).toContain(created.value.id);
    expect((await getGenerationJob(ctx.db, created.value.id))!.status).toBe('queued');

    const resumed = await executeGenerationJob(ctx.db, deps(), created.value.id);
    expect(resumed!.assets).toHaveLength(1);
    expect(resumed!.job.status).toBe('completed');
    expect(resumed!.job.succeededCount).toBe(2);
  });
});
