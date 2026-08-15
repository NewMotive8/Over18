import { describe, expect, it } from 'vitest';
import {
  GENERATED_ASSET_STATUS,
  type GenerationConfiguration,
} from '../generation/config.js';
import {
  defaultParametersFor,
  findModel,
  listModels,
  MODEL_REGISTRY,
} from '../generation/model-registry.js';
import { resolveGenerationConfiguration } from '../generation/resolve.js';
import { validateSequenceSteps, type GenerationSequenceStep } from '../generation/sequences.js';

const IDENTITY = '11111111-1111-4111-8111-111111111111';
const CHARACTER = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const ctx = { visualIdentityId: IDENTITY };

function imageConfig(over: Partial<GenerationConfiguration> = {}): GenerationConfiguration {
  return {
    type: 'image',
    characterId: CHARACTER,
    prompt: 'standing by a window, soft light',
    modelId: 'runpod:sdxl-turbo',
    ...over,
  } as GenerationConfiguration;
}

function videoConfig(over: Partial<GenerationConfiguration> = {}): GenerationConfiguration {
  return {
    type: 'video',
    characterId: CHARACTER,
    sourceImageAssetId: ASSET,
    motionPrompt: 'slow turn toward camera',
    modelId: 'atlas:video',
    ...over,
  } as GenerationConfiguration;
}

