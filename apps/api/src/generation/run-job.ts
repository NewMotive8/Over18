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

export async function runGenerationJob(
  db: Db,
  deps: MediaJobDeps,
  effective: EffectiveGenerationConfiguration,
): Promise<GenerationRunResult> {
  const jobId = randomUUID();
  const assets: CharacterVisualAssetRow[] = [];
  const failures: GenerationAttemptFailure[] = [];
  let estimatedCostUsd = 0;
  let stoppedAt: number | null = null;

  for (let attempt = 1; attempt <= effective.quantity; attempt += 1) {
    const result =
      effective.type === 'image'
        ? await generateImageJob(db, deps, {
            characterId: effective.characterId,
            prompt: effective.prompt,
            referenceAssetId: effective.primaryReferenceAssetId ?? undefined,
            contentRating: effective.contentRating,
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
            contentRating: effective.contentRating,
            status: effective.resultStatus,
          });

    if (result.ok) {
      assets.push(result.asset);
      estimatedCostUsd += result.cost.estimatedCostUsd;
      continue;
    }

    failures.push({ attempt, kind: result.error.kind, message: result.error.message });
    if (TERMINAL_FAILURE_KINDS.has(result.error.kind)) {
      stoppedAt = attempt;
      break;
    }
  }

  const attempted = stoppedAt ?? effective.quantity;
  return {
    jobId,
    effective,
    requested: effective.quantity,
    succeeded: assets.length,
    failed: failures.length,
    skipped: effective.quantity - attempted,
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
