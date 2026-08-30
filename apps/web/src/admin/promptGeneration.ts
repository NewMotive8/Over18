import type {
  PromptBatchView,
  PromptCostEstimate,
  PromptJobView,
  PromptOutputStatus,
  PromptOutputView,
} from '../lib/api';

/**
 * Presentation logic for Admin -> Generation.
 *
 * PURE, AND SEPARATE FROM THE PAGE ON PURPOSE. The web suite renders with
 * `react-dom/server` and never runs an effect, so anything living inside the
 * component is untestable. The rules that decide what an operator is told
 * about a paid batch — the cost sentence, the progress fraction, what a failure
 * means — belong where they can be asserted.
 */

/** `1/2`. The fraction the queue row leads with. */
export function outputProgress(job: PromptJobView): string {
  const done = job.outputs.filter((o) => o.status === 'completed').length;
  return `${done}/${job.requestedOutputs}`;
}

/** Operator-facing job status. Short, and never jargon. */
export function jobStatusLabel(job: PromptJobView): string {
  switch (job.status) {
    case 'queued':
      return 'Queued';
    case 'generating':
      return 'Generating';
    case 'uploading':
      return 'Saving to Drive';
    case 'completed':
      return 'Done';
    case 'partial':
      // Named rather than folded into "Failed": one image IS in Drive, and
      // telling an operator this failed would invite them to redo work that
      // succeeded and pay for it twice.
      return 'Partly done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** One image's status, in the operator's words. */
export function outputStatusLabel(status: PromptOutputStatus): string {
  switch (status) {
    case 'pending':
      return 'Waiting';
    case 'generated':
      return 'Generated, not yet saved';
    case 'uploading':
      return 'Saving to Drive';
    case 'completed':
      return 'In Drive';
    case 'failed':
      return 'Failed';
    case 'drive_upload_failed':
      // The distinction that saves money: the image exists and is paid for.
      return 'Generated — Drive upload failed';
  }
}

/**
 * Whether a retry of this output would cost anything.
 *
 * A `drive_upload_failed` output has bytes in the spool, so retrying re-uploads
 * for free. Anything else has to be generated again. Saying which is which is
 * the difference between an operator retrying confidently and not retrying at
 * all.
 */
export function retryCostsMoney(output: PromptOutputView): boolean {
  return output.status !== 'drive_upload_failed';
}

export function canRetryOutput(output: PromptOutputView): boolean {
  return output.status !== 'completed' && output.status !== 'uploading';
}

/** `$12.80`. Two decimals always — money with one decimal reads as a typo. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * The sentence shown beside Start, before anything is spent.
 *
 * States the arithmetic rather than just the total, so the number is checkable:
 * an operator who expected 40 images and reads 400 should be able to see where
 * the disagreement is without opening a calculator.
 */
export function costSentence(estimate: PromptCostEstimate): string {
  if (estimate.prompts === 0) return 'No prompt files uploaded yet.';
  const prompts = `${estimate.prompts} prompt${estimate.prompts === 1 ? '' : 's'}`;
  return `${prompts} × ${estimate.outputsPerPrompt} images × ${formatUsd(estimate.pricePerImageUsd)} = about ${formatUsd(estimate.totalUsd)}`;
}

/** Above this, the estimate is emphasised rather than shown as ordinary text. */
export const LARGE_BATCH_USD = 10;

export function isLargeBatch(estimate: PromptCostEstimate): boolean {
  return estimate.totalUsd >= LARGE_BATCH_USD;
}

export type StartRefusal =
  | 'no_prompts'
  | 'already_running'
  | 'drive_not_configured'
  | null;

/**
 * Why Start is unavailable, or null when it is available.
 *
 * DRIVE IS CHECKED BEFORE GENERATION, not after. Starting a live batch with no
 * destination would spend real money on images with nowhere to go — the one
 * failure mode where the cost is unrecoverable.
 */
export function startRefusal(
  batch: PromptBatchView | null,
  driveLive: boolean,
  xaiLive: boolean,
): StartRefusal {
  if (!batch || batch.totals.prompts === 0) return 'no_prompts';
  if (batch.status === 'running') return 'already_running';
  // Only blocking when generation is live: with the mock provider nothing is
  // spent and the workspace stays fully exercisable without any credentials.
  if (xaiLive && !driveLive) return 'drive_not_configured';
  return null;
}

export function startRefusalMessage(refusal: StartRefusal): string | null {
  switch (refusal) {
    case 'no_prompts':
      return 'Upload some .txt prompt files first.';
    case 'already_running':
      return 'This batch is already running.';
    case 'drive_not_configured':
      return 'Google Drive is not connected, so there would be nowhere to save the images.';
    case null:
      return null;
  }
}

export interface SelectedFile {
  name: string;
  size: number;
}

/**
 * What the operator sees after choosing files and before uploading them.
 *
 * Non-.txt files are called out rather than silently dropped: a picker that
 * accepted a folder of mixed files should say what it is going to ignore.
 */
export function summariseSelection(files: readonly SelectedFile[]): {
  accepted: SelectedFile[];
  ignored: SelectedFile[];
  message: string;
} {
  const accepted = files.filter((f) => /\.txt$/i.test(f.name));
  const ignored = files.filter((f) => !/\.txt$/i.test(f.name));
  const parts: string[] = [];
  parts.push(
    accepted.length === 1 ? '1 prompt file selected' : `${accepted.length} prompt files selected`,
  );
  if (ignored.length > 0) {
    parts.push(
      `${ignored.length} non-.txt file${ignored.length === 1 ? '' : 's'} will be ignored`,
    );
  }
  return { accepted, ignored, message: `${parts.join(' · ')}.` };
}

/** Batch-level rollup for the header strip. */
export function batchSummary(batch: PromptBatchView): string {
  const { prompts, completed, failed } = batch.totals;
  const expected = prompts * batch.outputsPerPrompt;
  const parts = [`${prompts} prompt${prompts === 1 ? '' : 's'}`, `${completed}/${expected} images in Drive`];
  if (failed > 0) parts.push(`${failed} needing attention`);
  return parts.join(' · ');
}
