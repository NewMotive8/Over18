/**
 * US-105 — generation sequences.
 *
 * A Generation Sequence is AN ORDERED LIST of generation configurations. That is
 * the whole abstraction, and it is bounded on purpose. EPIC 11 explicitly
 * excludes scheduling, recurrence, triggers, webhooks, branching, IF/ELSE,
 * loops, parallel branches and visual workflow editing. None of those appear
 * here and none should be added without a new ticket.
 *
 * The only dataflow permitted is a step consuming the IMMEDIATELY PRIOR step's
 * output — enough for "generate an image, then 3 videos from it", which is the
 * motivating case, and not enough to become a dataflow engine.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { generationSequences, type GenerationSequenceRow } from '../db/schema.js';
import type { GenerationConfigError, GenerationConfiguration } from './config.js';
import { resolveGenerationConfiguration, type ResolutionContext } from './resolve.js';

const VALIDATION_IDENTITY = '00000000-0000-0000-0000-000000000000';

export interface GenerationSequenceStep {
  /** 1-based execution order. Steps run top to bottom, exactly as listed. */
  ordinal: number;
  config: GenerationConfiguration;
  /**
   * When true, this step's source image is the output of the previous step
   * rather than a stored asset id. This is how "generate 3 videos per selected
   * source image" is expressed. Only the immediately prior step is reachable.
   */
  usePreviousStepOutput?: boolean;
}

export type SequenceResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly GenerationConfigError[] };

export function validateSequenceSteps(
  steps: readonly GenerationSequenceStep[],
  defaultModelId?: string,
): readonly GenerationConfigError[] {
  const errors: GenerationConfigError[] = [];
  if (steps.length === 0) {
    errors.push({ code: 'unknown_model', field: 'steps', message: 'a sequence needs at least one step' });
    return errors;
  }

  steps.forEach((step, i) => {
    if (step.ordinal !== i + 1) {
      errors.push({
        code: 'parameter_out_of_range',
        field: `steps.${i}.ordinal`,
        message: `steps must be numbered consecutively from 1; expected ${i + 1}`,
      });
    }
    if (step.usePreviousStepOutput && i === 0) {
      errors.push({
        code: 'video_source_required',
        field: 'steps.0.usePreviousStepOutput',
        message: 'the first step has no previous step to take its source from',
      });
    }

    const ctx: ResolutionContext = { visualIdentityId: VALIDATION_IDENTITY, defaultModelId };
    // A step that takes its source from the prior step has no asset id yet.
    const probe: GenerationConfiguration =
      step.config.type === 'video' && step.usePreviousStepOutput
        ? { ...step.config, sourceImageAssetId: VALIDATION_IDENTITY }
        : step.config;

    const resolution = resolveGenerationConfiguration(probe, ctx);
    if (!resolution.ok) {
      for (const e of resolution.errors) {
        errors.push({ ...e, field: `steps.${i}.${e.field}` });
      }
    }
  });

  return errors;
}

export async function createSequence(
  db: Db,
  input: { name: string; characterId?: string | null; steps: readonly GenerationSequenceStep[] },
  defaultModelId?: string,
): Promise<SequenceResult<GenerationSequenceRow>> {
  const errors = validateSequenceSteps(input.steps, defaultModelId);
  if (errors.length > 0) return { ok: false, errors };

  const [row] = await db
    .insert(generationSequences)
    .values({
      name: input.name,
      characterId: input.characterId ?? null,
      steps: input.steps,
    })
    .returning();
  return { ok: true, value: row };
}

export async function getSequenceById(
  db: Db,
  id: string,
): Promise<GenerationSequenceRow | null> {
  const [row] = await db.select().from(generationSequences).where(eq(generationSequences.id, id));
  return row ?? null;
}

/** Steps in execution order, re-validated against current capabilities. */
export async function loadSequence(
  db: Db,
  id: string,
  defaultModelId?: string,
): Promise<SequenceResult<readonly GenerationSequenceStep[]>> {
  const row = await getSequenceById(db, id);
  if (!row) {
    return {
      ok: false,
      errors: [{ code: 'unknown_model', field: 'sequenceId', message: 'sequence not found' }],
    };
  }
  const steps = (row.steps as GenerationSequenceStep[])
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);
  const errors = validateSequenceSteps(steps, defaultModelId);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: steps };
}
