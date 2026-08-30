import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { promptBatches, promptJobOutputs, promptJobs } from '../db/schema.js';
import {
  DEFAULT_MODEL,
  DEFAULT_PARAMS,
  MAX_OUTPUTS_PER_PROMPT,
  OUTPUTS_PER_PROMPT,
  estimateCost,
  outputFilename,
  readPromptFile,
  rejectionMessage,
  type CostEstimate,
  type GenerationParams,
  type PromptFileInput,
  type PromptFileRejection,
} from './config.js';

/**
 * Batch creation and .txt ingestion.
 *
 * NO PROVIDER IS REACHED FROM THIS FILE. Uploading prompts costs nothing and
 * starts nothing; a batch sits in `draft` until an operator has seen the cost
 * estimate and pressed Start. That separation is the whole reason a large paid
 * batch cannot begin by accident.
 */

export interface CreateBatchInput {
  name: string;
  params?: Partial<GenerationParams>;
  outputsPerPrompt?: number;
  driveFolderId?: string | null;
  createdBy?: string;
}

export async function createBatch(db: Db, input: CreateBatchInput) {
  const params: GenerationParams = { ...DEFAULT_PARAMS, ...(input.params ?? {}) };
  const outputs = clampOutputs(input.outputsPerPrompt);
  const [row] = await db
    .insert(promptBatches)
    .values({
      name: input.name.trim().length > 0 ? input.name.trim() : defaultBatchName(),
      model: DEFAULT_MODEL,
      params,
      outputsPerPrompt: outputs,
      driveFolderId: input.driveFolderId ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row!;
}

/**
 * V1 fixes this at 2, but the value is carried rather than assumed everywhere
 * downstream. Clamping instead of rejecting keeps a future UI honest: an
 * out-of-range number becomes the nearest legal one rather than a 500.
 */
function clampOutputs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return OUTPUTS_PER_PROMPT;
  return Math.min(MAX_OUTPUTS_PER_PROMPT, Math.max(1, Math.floor(requested)));
}

function defaultBatchName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Batch ${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
}

export interface IngestOutcome {
  filename: string;
  accepted: boolean;
  reason?: PromptFileRejection;
  message?: string;
  jobId?: string;
}

/**
 * Adds uploaded .txt files to a batch, one job per file.
 *
 * PARTIAL SUCCESS IS THE CONTRACT, as it is for category assignment: dropping
 * forty good prompts because one file was a .png would be the wrong answer.
 * Every filename comes back with what happened to it.
 *
 * Duplicates are refused WITHIN A BATCH ONLY. The unique index on
 * `(batch_id, original_filename)` is the real enforcement — this check is the
 * friendly half, and the index is what holds under a double-submitted form.
 * The same filename in a different batch is explicitly allowed: re-running a
 * prompt set later is normal.
 */
export async function addPromptFiles(
  db: Db,
  batchId: string,
  files: PromptFileInput[],
): Promise<IngestOutcome[]> {
  if (files.length === 0) return [];

  const [batch] = await db
    .select()
    .from(promptBatches)
    .where(eq(promptBatches.id, batchId))
    .limit(1);
  if (!batch) return files.map((f) => ({ filename: f.filename, accepted: false, reason: 'not_txt', message: 'That batch no longer exists.' }));

  const existing = await db
    .select({ filename: promptJobs.originalFilename, ordinal: promptJobs.ordinal })
    .from(promptJobs)
    .where(eq(promptJobs.batchId, batchId));
  const taken = new Set(existing.map((r) => r.filename));
  let nextOrdinal = existing.reduce((max, r) => Math.max(max, r.ordinal), 0) + 1;

  const outcomes: IngestOutcome[] = [];
  for (const file of files) {
    const parsed = readPromptFile(file);
    if (!parsed.accepted) {
      outcomes.push({
        filename: file.filename,
        accepted: false,
        reason: parsed.reason,
        message: rejectionMessage(parsed.reason),
      });
      continue;
    }
    if (taken.has(file.filename)) {
      outcomes.push({
        filename: file.filename,
        accepted: false,
        reason: 'duplicate_in_batch',
        message: rejectionMessage('duplicate_in_batch'),
      });
      continue;
    }

    const [job] = await db
      .insert(promptJobs)
      .values({
        batchId,
        ordinal: nextOrdinal,
        originalFilename: file.filename,
        // Stored EXACTLY as read. Nothing between the file and this column.
        promptText: parsed.promptText,
        requestedOutputs: batch.outputsPerPrompt,
      })
      .onConflictDoNothing()
      .returning();

    if (!job) {
      // The unique index refused it — another request added the same name
      // between our read and this insert.
      outcomes.push({
        filename: file.filename,
        accepted: false,
        reason: 'duplicate_in_batch',
        message: rejectionMessage('duplicate_in_batch'),
      });
      continue;
    }

    await createOutputRows(db, job.id, file.filename, batch.outputsPerPrompt);
    taken.add(file.filename);
    nextOrdinal += 1;
    outcomes.push({ filename: file.filename, accepted: true, jobId: job.id });
  }
  return outcomes;
}

/**
 * Creates the placeholder output rows up front, one per ordinal.
 *
 * EXISTING BEFORE ANY GENERATION RUNS is what makes the queue honest: the UI
 * can show `0/2` immediately, a restart finds the same rows, and the unique
 * `(job_id, ordinal)` index means no path can ever create a third.
 */
export async function createOutputRows(
  db: Db,
  jobId: string,
  originalFilename: string,
  count: number,
): Promise<void> {
  const rows = Array.from({ length: count }, (_unused, index) => ({
    jobId,
    ordinal: index + 1,
    outputFilename: outputFilename(originalFilename, index + 1),
  }));
  if (rows.length === 0) return;
  await db.insert(promptJobOutputs).values(rows).onConflictDoNothing();
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export interface OutputView {
  id: string;
  ordinal: number;
  status: string;
  outputFilename: string;
  driveFileId: string | null;
  driveWebViewLink: string | null;
  attempts: number;
  error: { kind: string; message: string } | null;
  generatedAt: string | null;
  uploadedAt: string | null;
}

export interface JobView {
  id: string;
  ordinal: number;
  originalFilename: string;
  status: string;
  requestedOutputs: number;
  succeededCount: number;
  failedCount: number;
  attempts: number;
  error: { kind: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  outputs: OutputView[];
}

export interface BatchView {
  id: string;
  name: string;
  status: string;
  model: string;
  params: GenerationParams;
  outputsPerPrompt: number;
  driveFolderId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  totals: { prompts: number; outputs: number; completed: number; failed: number };
  estimate: CostEstimate;
}

/**
 * The batch list. Counts come from one grouped query per table rather than a
 * correlated subquery — this codebase has already been bitten once by Drizzle
 * binding a bare `id` inside a correlated subquery to the wrong table.
 */
export async function listBatches(db: Db): Promise<BatchView[]> {
  const batches = await db.select().from(promptBatches).orderBy(sql`${promptBatches.createdAt} desc`);
  if (batches.length === 0) return [];
  const ids = batches.map((b) => b.id);

  const jobCounts = await db
    .select({ batchId: promptJobs.batchId, total: sql<number>`count(*)::int` })
    .from(promptJobs)
    .where(inArray(promptJobs.batchId, ids))
    .groupBy(promptJobs.batchId);
  const jobsByBatch = new Map(jobCounts.map((r) => [r.batchId, Number(r.total)]));

  const outputCounts = await db
    .select({
      batchId: promptJobs.batchId,
      status: promptJobOutputs.status,
      total: sql<number>`count(*)::int`,
    })
    .from(promptJobOutputs)
    .innerJoin(promptJobs, eq(promptJobs.id, promptJobOutputs.jobId))
    .where(inArray(promptJobs.batchId, ids))
    .groupBy(promptJobs.batchId, promptJobOutputs.status);

  const outputs = new Map<string, { total: number; completed: number; failed: number }>();
  for (const row of outputCounts) {
    const entry = outputs.get(row.batchId) ?? { total: 0, completed: 0, failed: 0 };
    const n = Number(row.total);
    entry.total += n;
    if (row.status === 'completed') entry.completed += n;
    if (row.status === 'failed' || row.status === 'drive_upload_failed') entry.failed += n;
    outputs.set(row.batchId, entry);
  }

  return batches.map((batch) => {
    const prompts = jobsByBatch.get(batch.id) ?? 0;
    const o = outputs.get(batch.id) ?? { total: 0, completed: 0, failed: 0 };
    const params = batch.params as GenerationParams;
    return {
      id: batch.id,
      name: batch.name,
      status: batch.status,
      model: batch.model,
      params,
      outputsPerPrompt: batch.outputsPerPrompt,
      driveFolderId: batch.driveFolderId,
      createdAt: batch.createdAt.toISOString(),
      startedAt: batch.startedAt?.toISOString() ?? null,
      completedAt: batch.completedAt?.toISOString() ?? null,
      totals: { prompts, outputs: o.total, completed: o.completed, failed: o.failed },
      estimate: estimateCost(prompts, batch.outputsPerPrompt, params),
    };
  });
}

/** One batch with every job and every output. What the queue table renders. */
export async function getBatchDetail(
  db: Db,
  batchId: string,
): Promise<(BatchView & { jobs: JobView[] }) | null> {
  const [batch] = await db
    .select()
    .from(promptBatches)
    .where(eq(promptBatches.id, batchId))
    .limit(1);
  if (!batch) return null;

  const jobs = await db
    .select()
    .from(promptJobs)
    .where(eq(promptJobs.batchId, batchId))
    .orderBy(asc(promptJobs.ordinal));

  const outputs =
    jobs.length === 0
      ? []
      : await db
          .select()
          .from(promptJobOutputs)
          .where(
            inArray(
              promptJobOutputs.jobId,
              jobs.map((j) => j.id),
            ),
          )
          .orderBy(asc(promptJobOutputs.ordinal));

  const byJob = new Map<string, OutputView[]>();
  let completed = 0;
  let failed = 0;
  for (const output of outputs) {
    if (output.status === 'completed') completed += 1;
    if (output.status === 'failed' || output.status === 'drive_upload_failed') failed += 1;
    const list = byJob.get(output.jobId) ?? [];
    list.push({
      id: output.id,
      ordinal: output.ordinal,
      status: output.status,
      outputFilename: output.outputFilename,
      driveFileId: output.driveFileId,
      driveWebViewLink: output.driveWebViewLink,
      attempts: output.attempts,
      error: (output.error as { kind: string; message: string } | null) ?? null,
      generatedAt: output.generatedAt?.toISOString() ?? null,
      uploadedAt: output.uploadedAt?.toISOString() ?? null,
      // NOTE: `spoolPath` is deliberately absent. It is a server filesystem
      // path, and no view in this feature may carry one to a browser.
    });
    byJob.set(output.jobId, list);
  }

  const params = batch.params as GenerationParams;
  return {
    id: batch.id,
    name: batch.name,
    status: batch.status,
    model: batch.model,
    params,
    outputsPerPrompt: batch.outputsPerPrompt,
    driveFolderId: batch.driveFolderId,
    createdAt: batch.createdAt.toISOString(),
    startedAt: batch.startedAt?.toISOString() ?? null,
    completedAt: batch.completedAt?.toISOString() ?? null,
    totals: { prompts: jobs.length, outputs: outputs.length, completed, failed },
    estimate: estimateCost(jobs.length, batch.outputsPerPrompt, params),
    jobs: jobs.map((job) => ({
      id: job.id,
      ordinal: job.ordinal,
      originalFilename: job.originalFilename,
      status: job.status,
      requestedOutputs: job.requestedOutputs,
      succeededCount: job.succeededCount,
      failedCount: job.failedCount,
      attempts: job.attempts,
      error: (job.error as { kind: string; message: string } | null) ?? null,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      outputs: byJob.get(job.id) ?? [],
    })),
  };
}

/** Deletes a draft batch and its jobs. Only ever a draft — never a run one. */
export async function deleteDraftBatch(db: Db, batchId: string): Promise<boolean> {
  const deleted = await db
    .delete(promptBatches)
    .where(and(eq(promptBatches.id, batchId), eq(promptBatches.status, 'draft')))
    .returning({ id: promptBatches.id });
  return deleted.length > 0;
}
