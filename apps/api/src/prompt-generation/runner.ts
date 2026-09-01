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

/**
 * The statuses a job may be claimed FROM.
 *
 * `generating` and `uploading` are absent, and that absence IS the mutual
 * exclusion: a job already being executed cannot be claimed again, so it can
 * never have two executions running at once. `cancelled` is absent too, because
 * a cancelled job must stay cancelled until an operator deliberately retries it
 * (which puts it back to `queued` first).
 */
const CLAIMABLE_JOB_STATUSES = ['queued', 'completed', 'partial', 'failed'] as const;

/**
 * Said in one place because it is said from three, and it has to promise the
 * same thing every time: the bytes are gone, so this one must be made again.
 */
const SPOOL_MISSING_MESSAGE =
  'The generated image is no longer on disk, so it has to be generated again.';

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

      // Already claimed by `claimNextJob`, so it runs directly rather than
      // through `executeJob` — claiming twice would refuse its own claim.
      const job = await claimNextJob(db, batchId);
      if (!job) return;
      await runClaimedJob(db, deps, job);
    }
  });
  await Promise.all(workers);
  await finaliseBatch(db, batchId);
}

/**
 * Claims ONE job by id, or returns null because somebody else already has it.
 *
 * THE SINGLE GATE. Every path that runs a job — the batch drain, a retry of a
 * job, a retry of one output, the boot recovery sweep — goes through this one
 * conditional UPDATE, and the database decides the winner. A loser gets no row
 * back and does no work.
 *
 * WHY THIS HAD TO BECOME THE ONLY ENTRY POINT. `executeJob` used to run
 * whatever it was handed without claiming anything, while only the batch drain
 * claimed. So a retry that both scheduled the job directly AND restarted the
 * batch drain produced two concurrent executions of the same job; both read the
 * same `pending` outputs, and both called xAI for them. The images were paid
 * for twice and one set was overwritten in the spool.
 */
async function claimJob(db: Db, jobId: string): Promise<PromptJobRow | null> {
  const [claimed] = await db
    .update(promptJobs)
    .set({
      status: 'generating',
      startedAt: sql`coalesce(${promptJobs.startedAt}, now())`,
      attempts: sql`${promptJobs.attempts} + 1`,
    })
    .where(and(eq(promptJobs.id, jobId), inArray(promptJobs.status, CLAIMABLE_JOB_STATUSES)))
    .returning();
  return claimed ?? null;
}

/**
 * Claims the next queued job of a batch.
 *
 * Candidates are read, then each is claimed through `claimJob`, which returns
 * no row to a loser. This is the pattern the existing generation module uses,
 * and it is what makes two workers — or two processes — unable to run the same
 * prompt twice.
 */
