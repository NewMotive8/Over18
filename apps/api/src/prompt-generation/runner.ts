import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  promptBatches,
  promptJobOutputs,
  promptJobs,
  type PromptJobOutputRow,
  type PromptJobRow,
} from '../db/schema.js';
import { createOutputRows } from './batches.js';
import { OUTPUT_EXTENSION, type GenerationParams } from './config.js';
import type { DriveFolderResolver } from './drive-folder.js';
import { DriveError, type GoogleDriveClient } from './google-drive-client.js';
import { XaiError, type XaiImageProvider } from './xai-image-provider.js';

/**
 * The runner: claim, generate, spool, upload, roll up.
 *
 * SHAPED AFTER THE EXISTING GENERATION MODULE, deliberately. The database is
 * the queue, rows are claimed with a conditional UPDATE that returns nothing to
 * the loser, and work is kicked off with `setImmediate` after the HTTP response
 * has already been sent. That is the mechanism `enqueueGenerationJob` uses, and
 * copying it means there is one asynchronous idiom in this codebase rather than
 * two.
 *
 * WHAT IS ADDED HERE THAT THE ORIGINAL LACKS: a boot recovery sweep that is
 * actually wired in. `recoverStaleJobs` exists in the generation module and is
 * called by nothing, so a crash strands rows in `running` forever. The
 * equivalent here runs at startup.
 *
 * THE ONE RULE THE WHOLE FILE SERVES: a completed output is never touched
 * again. Not by a restart, not by a page refresh, not by a retry of its
 * sibling, and not by a batch restart. Every claim is conditional on a status
 * that excludes `completed`.
 */

/** Attempts spent GENERATING one output before it is left failed. */
export const MAX_OUTPUT_GENERATION_ATTEMPTS = 3;
/** Attempts spent UPLOADING one already-generated output. */
export const MAX_OUTPUT_UPLOAD_ATTEMPTS = 5;
/** Times a job may be picked up by the recovery sweep before being abandoned. */
export const MAX_JOB_ATTEMPTS = 5;

export interface PromptRunnerDeps {
  xai: XaiImageProvider;
  drive: GoogleDriveClient;
  /** Root of the private spool. Never served, never linked, never public. */
  spoolDir: string;
  /**
   * Resolves the Drive destination when a batch does not already name one,
   * creating this application's own folder on first use.
   *
   * A RESOLVER RATHER THAN A STRING, because under `drive.file` the only
   * addressable folder is one we created — so the destination is discovered at
   * runtime and remembered, not configured ahead of time.
   */
  driveFolder: DriveFolderResolver;
  /** How many jobs may be in flight at once. */
  concurrency: number;
  now?: () => Date;
}

const nowOf = (deps: PromptRunnerDeps) => (deps.now ? deps.now() : new Date());

/** Structured, operator-readable, and never a raw provider payload. */
function errorPayload(error: unknown): { kind: string; message: string } {
  if (error instanceof XaiError) return { kind: `xai_${error.kind}`, message: error.message };
  if (error instanceof DriveError) return { kind: `drive_${error.kind}`, message: error.message };
  return { kind: 'unexpected', message: 'The job failed for an unexpected reason.' };
}

function spoolPathFor(spoolDir: string, jobId: string, ordinal: number): string {
  return join(spoolDir, jobId, `${ordinal}.${OUTPUT_EXTENSION}`);
}

/* ------------------------------------------------------------------ *
 * Batch control
 * ------------------------------------------------------------------ */

/**
 * Starts a batch and returns immediately.
 *
 * The HTTP caller gets a response before a single image is generated — a
 * 200-prompt batch must never be something a browser waits on.
 */
export async function startBatch(
  db: Db,
  deps: PromptRunnerDeps,
  batchId: string,
): Promise<{ started: boolean; reason?: string }> {
  const [batch] = await db
    .update(promptBatches)
    .set({ status: 'running', startedAt: sql`coalesce(${promptBatches.startedAt}, now())` })
    .where(and(eq(promptBatches.id, batchId), ne(promptBatches.status, 'running')))
    .returning();
  if (!batch) {
    const [current] = await db
      .select()
      .from(promptBatches)
      .where(eq(promptBatches.id, batchId))
      .limit(1);
    if (!current) return { started: false, reason: 'not_found' };
    // Already running is not an error — a double-clicked Start button, or a
    // page refresh, must be a no-op rather than a second run.
    return { started: false, reason: 'already_running' };
  }
  scheduleBatch(db, deps, batchId);
  return { started: true };
}

