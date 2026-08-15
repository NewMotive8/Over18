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

import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  generationJobs,
  generationResults,
  type CharacterVisualAssetRow,
  type GenerationJobRow,
  type GenerationResultRow,
} from '../db/schema.js';
import type { MediaJobDeps, MediaJobResult } from '../services/media-generation-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import type {
  EffectiveGenerationConfiguration,
  GenerationConfigError,
  GenerationConfiguration,
} from './config.js';
import { resolveGenerationConfiguration } from './resolve.js';
import {
  createResultRows,
  executeResult,
  getResult,
  listResults,
  MAX_RESULT_ATTEMPTS,
  pendingResults,
} from './results.js';

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

  // Result rows exist BEFORE execution, so every expected output has an
  // identity from the moment the job is created.
  await createResultRows(db, row.id, effective.quantity);

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
  let rows = await listResults(db, jobId);
  // Jobs created before generation_results existed have no rows; backfill so
  // the runtime has one code path.
  if (rows.length === 0) rows = await createResultRows(db, jobId, job.requestedQuantity);

  const outstanding = pendingResults(rows).filter((r) => r.attempts < MAX_RESULT_ATTEMPTS);

  // ATOMIC CLAIM: only one process can move this job out of a non-running
  // state. The loser gets no row back and returns without executing.
  const [claimedJob] = await db
    .update(generationJobs)
    .set({ status: 'running' })
    .where(and(eq(generationJobs.id, jobId), ne(generationJobs.status, 'running')))
    .returning();
  if (!claimedJob) return null;

  const assets: CharacterVisualAssetRow[] = [];
  let costUsd = Number(job.estimatedCostUsd ?? 0);

  // Sequential on purpose: the CostLedger is file-backed, so parallel
  // authorize+record would race and could corrupt budget accounting.
  for (const row of outstanding) {
    const outcome = await executeResult(db, deps, effective, row);
    // Another process had already claimed this result — skip, never double-pay.
    if (!outcome.claimed) continue;
    if (outcome.asset) assets.push(outcome.asset);
    costUsd += outcome.estimatedCostUsd;

    await syncJobCounts(db, jobId, costUsd);
    // A refused budget is terminal for the run; remaining results stay pending
    // rather than being burned through a wall of guaranteed refusals.
    if (outcome.budgetRefused) break;
  }

  const finalRows = await listResults(db, jobId);
  const [updated] = await db
    .update(generationJobs)
    .set({
      status: terminalStatusFor(finalRows),
      succeededCount: finalRows.filter((r) => r.status === 'succeeded').length,
      failedCount: finalRows.filter((r) => r.status === 'failed').length,
      estimatedCostUsd: String(costUsd),
      actualCostUsd: String(costUsd),
      completedAt: new Date(),
    })
    .where(eq(generationJobs.id, jobId))
    .returning();

  return { job: updated, assets };
}

async function syncJobCounts(db: Db, jobId: string, costUsd: number): Promise<void> {
  const rows = await listResults(db, jobId);
  await db
    .update(generationJobs)
    .set({
      succeededCount: rows.filter((r) => r.status === 'succeeded').length,
      failedCount: rows.filter((r) => r.status === 'failed').length,
      estimatedCostUsd: String(costUsd),
    })
    .where(eq(generationJobs.id, jobId));
}

function terminalStatusFor(
  rows: readonly GenerationResultRow[],
): 'completed' | 'partial' | 'failed' {
  const succeeded = rows.filter((r) => r.status === 'succeeded').length;
  if (succeeded === rows.length) return 'completed';
  if (succeeded > 0) return 'partial';
  return 'failed';
}

/**
 * US-103 async contract: persist the job, hand back the id immediately, and run
 * it in the background. The HTTP caller does not wait for a 10-video job.
 *
 * SMALLEST DURABLE MECHANISM for this PoC, chosen because the repository has no
 * queue, worker, broker or scheduler of any kind: the database IS the queue.
 * The job row is durable before execution starts, progress is written per
 * result, and `recoverStaleJobs` re-queues anything left `running` by a crash.
 *
 * Honest limitation: execution is in-process, so it is single-instance only.
 * Running two API instances would need a real worker — that is a deliberate
 * follow-up, not an oversight.
 */
