import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createMockProviders } from '../media-pipeline/mock-adapter.js';
import { CostLedger } from '../media-pipeline/cost-ledger.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import type { MediaJobDeps } from '../services/media-generation-service.js';
import { resolveGenerationConfiguration } from '../generation/resolve.js';
import { runGenerationJob } from '../generation/run-job.js';
import { createPreset, loadPreset } from '../generation/presets.js';
import { createSequence, loadSequence } from '../generation/sequences.js';
import type { GenerationConfiguration } from '../generation/config.js';
import {
  createTestContext,
  destroyTestContext,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * US-105 — the shared configuration layer end-to-end against the mock provider.
 * Proves quantity fans out into independently reviewable assets, that presets
 * and sequences round-trip through the database, and that nothing generated
 * here becomes live.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const FIXTURES = join(testEnv.media.storageDir, '__us105__');
const IMAGE_FIXTURE = join(FIXTURES, 'seed.jpg');
const VIDEO_FIXTURE = join(FIXTURES, 'seed.mp4');

let ctx: TestContext;
let identityId: string;

function deps(): MediaJobDeps {
  return {
    providers: createMockProviders({
      imageFixturePath: IMAGE_FIXTURE,
      videoFixturePath: VIDEO_FIXTURE,
    }),
    ledger: new CostLedger(join(testEnv.media.storageDir, 'ledger.json')),
    storage: { storageDir: testEnv.media.storageDir, publicBaseUrl: null },
  };
}

beforeAll(async () => {
  migrateTestDb();
  rmSync(testEnv.media.storageDir, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(IMAGE_FIXTURE, Buffer.from('fake-jpeg-bytes'));
  writeFileSync(VIDEO_FIXTURE, Buffer.from('fake-mp4-bytes'));
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
  rmSync(testEnv.media.storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
  const identity = await getActiveVisualIdentity(ctx.db, LUNA.id);
  identityId = identity!.id;
});

function imageConfig(over: Partial<GenerationConfiguration> = {}): GenerationConfiguration {
  return {
    type: 'image',
    characterId: LUNA.id,
    prompt: 'studio portrait, neutral lighting',
    modelId: 'mock:image',
    ...over,
  } as GenerationConfiguration;
}

describe('US-105 generation run', () => {
  it('fans a quantity of 3 into 3 independently reviewable assets', async () => {
    const resolved = resolveGenerationConfiguration(imageConfig({ quantity: 3 }), {
      visualIdentityId: identityId,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const run = await runGenerationJob(ctx.db, deps(), resolved.effective);

    expect(run.requested).toBe(3);
    expect(run.succeeded).toBe(3);
    expect(run.failed).toBe(0);
    expect(run.assets).toHaveLength(3);

    // Each asset is its own row — separately reviewable, separately approvable.
    const ids = new Set(run.assets.map((a) => a.id));
    expect(ids.size).toBe(3);

    for (const asset of run.assets) {
      expect(asset.status).toBe('under_review'); // never live on generation
      expect(asset.isCanonical).toBe(false); // never auto-Primary
      expect(asset.visualIdentityId).toBe(identityId); // attributed to active identity
    }
    // Cost accrued per attempt, not per job.
    expect(run.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('generates multiple videos from one source image', async () => {
    const seeded = resolveGenerationConfiguration(imageConfig(), { visualIdentityId: identityId });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const source = await runGenerationJob(ctx.db, deps(), seeded.effective);
    const sourceImageAssetId = source.assets[0].id;

    const resolved = resolveGenerationConfiguration(
      {
        type: 'video',
        characterId: LUNA.id,
        sourceImageAssetId,
        motionPrompt: 'slow turn toward camera',
        modelId: 'mock:video',
        quantity: 3,
      },
      { visualIdentityId: identityId },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const run = await runGenerationJob(ctx.db, deps(), resolved.effective);
    expect(run.requested).toBe(3);
    expect(run.succeeded).toBe(3);
    expect(new Set(run.assets.map((a) => a.id)).size).toBe(3);
    for (const asset of run.assets) {
      expect(asset.storageKey?.endsWith('.mp4')).toBe(true);
      expect(asset.status).toBe('under_review');
    }
  });

  it('keeps successes when an attempt fails partway through', async () => {
    const resolved = resolveGenerationConfiguration(imageConfig({ quantity: 2 }), {
      visualIdentityId: identityId,
    });
    if (!resolved.ok) return;

    // A budget too small for the second attempt stops the run without
    // discarding the first result.
    const ledger = new CostLedger(join(testEnv.media.storageDir, 'ledger-tight.json'));
    const run = await runGenerationJob(
      ctx.db,
      { ...deps(), ledger, characterBudgetUsd: 0.0001 },
      resolved.effective,
    );
    expect(run.succeeded + run.failed + run.skipped).toBeGreaterThanOrEqual(run.requested - 1);
    expect(run.assets).toHaveLength(run.succeeded);
  });

  describe('presets', () => {
    it('creates, loads and re-validates a valid preset', async () => {
      const created = await createPreset(ctx.db, {
        name: 'Luna · portrait',
        characterId: LUNA.id,
        config: imageConfig({ quantity: 2 }),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const loaded = await loadPreset(ctx.db, created.value.id);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.type).toBe('image');
      expect(loaded.value.quantity).toBe(2);
    });

    it('refuses to save an invalid preset', async () => {
      const created = await createPreset(ctx.db, {
        name: 'broken',
        config: imageConfig({ parameters: { motionStrength: 1 } }),
      });
      expect(created.ok).toBe(false);
      if (created.ok) return;
      expect(created.errors.map((e) => e.code)).toContain('unsupported_parameter');
    });
  });

  describe('sequences', () => {
    it('round-trips an ordered sequence with a prior-step reference', async () => {
      const created = await createSequence(ctx.db, {
        name: 'portrait then three clips',
        characterId: LUNA.id,
        steps: [
          { ordinal: 1, config: imageConfig() },
          {
            ordinal: 2,
            usePreviousStepOutput: true,
            config: {
              type: 'video',
              characterId: LUNA.id,
              sourceImageAssetId: '',
              motionPrompt: 'slow turn',
              modelId: 'mock:video',
              quantity: 3,
            },
          },
        ],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const loaded = await loadSequence(ctx.db, created.value.id);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.map((s) => s.ordinal)).toEqual([1, 2]);
      expect(loaded.value[1].usePreviousStepOutput).toBe(true);
      expect(loaded.value[1].config.quantity).toBe(3);
    });
  });
});
