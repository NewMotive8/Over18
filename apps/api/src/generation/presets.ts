/**
 * US-105 — generation presets: a saved, valid generation configuration.
 *
 * A preset is not an engine and not a second configuration system. It stores a
 * `GenerationConfiguration` and is RE-VALIDATED against current model
 * capabilities every time it is loaded, so a preset saved when a model accepted
 * 1080p fails loudly the day that model stops accepting it — rather than
 * silently generating something the operator did not ask for.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { generationPresets, type GenerationPresetRow } from '../db/schema.js';
import type {
  GenerationConfigError,
  GenerationConfiguration,
} from './config.js';
import { resolveGenerationConfiguration, type ResolutionContext } from './resolve.js';

/** Identity is not known at save time, so validation uses a placeholder. */
const VALIDATION_IDENTITY = '00000000-0000-0000-0000-000000000000';

export type PresetResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly GenerationConfigError[] };

function validateConfig(
  config: GenerationConfiguration,
  defaultModelId?: string,
): readonly GenerationConfigError[] {
  const ctx: ResolutionContext = { visualIdentityId: VALIDATION_IDENTITY, defaultModelId };
  // A preset may legitimately omit the per-run source image; that is supplied
  // when the preset is used. Everything else must be valid at save time.
  const probe: GenerationConfiguration =
    config.type === 'video' && !config.sourceImageAssetId
      ? { ...config, sourceImageAssetId: VALIDATION_IDENTITY }
      : config;
  const resolution = resolveGenerationConfiguration(probe, ctx);
  return resolution.ok ? [] : resolution.errors;
}

export async function createPreset(
  db: Db,
  input: { name: string; characterId?: string | null; config: GenerationConfiguration },
  defaultModelId?: string,
): Promise<PresetResult<GenerationPresetRow>> {
  const errors = validateConfig(input.config, defaultModelId);
  if (errors.length > 0) return { ok: false, errors };

  const [row] = await db
    .insert(generationPresets)
    .values({
      name: input.name,
      characterId: input.characterId ?? null,
      type: input.config.type,
      config: input.config,
    })
    .returning();
  return { ok: true, value: row };
}

export async function listPresets(db: Db): Promise<GenerationPresetRow[]> {
  return db.select().from(generationPresets);
}

export async function getPresetById(
  db: Db,
  id: string,
): Promise<GenerationPresetRow | null> {
  const [row] = await db.select().from(generationPresets).where(eq(generationPresets.id, id));
  return row ?? null;
}

/**
 * Load a preset and re-validate it against CURRENT capabilities. Never returns
 * a configuration that would be rejected at execution time.
 */
export async function loadPreset(
  db: Db,
  id: string,
  defaultModelId?: string,
): Promise<PresetResult<GenerationConfiguration>> {
  const row = await getPresetById(db, id);
  if (!row) {
    return {
      ok: false,
      errors: [{ code: 'unknown_model', field: 'presetId', message: 'preset not found' }],
    };
  }
  const config = row.config as GenerationConfiguration;
  const errors = validateConfig(config, defaultModelId);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: config };
}