/**
 * Stops STARTING new work. In-flight generation is left alone.
 *
 * There is no safe way to cancel an image request that xAI has already been
 * paid for, so pausing does not pretend to: the jobs already claimed finish and
 * are saved, and nothing new is picked up.
 */
export async function pauseBatch(db: Db, batchId: string): Promise<boolean> {
  const updated = await db
    .update(promptBatches)
    .set({ status: 'paused' })
    .where(and(eq(promptBatches.id, batchId), eq(promptBatches.status, 'running')))
    .returning({ id: promptBatches.id });
  return updated.length > 0;
}

/** Fire-and-forget, exactly as `enqueueGenerationJob` does it. */
export function scheduleBatch(db: Db, deps: PromptRunnerDeps, batchId: string): void {
  setImmediate(() => {
    void runBatch(db, deps, batchId).catch(() => {
      // A background failure must never take the process down. Every job's
      // outcome is already a row; there is nothing to report to a caller that
      // has long since received its response.
    });
  });
}

/**
 * Drains a batch with a small pool of workers.
 *
 * Pool size is the concurrency limit; the rate limiter inside the xAI provider
 * is what keeps us under the provider's published requests-per-second. Two
 * separate limits because they solve different problems — see rate-limiter.ts.
 */
export async function runBatch(db: Db, deps: PromptRunnerDeps, batchId: string): Promise<void> {
  const workers = Array.from({ length: Math.max(1, deps.concurrency) }, async () => {
    for (;;) {
      const [batch] = await db
        .select({ status: promptBatches.status })
        .from(promptBatches)
        .where(eq(promptBatches.id, batchId))
        .limit(1);
      // Re-read every iteration so Pause takes effect within one job rather
      // than at the end of the batch.
      if (!batch || batch.status !== 'running') return;

      const job = await claimNextJob(db, batchId);
      if (!job) return;
      await executeJob(db, deps, job.id);
    }
  });
  await Promise.all(workers);
  await finaliseBatch(db, batchId);
}

/**
 * Claims one job.
 *
 * Candidates are read, then each is claimed with a CONDITIONAL UPDATE that
 * returns no row to a loser. This is the pattern the existing generation module
 * uses, and it is what makes two workers — or two processes — unable to run the
 * same prompt twice.
 */
async function claimNextJob(db: Db, batchId: string): Promise<PromptJobRow | null> {
  const candidates = await db
    .select({ id: promptJobs.id })
    .from(promptJobs)
    .where(and(eq(promptJobs.batchId, batchId), eq(promptJobs.status, 'queued')))
    .orderBy(asc(promptJobs.ordinal))
    .limit(10);

  for (const candidate of candidates) {
    const [claimed] = await db
      .update(promptJobs)
      .set({
        status: 'generating',
        startedAt: sql`coalesce(${promptJobs.startedAt}, now())`,
        attempts: sql`${promptJobs.attempts} + 1`,
      })
      .where(and(eq(promptJobs.id, candidate.id), eq(promptJobs.status, 'queued')))
      .returning();
    if (claimed) return claimed;
  }
  return null;
}

/** Marks a batch completed once nothing is left to start. */
async function finaliseBatch(db: Db, batchId: string): Promise<void> {
  const [remaining] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(promptJobs)
    .where(
      and(
        eq(promptJobs.batchId, batchId),
        inArray(promptJobs.status, ['queued', 'generating', 'uploading']),
      ),
    );
  if (Number(remaining?.total ?? 0) > 0) return;
  await db
    .update(promptBatches)
    .set({ status: 'completed', completedAt: new Date() })
    .where(and(eq(promptBatches.id, batchId), eq(promptBatches.status, 'running')));
}

/* ------------------------------------------------------------------ *
 * One job
 * ------------------------------------------------------------------ */

/**
 * Generates and uploads every outstanding output of one job.
 *
 * The job is a container; the OUTPUTS are the unit of work. A job is never
 * "regenerated" — outstanding outputs are, which is what makes retrying a
 * failed sibling leave a completed one untouched.
 */