async function claimNextJob(db: Db, batchId: string): Promise<PromptJobRow | null> {
  const candidates = await db
    .select({ id: promptJobs.id })
    .from(promptJobs)
    .where(and(eq(promptJobs.batchId, batchId), eq(promptJobs.status, 'queued')))
    .orderBy(asc(promptJobs.ordinal))
    .limit(10);

  for (const candidate of candidates) {
    const claimed = await claimJob(db, candidate.id);
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
  /**
   * CLAIM FIRST, ALWAYS. Returning here is the correct outcome, not a failure:
   * it means another execution of this job is already in flight and will finish
   * the work. This is what makes scheduling idempotent — a job scheduled twice
   * runs once.
   */
  const job = await claimJob(db, jobId);
  if (!job) return;
  await runClaimedJob(db, deps, job);
}

/**
 * Runs a job that the caller has ALREADY claimed.
 *
 * Never call this with an unclaimed job: the claim is the only thing standing
 * between a double-scheduled retry and a double xAI bill.
 */
async function runClaimedJob(db: Db, deps: PromptRunnerDeps, job: PromptJobRow): Promise<void> {
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
  /**
   * WHY THE ERROR IS KEPT RATHER THAN DROPPED.
   *
   * This `catch` used to be bare. Resolution failing therefore looked
   * identical to Drive never having been configured, because `uploadOne`'s
   * no-folder branch reports a fixed sentence — and that sentence is the same
   * string this feature used before a resolver existed at all. Production
   * consequently reported "No Google Drive destination folder is configured"
   * while the truth was that a folder HAD been asked for and Google had
   * refused, and an operator reading it went looking for a missing setting
   * that was already correct.
   *
   * `errorPayload` renders a `DriveError` as `drive_<kind>` plus its message,
   * and those messages are credential-free by construction: the token exchange
   * never reads its response body precisely because that body echoes the
   * client id and sometimes the refresh token, while Drive's own errors
   * describe a file. So the reason can be recorded without any risk of
   * carrying a secret with it.
   */
  let folderError: unknown = null;
  if (!folderId) {
    try {
      folderId = (await deps.driveFolder.ensure()).folderId;
    } catch (error) {
      folderError = error;
      folderId = null;
      /**
       * THE KIND AND THE SANITISED REASON — never a raw provider body.
       *
       * Every message that can arrive here is built by the Drive client from
       * an allowlist: for a token failure, only Google's `error` and
       * `error_description`, each character-classed and swept for the
       * configured credentials; for a Drive failure, only a reason code. So
       * what is logged is what the operator would need to act, and there is no
       * path by which a key, secret, token or Authorization header reaches it.
       */
      const payload = errorPayload(error);
      console.warn(
        `Prompt generation: Drive destination could not be resolved (${payload.kind}) ${payload.message}`,
      );
    }
  }

  /**
   * THE UPLOAD PASS RUNS EVEN IF THE GENERATION PASS THREW.
   *
   * These were one `try` and the upload was therefore skipped whenever
   * generation raised — which left already-generated outputs sitting in
   * `generated`, a status the rollup counts as in flight. The job stayed
   * `uploading`, `finaliseBatch` counted it as outstanding for ever, and the
   * batch could never complete. Two passes, two catches: a failure in one
   * cannot strand the other.
   */
  let jobError: unknown = null;
  try {
    await generateOutstanding(db, deps, job, params);
  } catch (error) {
    jobError = error;
  }
  try {
    await uploadOutstanding(db, deps, job.id, folderId, folderError);
  } catch (error) {
    jobError ??= error;
  }
  if (jobError) {
    // A whole-job failure still leaves per-output rows intact and accurate;
    // the rollup below reads them rather than this error.
    await db
      .update(promptJobs)
      .set({ error: errorPayload(jobError) })
      .where(eq(promptJobs.id, job.id));
  }
  await rollUpJob(db, deps, job.id);
  /**
   * A job run OUTSIDE a batch drain — a single-output retry, say — is the last
   * thing standing between its batch and a terminal status. `finaliseBatch`
   * only completes a batch with nothing left outstanding, so calling it here is
   * a no-op while any sibling is still running and the closing move when this
   * was the last one.
   */
  await finaliseBatch(db, job.batchId);
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
    /**
     * LOGGED, NOT JUST STORED.
     *
     * A generation failure used to reach the database and stop there, so the
     * only way to see why a batch failed was to open the Admin UI and read one
     * output at a time — and nothing at all reached the server logs. The
     * provider's reason is built by the xAI client from an allowlist of two
     * named fields, already swept for the key and the prompt, so what is
     * written here is what the operator would need to act and nothing else.
     */
    console.warn(
      `Prompt generation: image generation failed (${payload.kind}) ${payload.message}`,
    );
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
 *
 * The `attempts` budget below counts GENERATIONS ONLY. It used to be shared
 * with Drive uploads, so three upload failures could exhaust it and leave an
 * output that had been generated exactly once permanently unable to be
 * generated again — including after its spool file was lost, which is the one
 * case where regenerating is the only way back.
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
  return rows.filter(
    (row) => row.attempts < MAX_OUTPUT_GENERATION_ATTEMPTS && !refusedByModeration(row.error),
  );
}

/**
 * Whether an output already failed because the provider refused the image it
 * generated.
 *
 * WHY THIS IS A TERMINAL STATE AND NOT A FAILED ATTEMPT. The provider's own
 * retry loop already declines to repeat a refusal within one call, but at this
 * level a refusal looked like any other failed generation: the row sat in
 * `failed` with attempts below the budget, so the next pass over the job — a
 * batch drain, or the boot recovery sweep after any deploy — asked for the same
 * image again. It cost roughly a hundred seconds of generation each time and
 * could not succeed, because nothing about the request had changed.
 *
 * READ FROM THE STORED ERROR KIND, so no column and no migration are needed and
 * rows written before this existed are unaffected — they keep the old kind and
 * the old behaviour rather than being silently reinterpreted.
 *
 * THIS BOUNDS AUTOMATIC WORK ONLY. A deliberate operator retry clears `error`
 * (see `retryStateFor`), so the row becomes eligible again and the person who
 * pressed the button gets what they asked for. Only the machine is stopped from
 * repeating it unprompted.
 */
function refusedByModeration(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { kind?: unknown }).kind === 'xai_content_moderated'
  );
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
  /** Why there is no folder, when the resolver was asked and refused. */
  folderError: unknown = null,
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
    await uploadOne(db, deps, output, folderId, folderError);
  }
}

