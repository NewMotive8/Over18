/**
 * US-103 — Generation Job runtime.
 *
 * US-105 answers "what do we want to generate?". This answers "run it, track
 * it, persist what happened, hand the results to review".
 *
 * The rule that shapes this file: a job row exists in the database BEFORE any
 * provider is called, and is updated as the run progresses. An in-memory UUID is
 * not a record. If the provider times out, the process crashes, or an operator
 * reloads mid-run, the row still says what was asked for and how far it got.
 *
 * Job and Asset stay separate concepts: one job with quantity 3 produces three
 * independent `character_visual_assets` rows, each individually reviewable.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  generationJobs,
  type CharacterVisualAssetRow,
  type GenerationJobRow,
} from '../db/schema.js';
import type { MediaJobDeps, MediaJobResult } from '../services/media-generation-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import type {
  EffectiveGenerationConfiguration,
  GenerationConfigError,
  GenerationConfiguration,
} from './config.js';
import { resolveGenerationConfiguration } from './resolve.js';
import { runGenerationJob } from './run-job.js';

/** Bounded so a retry loop can never run away (ticket section 8). */
export const MAX_RETRIES = 3;

export type JobResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly GenerationConfigError[] };

export interface CreateJobOptions {
  defaultModelId?: string;
  /** Resubmitting the same key returns the existing job instead of paying twice. */
  idempotencyKey?: string;
  sequenceRunId?: string;
  stepOrdinal?: number;
}

/**
 * Validate a configuration and persist it as a queued job. Nothing is generated
 * here — creation and execution are separate so an invalid configuration costs
 * nothing and a valid one is durable before any spend.
 */
export async function createGenerationJob(
  db: Db,
  config: GenerationConfiguration,
  options: CreateJobOptions = {},
): Promise<JobResult<GenerationJobRow>> {
  if (options.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.idempotencyKey, options.idempotencyKey));
    if (existing) return { ok: true, value: existing };
  }

  const identity = await getActiveVisualIdentity(db, config.characterId);
  if (!identity) {
    return {
      ok: false,
      errors: [
        {
          code: 'character_required',
          field: 'characterId',
          message: 'character has no active visual identity to generate against',
        },
      ],
    };
  }

  const resolved = resolveGenerationConfiguration(config, {
    visualIdentityId: identity.id,
    defaultModelId: options.defaultModelId,
  });
  if (!resolved.ok) return { ok: false, errors: resolved.errors };

  const effective = resolved.effective;
  const [row] = await db
    .insert(generationJobs)
    .values({
      characterId: effective.characterId,
      visualIdentityId: effective.visualIdentityId,
      type: effective.type,
      provider: effective.provider,
      model: effective.modelId,
      status: 'queued',
      effectiveConfig: effective,
      requestedQuantity: effective.quantity,
      idempotencyKey: options.idempotencyKey ?? null,
      sequenceRunId: options.sequenceRunId ?? null,
      stepOrdinal: options.stepOrdinal ?? null,
    })
    .returning();

  return { ok: true, value: row };
}

export interface ExecuteResult {
  job: GenerationJobRow;
  assets: CharacterVisualAssetRow[];
}

/**
 * Run a queued (or retried) job. Progress is written as it happens, and the
 * terminal status distinguishes completed / partial / failed so a partial run
 * never looks like a success and never discards its successes.
 */
export async function executeGenerationJob(
  db: Db,
  deps: MediaJobDeps,
  jobId: string,
): Promise<ExecuteResult | null> {
  const job = await getGenerationJob(db, jobId);
  if (!job) return null;

  const effective = job.effectiveConfig as EffectiveGenerationConfiguration;
  const alreadyDone = job.succeededCount;
  const remaining = Math.max(0, job.requestedQuantity - alreadyDone);

  await db
    .update(generationJobs)
    .set({ status: 'running' })
    .where(eq(generationJobs.id, jobId));

  if (remaining === 0) {
    const [done] = await db
      .update(generationJobs)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(generationJobs.id, jobId))
      .returning();
    return { job: done, assets: [] };
  }

  const run = await runGenerationJob(db, deps, effective, {
    remaining,
    // Persist progress mid-flight so a crash leaves an accurate row and a UI
    // can poll "5 / 8 completed" without waiting for the run to finish.
    onAttempt: async (p) => {
      await db
        .update(generationJobs)
        .set({
          succeededCount: alreadyDone + p.succeeded,
          failedCount: p.failed,
          estimatedCostUsd: String(p.estimatedCostUsd),
        })
        .where(eq(generationJobs.id, jobId));
    },
  });

  const succeeded = alreadyDone + run.succeeded;
  const status = terminalStatusFor(succeeded, job.requestedQuantity, run.failed);

  const [updated] = await db
    .update(generationJobs)
    .set({
      status,
      succeededCount: succeeded,
      failedCount: run.failed,
      estimatedCostUsd: String(run.estimatedCostUsd),
      actualCostUsd: String(run.estimatedCostUsd),
      failures: run.failures,
      completedAt: new Date(),
    })
    .where(eq(generationJobs.id, jobId))
    .returning();

  return { job: updated, assets: run.assets };
}