export async function executeJob(db: Db, deps: PromptRunnerDeps, jobId: string): Promise<void> {
  const [job] = await db.select().from(promptJobs).where(eq(promptJobs.id, jobId)).limit(1);
  if (!job) return;

  const [batch] = await db
    .select()
    .from(promptBatches)
    .where(eq(promptBatches.id, job.batchId))
    .limit(1);
  if (!batch) return;

  // Self-healing: a job whose output rows are missing (an interrupted upload
  // request, say) gets them here rather than silently producing nothing.
  await createOutputRows(db, job.id, job.originalFilename, job.requestedOutputs);

  const params = batch.params as GenerationParams;
  /**
   * The batch's own recorded folder still wins, so a batch run last month is
   * explained by where its images actually went. Only a batch that never
   * recorded one asks the resolver — and that call is what creates the app's
   * folder the very first time anything is generated.
   */
  let folderId = batch.driveFolderId;
  if (!folderId) {
    try {
      folderId = (await deps.driveFolder.ensure()).folderId;
    } catch {
      // Resolution failed; leave it null. `uploadOne` records
      // `drive_not_configured` per output and the spooled image is kept.
      folderId = null;
    }
  }

  try {
    await generateOutstanding(db, deps, job, params);
    await uploadOutstanding(db, deps, job.id, folderId);
  } catch (error) {
    // A whole-job failure still leaves per-output rows intact and accurate;
    // the rollup below reads them rather than this error.
    await db
      .update(promptJobs)
      .set({ error: errorPayload(error) })
      .where(eq(promptJobs.id, job.id));
  }
  await rollUpJob(db, deps, job.id);
}

/**
 * Asks xAI for exactly the images this job is still missing.
 *
 * ONE REQUEST FOR ALL MISSING ORDINALS. Two images from one `n: 2` call rather
 * than two `n: 1` calls halves the pressure on a 6-requests-per-second budget
 * and costs exactly the same, since xAI prices per image.
 *
 * A SHORT RESPONSE IS NOT A FAILURE. If two are requested and one arrives, the
 * one is kept and only the missing ordinal is retried — the documented
 * possibility of fewer results is handled as a top-up, never as a discard.
 */
async function generateOutstanding(
  db: Db,
  deps: PromptRunnerDeps,
  job: PromptJobRow,
  params: GenerationParams,
): Promise<void> {
  const needing = await outputsNeedingGeneration(db, job.id);
  if (needing.length === 0) return;

  await db.update(promptJobs).set({ status: 'generating' }).where(eq(promptJobs.id, job.id));

  let images: { bytes: Buffer }[] = [];
  try {
    images = await deps.xai.generate({
      // The prompt is passed through untouched — no trim, no template, no
      // prefix. What the operator uploaded is what the provider receives.
      prompt: job.promptText,
      n: needing.length,
      params,
    });
  } catch (error) {
    const payload = errorPayload(error);
    for (const output of needing) {
      await failOutputGeneration(db, output, payload);
    }
    return;
  }

  for (let i = 0; i < needing.length; i += 1) {
    const output = needing[i]!;
    const image = images[i];
    if (!image) {
      // Fewer images than asked for. Recorded per ordinal so the top-up on the
      // next pass asks for exactly what is still missing.
      await failOutputGeneration(db, output, {
        kind: 'xai_short_response',
        message: 'The provider returned fewer images than requested.',
      });
      continue;
    }
    const path = spoolPathFor(deps.spoolDir, job.id, output.ordinal);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, image.bytes);
    await db
      .update(promptJobOutputs)
      .set({
        status: 'generated',
        spoolPath: path,
        generatedAt: nowOf(deps),
        error: null,
        attempts: sql`${promptJobOutputs.attempts} + 1`,
      })
      .where(eq(promptJobOutputs.id, output.id));
  }
}

async function failOutputGeneration(
  db: Db,
  output: PromptJobOutputRow,
  payload: { kind: string; message: string },
): Promise<void> {
  await db
    .update(promptJobOutputs)
    .set({
      status: 'failed',
      error: payload,
      attempts: sql`${promptJobOutputs.attempts} + 1`,
    })
    .where(eq(promptJobOutputs.id, output.id));
}

/**
 * Outputs that still need an image.
 *
 * `completed`, `generated`, `uploading` and `drive_upload_failed` are all
 * EXCLUDED, because each of those already has bytes. That exclusion is what
 * guarantees a Drive failure never costs a second generation.
 */