async function uploadOne(
  db: Db,
  deps: PromptRunnerDeps,
  output: PromptJobOutputRow,
  folderId: string | null,
  folderError: unknown = null,
): Promise<void> {
  /**
   * EXHAUSTION IS A STATE, NOT A SILENT RETURN.
   *
   * This used to `return` with the row still in `generated` — a status the
   * rollup counts as in flight, so the job stayed `uploading`, `finaliseBatch`
   * never completed the batch, and `retryFailedInBatch` (which selects only
   * `failed` and `partial` jobs) could not even see it. The batch was stuck
   * for ever with no operator action that could clear it.
   *
   * `drive_upload_failed` is the right terminal state and it is deliberately
   * not `failed`: THE BYTES ARE STILL IN THE SPOOL. The rollup counts it as a
   * failure so the job and batch reach a terminal status, the UI offers
   * "Retry upload" rather than "Generate again", and the retry re-uploads at
   * zero provider cost.
   *
   * The budget is checked against `uploadAttempts`, which counts uploads only.
   * It used to be checked against the shared `attempts` column with the two
   * ceilings added together to compensate — arithmetic that only worked while
   * both budgets lived in one counter.
   */
  if (output.uploadAttempts >= MAX_OUTPUT_UPLOAD_ATTEMPTS) {
    await db
      .update(promptJobOutputs)
      .set({
        status: 'drive_upload_failed',
        error: {
          kind: 'drive_upload_attempts_exhausted',
          message: `Drive refused this image ${MAX_OUTPUT_UPLOAD_ATTEMPTS} times. The generated image is still held, so retrying uploads it again and does not call the image provider.`,
        },
      })
      .where(eq(promptJobOutputs.id, output.id));
    return;
  }
  if (!folderId) {
    /**
     * TWO DIFFERENT SITUATIONS, NO LONGER ONE SENTENCE. Drive genuinely not
     * being configured is an operator task; the resolver having been refused
     * by Google is a credential or account problem, and telling someone to
     * configure a setting they already configured sends them the wrong way.
     * The recorded reason is the resolver's when there is one.
     */
    await db
      .update(promptJobOutputs)
      .set({
        status: 'drive_upload_failed',
        error: folderError
          ? errorPayload(folderError)
          : {
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
        error: { kind: 'spool_missing', message: SPOOL_MISSING_MESSAGE },
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
    /**
     * THE PATH IS CLEARED, AND THAT CLEARING IS THE WHOLE FIX.
     *
     * `spoolPath` is what the retry paths read to decide re-upload versus
     * regenerate. Leaving a path here that no longer names a file sent every
     * future retry straight back into the upload branch, where it failed on
     * this same `readFile` and returned to `failed` — a loop the operator could
     * press for ever while the image was never regenerated.
     *
     * Nulling it makes the decision honest: no bytes, so regenerate. This is
     * the ONLY transition that moves an output holding a paid image back into
     * generation, and it fires only once the bytes are provably gone.
     */
    await db
      .update(promptJobOutputs)
      .set({
        status: 'failed',
        spoolPath: null,
        error: { kind: 'spool_missing', message: SPOOL_MISSING_MESSAGE },
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
        // The UPLOAD budget, not the generation one. Incrementing `attempts`
        // here is what used to let a run of Drive outages quietly exhaust an
        // output's right to ever be generated again.
        uploadAttempts: sql`${promptJobOutputs.uploadAttempts} + 1`,
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
 * THE ONE PLACE THAT DECIDES RE-UPLOAD VERSUS REGENERATE.
 *
 * The rule, and it is the rule the whole feature rests on: bytes in the spool
 * mean the image is already paid for, so it is re-uploaded and xAI is never
 * called again. No bytes mean there is nothing to upload, so it is generated.
 * `spoolPath` is the single fact consulted, which is why `uploadOne` nulls it
 * the moment the file proves to be gone — a stale path here would send a
 * regenerable output back into the upload path for ever.
 *
 * BOTH budgets are reset, because this only ever runs for a deliberate
 * operator action. An automatic sweep never gets one.
 */
function retryStateFor(output: PromptJobOutputRow): {
  status: 'drive_upload_failed' | 'pending';
  attempts: number;
  uploadAttempts: number;
  error: null;
} {
  return {
    status: output.spoolPath ? 'drive_upload_failed' : 'pending',
    attempts: 0,
    uploadAttempts: 0,
    error: null,
  };
}

/**
 * Resets a job and its outstanding outputs, WITHOUT scheduling anything.
 *
 * Scheduling is the caller's job precisely because it used to be done twice:
 * `retryFailedInBatch` reset every job (each of which scheduled itself) and
 * then restarted the batch drain as well, so the same job was handed to two
 * executions. Separating the reset from the scheduling means each caller picks
 * exactly one way to run the work.
 */
async function resetJobForRetry(db: Db, jobId: string): Promise<RetryOutcome> {
  const [job] = await db.select().from(promptJobs).where(eq(promptJobs.id, jobId)).limit(1);
  if (!job) return { ok: false, reason: 'not_found', message: 'That job no longer exists.' };

  const outputs = await db
    .select()
    .from(promptJobOutputs)
    .where(and(eq(promptJobOutputs.jobId, jobId), ne(promptJobOutputs.status, 'completed')));
  if (outputs.length === 0) {
    return {
      ok: false,
      reason: 'nothing_to_retry',
      message: 'Every image for this prompt is already in Drive.',
    };
  }
  for (const output of outputs) {
    await db
      .update(promptJobOutputs)
      .set(retryStateFor(output))
      .where(eq(promptJobOutputs.id, output.id));
  }
  await db
    .update(promptJobs)
    .set({ status: 'queued', attempts: 0, error: null, completedAt: null })
    .where(eq(promptJobs.id, jobId));
  return { ok: true };
}

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

  // Reset the attempt budgets for this ONE output. A deliberate operator action
  // is allowed to spend another attempt; an automatic sweep is not.
  await db
    .update(promptJobOutputs)
    .set(retryStateFor(output))
    .where(eq(promptJobOutputs.id, outputId));

  /**
   * The JOB's own attempt counter is reset too. It bounds how often the boot
   * recovery sweep may pick the job up, and every claim now increments it —
   * including the claim this retry is about to cause. Without the reset, an
   * operator retrying single outputs a handful of times would quietly push the
   * job past `MAX_JOB_ATTEMPTS` and get it abandoned by the next restart.
   */
  await db
    .update(promptJobs)
    .set({ attempts: 0, error: null })
    .where(eq(promptJobs.id, job.id));

  scheduleJob(db, deps, job.id);
  return { ok: true };
}

/** Retries every non-completed output of one job. Completed ones are untouched. */
export async function retryJob(
  db: Db,
  deps: PromptRunnerDeps,
  jobId: string,
): Promise<RetryOutcome> {
  const outcome = await resetJobForRetry(db, jobId);
  if (outcome.ok) scheduleJob(db, deps, jobId);
  return outcome;
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
    /**
     * RESET ONLY — the batch drain below is the single thing that runs them.
     * This used to call `retryJob`, which scheduled every job individually, and
     * then `scheduleBatch` started the drain over the very same rows.
     */
    const outcome = await resetJobForRetry(db, job.id);
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