function terminalStatusFor(
  succeeded: number,
  requested: number,
  failed: number,
): 'completed' | 'partial' | 'failed' {
  if (succeeded >= requested) return 'completed';
  if (succeeded > 0) return 'partial';
  return failed > 0 ? 'failed' : 'partial';
}

/** Create and immediately run. The single entry point both automated
 * generation and the future Studio use — one execution path, no duplicate
 * provider logic. */
export async function submitGenerationJob(
  db: Db,
  deps: MediaJobDeps,
  config: GenerationConfiguration,
  options: CreateJobOptions = {},
): Promise<JobResult<ExecuteResult>> {
  const created = await createGenerationJob(db, config, options);
  if (!created.ok) return created;
  const executed = await executeGenerationJob(db, deps, created.value.id);
  if (!executed) {
    return {
      ok: false,
      errors: [{ code: 'unknown_model', field: 'jobId', message: 'job vanished after creation' }],
    };
  }
  return { ok: true, value: executed };
}

export async function getGenerationJob(db: Db, jobId: string): Promise<GenerationJobRow | null> {
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  return row ?? null;
}

export async function listGenerationJobsForCharacter(
  db: Db,
  characterId: string,
): Promise<GenerationJobRow[]> {
  return db.select().from(generationJobs).where(eq(generationJobs.characterId, characterId));
}

export async function listJobsForSequenceRun(
  db: Db,
  sequenceRunId: string,
): Promise<GenerationJobRow[]> {
  const rows = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.sequenceRunId, sequenceRunId));
  return rows.sort((a, b) => (a.stepOrdinal ?? 0) - (b.stepOrdinal ?? 0));
}

/** Jobs never picked up — useful for a crash-recovery sweep. */
export async function listOrphanedQueuedJobs(db: Db): Promise<GenerationJobRow[]> {
  return db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.status, 'queued'), isNull(generationJobs.sequenceRunId)));
}

/**
 * Retry only what is missing. Successful assets are never regenerated: the run
 * targets `requested - succeeded`, so retrying a 5-item job that produced 4 makes
 * exactly one more provider call.
 */
export async function retryGenerationJob(
  db: Db,
  deps: MediaJobDeps,
  jobId: string,
): Promise<JobResult<ExecuteResult>> {
  const job = await getGenerationJob(db, jobId);
  if (!job) {
    return { ok: false, errors: [{ code: 'unknown_model', field: 'jobId', message: 'job not found' }] };
  }
  if (job.status === 'completed') {
    return {
      ok: false,
      errors: [{ code: 'invalid_quantity', field: 'jobId', message: 'job already completed' }],
    };
  }
  if (job.retryCount >= MAX_RETRIES) {
    return {
      ok: false,
      errors: [
        {
          code: 'invalid_quantity',
          field: 'jobId',
          message: `retry limit of ${MAX_RETRIES} reached for this job`,
        },
      ],
    };
  }

  await db
    .update(generationJobs)
    .set({ retryCount: job.retryCount + 1, failures: [], failedCount: 0 })
    .where(eq(generationJobs.id, jobId));

  const executed = await executeGenerationJob(db, deps, jobId);
  if (!executed) {
    return { ok: false, errors: [{ code: 'unknown_model', field: 'jobId', message: 'job not found' }] };
  }
  return { ok: true, value: executed };
}

export async function cancelGenerationJob(db: Db, jobId: string): Promise<GenerationJobRow | null> {
  const [row] = await db
    .update(generationJobs)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, 'queued')))
    .returning();
  return row ?? null;
}

/**
 * US-103 — compatibility adapter.
 *
 * Returns the legacy `MediaJobResult` shape so the existing `/internal/media/*`
 * endpoints keep their exact contract while running through the shared job
 * path. This is the seam that lets automated generation and the future Studio
 * share one execution path without a breaking API change.
 */
export async function submitAsMediaJobResult(
  db: Db,
  deps: MediaJobDeps,
  config: GenerationConfiguration,
  defaultModelId?: string,
): Promise<MediaJobResult> {
  const submitted = await submitGenerationJob(db, deps, config, { defaultModelId });

  if (!submitted.ok) {
    const first = submitted.errors[0];
    return {
      ok: false,
      jobId: '',
      // Configuration problems are the caller's fault, so they must surface as
      // 4xx rather than as a provider failure.
      error: {
        kind: first?.code === 'character_required' ? 'no_active_identity' : 'invalid_configuration',
        message: submitted.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
      },
    };
  }

  const { job, assets } = submitted.value;
  const asset = assets[0];
  if (!asset) {
    const failure = (job.failures as { kind?: string; message?: string }[])[0];
    return {
      ok: false,
      jobId: job.id,
      error: {
        kind: failure?.kind ?? 'unknown',
        message: failure?.message ?? 'generation produced no asset',
      },
    };
  }

  return {
    ok: true,
    jobId: job.id,
    asset,
    cost: {
      estimatedCostUsd: Number(job.estimatedCostUsd ?? 0),
      cumulativeUsd: Number(job.actualCostUsd ?? job.estimatedCostUsd ?? 0),
    },
  };
}
