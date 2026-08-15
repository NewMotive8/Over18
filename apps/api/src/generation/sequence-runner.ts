/**
 * US-103 — sequence execution.
 *
 * A sequence is an ordered list of steps. A RUN is one pass through that list,
 * top to bottom. That is the entire model. There is no branching, no condition,
 * no loop, no trigger, no schedule, no parallel graph — and adding one should
 * require a new ticket, not a quiet edit here.
 *
 * Steps execute through exactly the same `createGenerationJob` /
 * `executeGenerationJob` path as a single manual job. There is deliberately no
 * separate sequence execution engine; if there were two, they would drift.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  generationSequenceRuns,
  type CharacterVisualAssetRow,
  type GenerationJobRow,
  type GenerationSequenceRunRow,
} from '../db/schema.js';
import type { MediaJobDeps } from '../services/media-generation-service.js';
import type { GenerationConfiguration } from './config.js';
import { createGenerationJob, executeGenerationJob, type JobResult } from './jobs.js';
import { loadSequence, type GenerationSequenceStep } from './sequences.js';

export interface SequenceStepOutcome {
  ordinal: number;
  /** One job per produced job row — a fan-out step creates several. */
  jobs: GenerationJobRow[];
  assets: CharacterVisualAssetRow[];
  status: 'completed' | 'partial' | 'failed' | 'blocked';
  reason?: string;
}

export interface SequenceRunResult {
  run: GenerationSequenceRunRow;
  steps: SequenceStepOutcome[];
}

export async function getSequenceRun(
  db: Db,
  runId: string,
): Promise<GenerationSequenceRunRow | null> {
  const [row] = await db
    .select()
    .from(generationSequenceRuns)
    .where(eq(generationSequenceRuns.id, runId));
  return row ?? null;
}

/**
 * Execute a saved sequence for a character.
 *
 * Failure policy (ticket section 15): a failed step does NOT erase earlier
 * successes, and a step whose required input never materialised is marked
 * `blocked` rather than silently generating without the intended input.
 */
export async function runSequence(
  db: Db,
  deps: MediaJobDeps,
  input: { sequenceId: string; characterId: string; defaultModelId?: string },
): Promise<JobResult<SequenceRunResult>> {
  const loaded = await loadSequence(db, input.sequenceId, input.defaultModelId);
  if (!loaded.ok) return loaded;
  const steps = loaded.value;

  const [run] = await db
    .insert(generationSequenceRuns)
    .values({
      sequenceId: input.sequenceId,
      characterId: input.characterId,
      status: 'running',
      totalSteps: steps.length,
    })
    .returning();

  const outcomes: SequenceStepOutcome[] = [];
  let previousAssets: CharacterVisualAssetRow[] = [];
  let blockedFromHere = false;

  for (const step of steps) {
    if (blockedFromHere) {
      outcomes.push({
        ordinal: step.ordinal,
        jobs: [],
        assets: [],
        status: 'blocked',
        reason: 'an earlier step did not produce the input this step requires',
      });
      continue;
    }

    const outcome = await runStep(db, deps, {
      step,
      characterId: input.characterId,
      defaultModelId: input.defaultModelId,
      runId: run.id,
      previousAssets,
    });
    outcomes.push(outcome);

    if (outcome.status === 'blocked' || outcome.status === 'failed') {
      // Only downstream steps that DEPEND on output are blocked; an independent
      // later step is still allowed to run.
      blockedFromHere = steps
        .filter((s) => s.ordinal > step.ordinal)
        .some((s) => s.usePreviousStepOutput);
    }

    if (outcome.assets.length > 0) previousAssets = outcome.assets;

    await db
      .update(generationSequenceRuns)
      .set({ completedSteps: outcomes.filter((o) => o.status === 'completed').length })
      .where(eq(generationSequenceRuns.id, run.id));
  }

  const [finished] = await db
    .update(generationSequenceRuns)
    .set({ status: runStatusFor(outcomes), completedAt: new Date() })
    .where(eq(generationSequenceRuns.id, run.id))
    .returning();

  return { ok: true, value: { run: finished, steps: outcomes } };
}

function runStatusFor(
  outcomes: readonly SequenceStepOutcome[],
): 'completed' | 'partial' | 'failed' | 'blocked' {
  if (outcomes.every((o) => o.status === 'completed')) return 'completed';
  if (outcomes.some((o) => o.status === 'completed' || o.status === 'partial')) return 'partial';
  if (outcomes.some((o) => o.status === 'blocked')) return 'blocked';
  return 'failed';
}

async function runStep(
  db: Db,
  deps: MediaJobDeps,
  args: {
    step: GenerationSequenceStep;
    characterId: string;
    defaultModelId?: string;
    runId: string;
    previousAssets: readonly CharacterVisualAssetRow[];
  },
): Promise<SequenceStepOutcome> {
  const { step, previousAssets } = args;

  // Independent step — one job, exactly like a manual submission.
  if (!step.usePreviousStepOutput) {
    return executeConfigs(db, deps, args, [withCharacter(step.config, args.characterId)]);
  }

  const eligible = previousAssets.filter((a) => a.status === 'under_review' || a.status === 'approved');
  if (eligible.length === 0) {
    return {
      ordinal: step.ordinal,
      jobs: [],
      assets: [],
      status: 'blocked',
      reason: 'the previous step produced no usable output to work from',
    };
  }

  if (step.config.type !== 'video') {
    // The only supported prior-step consumption is image -> video. Anything else
    // is refused rather than guessed at.
    return {
      ordinal: step.ordinal,
      jobs: [],
      assets: [],
      status: 'blocked',
      reason: 'only a video step can consume the previous step output',
    };
  }

  // "N videos per eligible source image" — one job per source, each carrying the
  // step's own quantity.
  const configs: GenerationConfiguration[] = eligible.map((asset) => ({
    ...step.config,
    characterId: args.characterId,
    sourceImageAssetId: asset.id,
  }));

  return executeConfigs(db, deps, args, configs);
}

function withCharacter(
  config: GenerationConfiguration,
  characterId: string,
): GenerationConfiguration {
  return { ...config, characterId } as GenerationConfiguration;
}

async function executeConfigs(
  db: Db,
  deps: MediaJobDeps,
  args: { step: GenerationSequenceStep; defaultModelId?: string; runId: string },
  configs: readonly GenerationConfiguration[],
): Promise<SequenceStepOutcome> {
  const jobs: GenerationJobRow[] = [];
  const assets: CharacterVisualAssetRow[] = [];
  let anyFailed = false;
  let anySucceeded = false;

  for (const config of configs) {
    const created = await createGenerationJob(db, config, {
      defaultModelId: args.defaultModelId,
      sequenceRunId: args.runId,
      stepOrdinal: args.step.ordinal,
    });
    if (!created.ok) {
      anyFailed = true;
      continue;
    }
    const executed = await executeGenerationJob(db, deps, created.value.id);
    if (!executed) {
      anyFailed = true;
      continue;
    }
    jobs.push(executed.job);
    assets.push(...executed.assets);
    if (executed.job.status === 'completed') anySucceeded = true;
    else if (executed.job.status === 'partial') {
      anySucceeded = true;
      anyFailed = true;
    } else anyFailed = true;
  }

  const status = anySucceeded && anyFailed ? 'partial' : anySucceeded ? 'completed' : 'failed';
  return { ordinal: args.step.ordinal, jobs, assets, status };
}
