/**
 * US-103 — Generation Results.
 *
 * A job with quantity 5 owns five result rows, created BEFORE anything runs.
 * That is the whole point: a failed output gets a durable identity, so
 * "retry result 3" addresses one row and regenerates exactly one output.
 * Counting successes cannot express that — with counts, "one of the five
 * failed" is all you know, and a retry can only mean "make up the shortfall".
 *
 * The asset stays the reviewable artefact; a succeeded result simply points at
 * the character_visual_assets row it produced. No duplicate asset concept.
 */

import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  generationResults,
  type CharacterVisualAssetRow,
  type GenerationResultRow,
} from '../db/schema.js';
import type { MediaJobDeps } from '../services/media-generation-service.js';
import type { EffectiveGenerationConfiguration } from './config.js';
import { runSingleAttempt } from './run-job.js';

/** Attempts allowed on a SINGLE result, so one cursed output cannot loop. */
export const MAX_RESULT_ATTEMPTS = 3;

export async function createResultRows(
  db: Db,
  jobId: string,
  quantity: number,
): Promise<GenerationResultRow[]> {
  const rows = Array.from({ length: quantity }, (_, i) => ({ jobId, ordinal: i + 1 }));
  return db.insert(generationResults).values(rows).returning();
}

export async function listResults(db: Db, jobId: string): Promise<GenerationResultRow[]> {
  return db
    .select()
    .from(generationResults)
    .where(eq(generationResults.jobId, jobId))
    .orderBy(asc(generationResults.ordinal));
}

export async function getResult(db: Db, resultId: string): Promise<GenerationResultRow | null> {
  const [row] = await db.select().from(generationResults).where(eq(generationResults.id, resultId));
  return row ?? null;
}

export interface ResultOutcome {
  result: GenerationResultRow;
  asset: CharacterVisualAssetRow | null;
  estimatedCostUsd: number;
  /** Terminal for the whole run — later attempts would be refused too. */
  budgetRefused: boolean;
}

/**
 * Execute ONE result: a single provider attempt through the shared call site,
 * with the outcome written back to this result's row.
 */
export async function executeResult(
  db: Db,
  deps: MediaJobDeps,
  effective: EffectiveGenerationConfiguration,
  result: GenerationResultRow,
): Promise<ResultOutcome> {
  await db
    .update(generationResults)
    .set({ status: 'running', attempts: result.attempts + 1 })
    .where(eq(generationResults.id, result.id));

  const attempt = await runSingleAttempt(db, deps, effective);

  if (attempt.ok) {
    const [updated] = await db
      .update(generationResults)
      .set({
        status: 'succeeded',
        assetId: attempt.asset.id,
        error: null,
        estimatedCostUsd: String(attempt.cost.estimatedCostUsd),
        completedAt: new Date(),
      })
      .where(eq(generationResults.id, result.id))
      .returning();
    return {
      result: updated,
      asset: attempt.asset,
      estimatedCostUsd: attempt.cost.estimatedCostUsd,
      budgetRefused: false,
    };
  }

  const [updated] = await db
    .update(generationResults)
    .set({
      status: 'failed',
      // Structured, and only what an operator needs — never a raw provider payload.
      error: { kind: attempt.error.kind, message: attempt.error.message },
      completedAt: new Date(),
    })
    .where(eq(generationResults.id, result.id))
    .returning();

  return {
    result: updated,
    asset: null,
    estimatedCostUsd: 0,
    budgetRefused: attempt.error.kind === 'budget_refused',
  };
}

/** Results still owing an output: never-run or previously failed. */
export function pendingResults(rows: readonly GenerationResultRow[]): GenerationResultRow[] {
  return rows.filter((r) => r.status === 'pending' || r.status === 'failed');
}