async function outputsNeedingGeneration(db: Db, jobId: string): Promise<PromptJobOutputRow[]> {
  const rows = await db
    .select()
    .from(promptJobOutputs)
    .where(
      and(
        eq(promptJobOutputs.jobId, jobId),
        inArray(promptJobOutputs.status, ['pending', 'failed']),
      ),
    )
    .orderBy(asc(promptJobOutputs.ordinal));
  return rows.filter((row) => row.attempts < MAX_OUTPUT_GENERATION_ATTEMPTS);
}

/**
 * Uploads every output that has bytes but no Drive file.
 *
 * Reads from the spool, so this path is reachable after a restart with no
 * provider call at all — the recovery story and the retry story are the same
 * code.
 */
async function uploadOutstanding(
  db: Db,
  deps: PromptRunnerDeps,
  jobId: string,
  folderId: string | null,
): Promise<void> {
  const pending = await db
    .select()
    .from(promptJobOutputs)
    .where(
      and(
        eq(promptJobOutputs.jobId, jobId),
        inArray(promptJobOutputs.status, ['generated', 'drive_upload_failed']),
      ),
    )
    .orderBy(asc(promptJobOutputs.ordinal));
  if (pending.length === 0) return;

  await db.update(promptJobs).set({ status: 'uploading' }).where(eq(promptJobs.id, jobId));

  for (const output of pending) {
    await uploadOne(db, deps, output, folderId);
  }
}

async function uploadOne(
  db: Db,
  deps: PromptRunnerDeps,
  output: PromptJobOutputRow,
  folderId: string | null,
): Promise<void> {
  if (output.attempts >= MAX_OUTPUT_UPLOAD_ATTEMPTS + MAX_OUTPUT_GENERATION_ATTEMPTS) return;
  if (!folderId) {
    await db
      .update(promptJobOutputs)
      .set({
        status: 'drive_upload_failed',
        error: {
          kind: 'drive_not_configured',
          message: 'No Google Drive destination folder is configured.',
        },
      })
      .where(eq(promptJobOutputs.id, output.id));
    return;
  }
  if (!output.spoolPath) {
    await db
      .update(promptJobOutputs)
      .set({
        status: 'failed',
        error: { kind: 'spool_missing', message: 'The generated image is no longer on disk.' },
      })
      .where(eq(promptJobOutputs.id, output.id));
    return;
  }

  // Conditional claim, so two workers cannot upload the same image twice and
  // leave a duplicate in the operator's Drive.
  const [claimed] = await db
    .update(promptJobOutputs)
    .set({ status: 'uploading' })
    .where(
      and(
        eq(promptJobOutputs.id, output.id),
        inArray(promptJobOutputs.status, ['generated', 'drive_upload_failed']),
      ),
    )
    .returning();
  if (!claimed) return;

  let bytes: Buffer;
  try {
    bytes = await readFile(output.spoolPath);
  } catch {
    await db
      .update(promptJobOutputs)
      .set({
        status: 'failed',
        error: { kind: 'spool_missing', message: 'The generated image is no longer on disk.' },
      })
      .where(eq(promptJobOutputs.id, output.id));
    return;
  }

  try {
    const result = await deps.drive.upload({
      filename: output.outputFilename,
      mimeType: 'image/jpeg',
      bytes,
      folderId,
    });
    await db
      .update(promptJobOutputs)
      .set({
        status: 'completed',
        driveFileId: result.fileId,
        driveWebViewLink: result.webViewLink,
        uploadedAt: nowOf(deps),
        error: null,
        spoolPath: null,
      })
      .where(eq(promptJobOutputs.id, output.id));
    // The spool copy is removed only AFTER the row records a Drive id, so a
    // crash between the two leaves a re-uploadable file rather than nothing.
    await rm(output.spoolPath, { force: true }).catch(() => {});
  } catch (error) {
    /**
     * THE IMAGE IS NOT LOST. It stays in the spool and the row goes to
     * `drive_upload_failed`, which the retry path treats as "upload this",
     * never as "generate this". A paid image is never thrown away because a
     * Google request failed.
     */
    await db
      .update(promptJobOutputs)
      .set({
        status: 'drive_upload_failed',
        error: errorPayload(error),
        attempts: sql`${promptJobOutputs.attempts} + 1`,
      })
      .where(eq(promptJobOutputs.id, output.id));
  }
}