export async function enqueueGenerationJob(
  db: Db,
  deps: MediaJobDeps,
  config: GenerationConfiguration,
  options: CreateJobOptions = {},
): Promise<JobResult<GenerationJobRow>> {
  const created = await createGenerationJob(db, config, options);
  if (!created.ok) return created;

  setImmediate(() => {
    void executeGenerationJob(db, deps, created.value.id).catch(() => {
      // Never let a background failure take the process down; the job row and
      // its result rows already record what happened.
    });
  });

  return { ok: true, value: created.value };
}

/**
 * Re-queue jobs left `running` by a crash or restart. Their result rows are
 * intact, so re-execution resumes only the outstanding ones.
 */
export async function recoverStaleJobs(db: Db): Promise<GenerationJobRow[]> {
  const stale = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.status, 'running'));
  if (stale.length === 0) return [];
  await db
    .update(generationJobs)
    .set({ status: 'queued' })
    .where(eq(generationJobs.status, 'running'));
  // Results left mid-flight are returned to 'pending' so they are eligible
  // again; the atomic claim above still guarantees only one process picks
  // each one up.
  for (const job of stale) {
    await db
      .update(generationResults)
      .set({ status: 'pending' })
      .where(and(eq(generationResults.jobId, job.id), eq(generationResults.status, 'running')));
  }
  return stale;
}

/**
 * Retry ONE result. Regenerates exactly that output and touches no other.
 */
export async function retryGenerationResult(
  db: Db,
  deps: MediaJobDeps,
  resultId: string,
): Promise<JobResult<{ result: GenerationResultRow; asset: CharacterVisualAssetRow | null }>> {
  const result = await getResult(db, resultId);
  if (!result) {
    return { ok: false, errors: [{ code: 'unknown_model', field: 'resultId', message: 'result not found' }] };
  }
  if (result.status === 'succeeded') {
    return {
      ok: false,
      errors: [
        { code: 'invalid_quantity', field: 'resultId', message: 'result already succeeded; nothing to retry' },
      ],
    };
  }
  if (result.attempts >= MAX_RESULT_ATTEMPTS) {
    return {
      ok: false,
      errors: [
        {
          code: 'invalid_quantity',
          field: 'resultId',
          message: `attempt limit of ${MAX_RESULT_ATTEMPTS} reached for this result`,
        },
      ],
    };
  }

  const job = await getGenerationJob(db, result.jobId);
  if (!job) {
    return { ok: false, errors: [{ code: 'unknown_model', field: 'jobId', message: 'job not found' }] };
  }

  const outcome = await executeResult(
    db,
    deps,
    job.effectiveConfig as EffectiveGenerationConfiguration,
    result,
  );

  const rows = await listResults(db, job.id);
  const cost = Number(job.estimatedCostUsd ?? 0) + outcome.estimatedCostUsd;
  await db
    .update(generationJobs)
    .set({
      status: terminalStatusFor(rows),
      succeededCount: rows.filter((r) => r.status === 'succeeded').length,
      failedCount: rows.filter((r) => r.status === 'failed').length,
      estimatedCostUsd: String(cost),
      actualCostUsd: String(cost),
      retryCount: job.retryCount + 1,
    })
    .where(eq(generationJobs.id, job.id));

  return { ok: true, value: { result: outcome.result, asset: outcome.asset } };
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
    // Failure detail lives on the RESULT row now, which is what preserves the
    // provider error kind (and therefore the 4xx/5xx distinction) end to end.
    const rows = await listResults(db, job.id);
    const failed = rows.find((r) => r.status === 'failed');
    const failure = (failed?.error ?? null) as { kind?: string; message?: string } | null;
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
