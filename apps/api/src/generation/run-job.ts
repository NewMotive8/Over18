/**
 * US-105 — executes a resolved configuration as a Generation Job.
 *
 * Quantity is a PRODUCT requirement ("give me 3 videos from this Primary
 * image"), not a provider feature. No current adapter batches, so this runner
 * fans out into n independent provider requests. That is deliberate and has
 * real operational benefits:
 *
 *   - every attempt is separately budget-authorized by the existing CostLedger,
 *     so a run cannot blow a budget in one unchecked call;
 *   - every success is an independent `character_visual_assets` row, so each
 *     asset is independently reviewable/approvable/rejectable (EPIC 11);
 *   - a partial failure keeps the successes (US-103: "partial failures are
 *     represented without corrupting successful results").
 *
 * When a vendor gains genuine batching, set `quantity.nativeBatch = true` on the
 * model and teach its adapter to accept n — the loop below becomes one call and
 * nothing else in the contract changes.
 *
 * The single-asset primitives (`generateImageJob` / `generateVideoJob`) are
 * reused untouched. This file adds fan-out; it does not reimplement generation.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { CharacterVisualAssetRow } from '../db/schema.js';
import {
  generateImageJob,
  generateVideoJob,
  type MediaJobDeps,
} from '../services/media-generation-service.js';
import type { EffectiveGenerationConfiguration } from './config.js';

export interface GenerationAttemptFailure {
  /** 1-based index within the fan-out. */
  attempt: number;
  kind: string;
  message: string;
}

export interface GenerationRunResult {
  jobId: string;
  effective: EffectiveGenerationConfiguration;
  requested: number;
  succeeded: number;
  failed: number;
  /** Not attempted because the run stopped early (budget refusal). */
  skipped: number;
  assets: CharacterVisualAssetRow[];
  failures: GenerationAttemptFailure[];
  estimatedCostUsd: number;
}

/** Budget refusal is terminal for a run — later attempts would be refused too,
 * and retrying them just burns time. Provider errors are not terminal: a single
 * bad response should not discard the rest of a 3-video request. */
const TERMINAL_FAILURE_KINDS = new Set(['budget_refused']);

export interface RunOptions {
  /**
   * Called after every attempt so the caller can persist progress WHILE the run
   * is in flight — that is what lets a UI show "5 / 8 completed" and what makes
   * a crash mid-run leave an accurate record instead of a lie.
   */
  onAttempt?: (progress: {
    attempt: number;
    succeeded: number;
    failed: number;
    estimatedCostUsd: number;
  }) => Promise<void> | void;
  /** How many outputs still need producing; defaults to the full quantity. */
  remaining?: number;
}

export async function runGenerationJob(
  db: Db,
  deps: MediaJobDeps,
  effective: EffectiveGenerationConfiguration,
  options: RunOptions = {},
): Promise<GenerationRunResult> {
  const jobId = randomUUID();
  const assets: CharacterVisualAssetRow[] = [];
  const failures: GenerationAttemptFailure[] = [];
  let estimatedCostUsd = 0;
  let stoppedAt: number | null = null;

  // Deliberately SEQUENTIAL, not parallel. The CostLedger is file-backed, so
  // concurrent authorize+record calls would race and could corrupt the ledger —
  // and losing budget accounting is far worse than a slower run. Concurrency
  // limit 1 is the honest bounded strategy here; raise it only if the ledger
  // becomes transactional.
  const target = options.remaining ?? effective.quantity;
  for (let attempt = 1; attempt <= target; attempt += 1) {
    const result =
      effective.type === 'image'
        ? await generateImageJob(db, deps, {
            characterId: effective.characterId,
            prompt: effective.prompt,
            referenceAssetId: effective.primaryReferenceAssetId ?? undefined,
            contentRating: effective.contentRating ?? 'sfw',
            status: effective.resultStatus,
            width: numberParam(effective, 'width'),
            height: numberParam(effective, 'height'),
          })
        : await generateVideoJob(db, deps, {
            characterId: effective.characterId,
            sourceImageAssetId: effective.sourceImageAssetId ?? '',
            motionPrompt: effective.prompt,
            durationSeconds: numberParam(effective, 'durationSeconds'),
            resolution: resolutionParam(effective),
            // undefined => the service inherits the source asset's rating.
            contentRating: effective.contentRating ?? undefined,
            status: effective.resultStatus,
          });

    if (result.ok) {
      assets.push(result.asset);
      estimatedCostUsd += result.cost.estimatedCostUsd;
    } else {
      failures.push({ attempt, kind: result.error.kind, message: result.error.message });
    }

    await options.onAttempt?.({
      attempt,
      succeeded: assets.length,
      failed: failures.length,
      estimatedCostUsd,
    });

    if (!result.ok && TERMINAL_FAILURE_KINDS.has(result.error.kind)) {
      stoppedAt = attempt;
      break;
    }
  }

  const attempted = stoppedAt ?? target;
  return {
    jobId,
    effective,
    requested: target,
    succeeded: assets.length,
    failed: failures.length,
    skipped: target - attempted,
    assets,
    failures,
    estimatedCostUsd,
  };
}

function numberParam(
  effective: EffectiveGenerationConfiguration,
  key: string,
): number | undefined {
  const v = effective.parameters[key];
  return typeof v === 'number' ? v : undefined;
}

function resolutionParam(
  effective: EffectiveGenerationConfiguration,
): '480p' | '720p' | '1080p' | undefined {
  const v = effective.parameters.resolution;
  return v === '480p' || v === '720p' || v === '1080p' ? v : undefined;
}