/**
 * Writes the job's rollup from its outputs.
 *
 * `partial` when some succeeded and some did not — the state that exists so a
 * half-successful job never reads as a failure and never invites a retry of the
 * half that worked.
 */
export async function rollUpJob(db: Db, deps: PromptRunnerDeps, jobId: string): Promise<void> {
  const outputs = await db
    .select()
    .from(promptJobOutputs)
    .where(eq(promptJobOutputs.jobId, jobId));
  const succeeded = outputs.filter((o) => o.status === 'completed').length;
  const failed = outputs.filter(
    (o) => o.status === 'failed' || o.status === 'drive_upload_failed',
  ).length;
  const inFlight = outputs.filter(
    (o) => o.status === 'pending' || o.status === 'generated' || o.status === 'uploading',
  ).length;

  let status: 'generating' | 'uploading' | 'completed' | 'partial' | 'failed';
  if (inFlight > 0) status = 'uploading';
  else if (failed === 0 && succeeded > 0) status = 'completed';
  else if (succeeded > 0) status = 'partial';
  else status = 'failed';

  await db
    .update(promptJobs)
    .set({
      status,
      succeededCount: succeeded,
      failedCount: failed,
      completedAt: inFlight > 0 ? null : nowOf(deps),
    })
    .where(eq(promptJobs.id, jobId));
}

/* ------------------------------------------------------------------ *
 * Retries
 * ------------------------------------------------------------------ */

export type RetryOutcome = { ok: true } | { ok: false; reason: string; message: string };

/**
 * Retries ONE output.
 *
 * The distinction that matters: an output holding spooled bytes is
 * RE-UPLOADED, and an output with none is RE-GENERATED. A completed output is
 * refused outright — there is nothing to retry and re-running it would create a
 * duplicate file in Drive.
 */
export async function retryOutput(
  db: Db,
  deps: PromptRunnerDeps,
  outputId: string,
): Promise<RetryOutcome> {
  const [output] = await db
    .select()
    .from(promptJobOutputs)
    .where(eq(promptJobOutputs.id, outputId))
    .limit(1);
  if (!output) return { ok: false, reason: 'not_found', message: 'That output no longer exists.' };
  if (output.status === 'completed') {
    return {
      ok: false,
      reason: 'already_completed',
      message: 'That image is already in Drive. Retrying would upload a duplicate.',
    };
  }
  if (output.status === 'uploading') {
    return { ok: false, reason: 'in_flight', message: 'That image is being uploaded right now.' };
  }

  const [job] = await db.select().from(promptJobs).where(eq(promptJobs.id, output.jobId)).limit(1);
  if (!job) return { ok: false, reason: 'not_found', message: 'That job no longer exists.' };

  // Reset the attempt budget for this ONE output. A deliberate operator action
  // is allowed to spend another attempt; an automatic sweep is not.
  await db
    .update(promptJobOutputs)
    .set({
      status: output.spoolPath ? 'drive_upload_failed' : 'pending',
      attempts: 0,
      error: null,
    })
    .where(eq(promptJobOutputs.id, outputId));

  scheduleJob(db, deps, job.id);
  return { ok: true };
}

/** Retries every non-completed output of one job. Completed ones are untouched. */
export async function retryJob(
  db: Db,
  deps: PromptRunnerDeps,
  jobId: string,
): Promise<RetryOutcome> {
  const [job] = await db.select().from(promptJobs).where(eq(promptJobs.id, jobId)).limit(1);
  if (!job) return { ok: false, reason: 'not_found', message: 'That job no longer exists.' };

  const outputs = await db
    .select()
    .from(promptJobOutputs)
    .where(
      and(eq(promptJobOutputs.jobId, jobId), ne(promptJobOutputs.status, 'completed')),
    );
  if (outputs.length === 0) {
    return { ok: false, reason: 'nothing_to_retry', message: 'Every image for this prompt is already in Drive.' };
  }
  for (const output of outputs) {
    await db
      .update(promptJobOutputs)
      .set({
        status: output.spoolPath ? 'drive_upload_failed' : 'pending',
        attempts: 0,
        error: null,
      })
      .where(eq(promptJobOutputs.id, output.id));
  }
  await db
    .update(promptJobs)
    .set({ status: 'queued', attempts: 0, error: null, completedAt: null })
    .where(eq(promptJobs.id, jobId));
  scheduleJob(db, deps, jobId);
  return { ok: true };
}