function codesOf(result: ReturnType<typeof resolveGenerationConfiguration>): string[] {
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('US-105 generation configuration', () => {
  describe('valid configurations', () => {
    it('resolves a valid image configuration and applies model defaults', () => {
      const result = resolveGenerationConfiguration(imageConfig(), ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.effective.provider).toBe('runpod');
      expect(result.effective.modelId).toBe('runpod:sdxl-turbo');
      // declared defaults resolved, not invented
      expect(result.effective.parameters.steps).toBe(8);
      expect(result.effective.parameters.guidance).toBe(2);
      // structural defaults
      expect(result.effective.parameters.width).toBe(1080);
      expect(result.effective.parameters.height).toBe(1920);
      expect(result.effective.quantity).toBe(1);
      expect(result.effective.contentRating).toBe('sfw');
    });

    it('resolves a valid video configuration', () => {
      const result = resolveGenerationConfiguration(videoConfig(), ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.effective.type).toBe('video');
      expect(result.effective.sourceImageAssetId).toBe(ASSET);
      expect(result.effective.parameters.durationSeconds).toBe(5);
    });

    it('always lands generated content in review — never live', () => {
      for (const config of [imageConfig(), videoConfig()]) {
        const result = resolveGenerationConfiguration(config, ctx);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.effective.resultStatus).toBe(GENERATED_ASSET_STATUS);
      }
      expect(GENERATED_ASSET_STATUS).toBe('under_review');
    });

    it('leaves video rating to be inherited from the source, but defaults images', () => {
      // Regression guard: defaulting video to 'sfw' would silently relabel an
      // explicit source still as safe. Images have no source to inherit from.
      const image = resolveGenerationConfiguration(imageConfig(), ctx);
      expect(image.ok).toBe(true);
      if (image.ok) expect(image.effective.contentRating).toBe('sfw');

      const video = resolveGenerationConfiguration(videoConfig(), ctx);
      expect(video.ok).toBe(true);
      if (video.ok) expect(video.effective.contentRating).toBeNull();

      const explicitVideo = resolveGenerationConfiguration(
        videoConfig({ contentRating: 'explicit' }),
        ctx,
      );
      expect(explicitVideo.ok).toBe(true);
      if (explicitVideo.ok) expect(explicitVideo.effective.contentRating).toBe('explicit');
    });

    it('never carries a credential in the effective configuration', () => {
      const result = resolveGenerationConfiguration(imageConfig(), ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const serialized = JSON.stringify(result.effective).toLowerCase();
      for (const secret of ['apikey', 'api_key', 'authorization', 'bearer', 'secret', 'token']) {
        expect(serialized).not.toContain(secret);
      }
      // provider is recorded by NAME only
      expect(result.effective.provider).toBe('runpod');
    });
  });

  describe('rejections before any provider call', () => {
    it('rejects a missing character', () => {
      expect(codesOf(resolveGenerationConfiguration(imageConfig({ characterId: '' }), ctx))).toContain(
        'character_required',
      );
    });

    it('rejects an unknown model and offers the supported ones', () => {
      const result = resolveGenerationConfiguration(imageConfig({ modelId: 'nope:v9' }), ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0].code).toBe('unknown_model');
      expect(result.errors[0].supported).toContain('runpod:sdxl-turbo');
    });

    it('rejects a video model used for an image job', () => {
      expect(codesOf(resolveGenerationConfiguration(imageConfig({ modelId: 'atlas:video' }), ctx))).toContain(
        'model_type_mismatch',
      );
    });

    it('rejects a parameter the model does not declare', () => {
      const result = resolveGenerationConfiguration(
        imageConfig({ parameters: { motionStrength: 0.5 } }),
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = result.errors.find((e) => e.code === 'unsupported_parameter');
      expect(err?.field).toBe('parameters.motionStrength');
      expect(err?.supported).toContain('steps');
    });

    it('rejects a declared parameter that is out of range', () => {
      expect(
        codesOf(resolveGenerationConfiguration(imageConfig({ parameters: { steps: 999 } }), ctx)),
      ).toContain('parameter_out_of_range');
    });

    it('rejects dimensions that break the model grid', () => {
      // 1081 is not a multiple of 8 for SDXL
      expect(codesOf(resolveGenerationConfiguration(imageConfig({ width: 1081, height: 1920 }), ctx))).toContain(
        'invalid_dimensions',
      );
    });

    it('rejects dimensions above the model pixel ceiling', () => {
      expect(codesOf(resolveGenerationConfiguration(imageConfig({ width: 1536, height: 2048 }), ctx))).toContain(
        'invalid_dimensions',
      );
    });

    it('rejects a resolution the model does not support, naming what it does', () => {
      const result = resolveGenerationConfiguration(
        videoConfig({ modelId: 'runpod:wan-2-1-i2v-720', resolution: '1080p' }),
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = result.errors.find((e) => e.code === 'invalid_enum_value');
      expect(err?.message).toContain('1080p');
      expect(err?.supported).toEqual(['480p', '720p']);
    });

    it('rejects video without a source image', () => {
      expect(codesOf(resolveGenerationConfiguration(videoConfig({ sourceImageAssetId: '' }), ctx))).toContain(
        'video_source_required',
      );
    });

    it('rejects an invalid quantity', () => {
      expect(codesOf(resolveGenerationConfiguration(imageConfig({ quantity: 0 }), ctx))).toContain(
        'invalid_quantity',
      );
      expect(codesOf(resolveGenerationConfiguration(imageConfig({ quantity: 2.5 }), ctx))).toContain(
        'invalid_quantity',
      );
    });

    it('rejects a missing prompt', () => {
      expect(codesOf(resolveGenerationConfiguration(imageConfig({ prompt: '   ' }), ctx))).toContain(
        'prompt_required',
      );
    });
  });

  describe('quantity is a product capability, for image AND video', () => {
    it('accepts multiple videos from one source image', () => {
      const result = resolveGenerationConfiguration(videoConfig({ quantity: 3 }), ctx);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.effective.quantity).toBe(3);
    });

    it('accepts multiple images', () => {
      const result = resolveGenerationConfiguration(imageConfig({ quantity: 4 }), ctx);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.effective.quantity).toBe(4);
    });

    it('is not artificially capped at 1 for any registered model', () => {
      for (const model of MODEL_REGISTRY) {
        expect(model.quantity.max).toBeGreaterThan(1);
      }
    });

    it('records that no current adapter batches natively, so the runner fans out', () => {
      for (const model of MODEL_REGISTRY) {
        expect(model.quantity.nativeBatch).toBe(false);
      }
    });

    it('rejects a quantity above the model ceiling', () => {
      expect(codesOf(resolveGenerationConfiguration(videoConfig({ quantity: 99 }), ctx))).toContain(
        'invalid_quantity',
      );
    });
  });

  describe('capability resolution', () => {
    it('resolves capabilities per model rather than a universal parameter set', () => {
      const sdxl = findModel('runpod:sdxl-turbo');
      const flux = findModel('atlas:flux-image');
      expect(Object.keys(sdxl!.parameters)).toEqual(['steps', 'guidance', 'seed']);
      expect(Object.keys(flux!.parameters)).toEqual([]);
      expect(defaultParametersFor(sdxl!)).toEqual({ steps: 8, guidance: 2 });
    });

    it('preserves supported parameters the caller supplied', () => {
      const result = resolveGenerationConfiguration(
        imageConfig({ parameters: { steps: 12, seed: 42 } }),
        ctx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.effective.parameters.steps).toBe(12);
      expect(result.effective.parameters.seed).toBe(42);
      expect(result.effective.parameters.guidance).toBe(2); // default kept
    });

    it('lists models per generation type for a model picker', () => {
      expect(listModels('image').every((m) => m.type === 'image')).toBe(true);
      expect(listModels('video').every((m) => m.type === 'video')).toBe(true);
      expect(listModels('video').map((m) => m.id)).toContain('atlas:video');
    });
  });

  describe('per-request model selection', () => {
    it('uses the environment default when no model is named', () => {
      const result = resolveGenerationConfiguration(imageConfig({ modelId: undefined }), {
        visualIdentityId: IDENTITY,
        defaultModelId: 'mock:image',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.effective.modelId).toBe('mock:image');
    });

    it('lets an explicit request override the environment default', () => {
      const result = resolveGenerationConfiguration(imageConfig({ modelId: 'atlas:flux-image' }), {
        visualIdentityId: IDENTITY,
        defaultModelId: 'mock:image',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.effective.modelId).toBe('atlas:flux-image');
    });

    it('fails clearly when neither a request nor a default names a model', () => {
      expect(codesOf(resolveGenerationConfiguration(imageConfig({ modelId: undefined }), ctx))).toContain(
        'no_model_available',
      );
    });
  });

  describe('sequences stay an ordered list, nothing more', () => {
    const steps: GenerationSequenceStep[] = [
      { ordinal: 1, config: imageConfig() },
      { ordinal: 2, config: videoConfig({ quantity: 3 }), usePreviousStepOutput: true },
    ];

    it('represents ordered steps with a prior-step reference', () => {
      expect(validateSequenceSteps(steps)).toEqual([]);
    });

    it('supports "3 videos per selected source image" as one step', () => {
      const errors = validateSequenceSteps([
        { ordinal: 1, config: videoConfig({ quantity: 3 }) },
      ]);
      expect(errors).toEqual([]);
    });

    it('rejects a first step that references a previous step', () => {
      const errors = validateSequenceSteps([
        { ordinal: 1, config: videoConfig(), usePreviousStepOutput: true },
      ]);
      expect(errors.map((e) => e.code)).toContain('video_source_required');
    });

    it('rejects non-consecutive ordinals', () => {
      const errors = validateSequenceSteps([
        { ordinal: 1, config: imageConfig() },
        { ordinal: 5, config: imageConfig() },
      ]);
      expect(errors.map((e) => e.code)).toContain('parameter_out_of_range');
    });

    it('surfaces a bad step by its index', () => {
      const errors = validateSequenceSteps([
        { ordinal: 1, config: imageConfig() },
        { ordinal: 2, config: imageConfig({ width: 1081 }) },
      ]);
      expect(errors.some((e) => e.field.startsWith('steps.1.'))).toBe(true);
    });

    it('introduces no workflow constructs', () => {
      const stepKeys = new Set(steps.flatMap((s) => Object.keys(s)));
      for (const forbidden of ['condition', 'branch', 'if', 'loop', 'parallel', 'schedule', 'trigger']) {
        expect(stepKeys.has(forbidden)).toBe(false);
      }
    });
  });
});