/** Retries every job in a batch that is not fully completed. */
export async function retryFailedInBatch(
  db: Db,
  deps: PromptRunnerDeps,
  batchId: string,
): Promise<{ retried: number }> {
  const jobs = await db
    .select({ id: promptJobs.id })
    .from(promptJobs)
    .where(
      and(
        eq(promptJobs.batchId, batchId),
        inArray(promptJobs.status, ['failed', 'partial']),
      ),
    );
  let retried = 0;
  for (const job of jobs) {
    const outcome = await retryJob(db, deps, job.id);
    if (outcome.ok) retried += 1;
  }
  if (retried > 0) {
    await db
      .update(promptBatches)
      .set({ status: 'running', completedAt: null })
      .where(eq(promptBatches.id, batchId));
    scheduleBatch(db, deps, batchId);
  }
  return { retried };
}

/** Runs one job in the background, outside a batch drain. */
export function scheduleJob(db: Db, deps: PromptRunnerDeps, jobId: string): void {
  setImmediate(() => {
    void executeJob(db, deps, jobId).catch(() => {});
  });
}

/* ------------------------------------------------------------------ *
 * Restart recovery
 * ------------------------------------------------------------------ */

export interface RecoverySummary {
  requeuedJobs: number;
  requeuedUploads: number;
  abandonedJobs: number;
}

/**
 * Called ONCE at boot, before the server accepts traffic.
 *
 * A restart mid-batch leaves rows mid-flight. This sweep is what makes that
 * survivable, and it is careful about three things:
 *
 *   COMPLETED OUTPUTS ARE NEVER TOUCHED. Every statement excludes them, so an
 *   image already in Drive is never regenerated and never re-uploaded.
 *
 *   GENERATED-BUT-NOT-UPLOADED OUTPUTS GO BACK TO THE UPLOAD PATH, not the
 *   generation path. The bytes are on disk and have already been paid for.
 *
 *   A JOB THAT HAS BEEN RECOVERED TOO OFTEN IS ABANDONED rather than retried
 *   forever. A row that crashes the process every time it runs would otherwise
 *   turn a restart into a loop.
 */
export async function recoverInterruptedPromptJobs(
  db: Db,
  deps: PromptRunnerDeps,
): Promise<RecoverySummary> {
  // 1. Outputs caught mid-upload. The spool still holds the image.
  const uploads = await db
    .update(promptJobOutputs)
    .set({ status: 'drive_upload_failed' })
    .where(
      and(
        eq(promptJobOutputs.status, 'uploading'),
        sql`${promptJobOutputs.spoolPath} is not null`,
      ),
    )
    .returning({ id: promptJobOutputs.id });

  // 2. An 'uploading' row with no spool file cannot be recovered by uploading.
  await db
    .update(promptJobOutputs)
    .set({
      status: 'failed',
      error: { kind: 'spool_missing', message: 'The generated image was lost in a restart.' },
    })
    .where(
      and(eq(promptJobOutputs.status, 'uploading'), sql`${promptJobOutputs.spoolPath} is null`),
    );

  // 3. Jobs that were mid-flight go back on the queue, bounded by attempts.
  const requeued = await db
    .update(promptJobs)
    .set({ status: 'queued' })
    .where(
      and(
        inArray(promptJobs.status, ['generating', 'uploading']),
        sql`${promptJobs.attempts} < ${MAX_JOB_ATTEMPTS}`,
      ),
    )
    .returning({ id: promptJobs.id, batchId: promptJobs.batchId });

  const abandoned = await db
    .update(promptJobs)
    .set({
      status: 'failed',
      error: {
        kind: 'abandoned',
        message: 'This prompt was interrupted too many times and was not retried again.',
      },
      completedAt: new Date(),
    })
    .where(
      and(
        inArray(promptJobs.status, ['generating', 'uploading']),
        sql`${promptJobs.attempts} >= ${MAX_JOB_ATTEMPTS}`,
      ),
    )
    .returning({ id: promptJobs.id });

  // 4. Resume the batches that still have work, and only those.
  const running = await db
    .select({ id: promptBatches.id })
    .from(promptBatches)
    .where(eq(promptBatches.status, 'running'));
  for (const batch of running) {
    scheduleBatch(db, deps, batch.id);
  }

  return {
    requeuedJobs: requeued.length,
    requeuedUploads: uploads.length,
    abandonedJobs: abandoned.length,
  };
}
