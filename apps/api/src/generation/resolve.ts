/**
 * US-105 — requested configuration → capabilities → defaults → validation →
 * effective configuration.
 *
 * Pure. No database, no network, no provider. That is deliberate: every rule
 * below is enforced BEFORE a paid call exists, which is what makes
 * `ProviderError.kind = 'unsupported_request'` ("rejected LOCALLY against known
 * model capability, BEFORE any paid call") a promise rather than a hope.
 */

import {
  GENERATED_ASSET_STATUS,
  type GenerationConfigError,
  type GenerationConfiguration,
  type GenerationConfigResolution,
  type GenerationParameters,
} from './config.js';
import {
  defaultParametersFor,
  findModel,
  listModels,
  type ModelDescriptor,
  type ParameterSpec,
} from './model-registry.js';

export interface ResolutionContext {
  /** Active identity version of the character — resolved by the caller. */
  visualIdentityId: string;
  /**
   * Model used when the configuration does not name one. This is how existing
   * automated generation keeps its current behaviour: the environment still
   * decides, it is simply expressed as a model id now.
   */
  defaultModelId?: string;
}

function validateParameterValue(
  name: string,
  spec: ParameterSpec,
  value: string | number | boolean,
  errors: GenerationConfigError[],
): void {
  const field = `parameters.${name}`;
  switch (spec.kind) {
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({ code: 'parameter_out_of_range', field, message: `${name} must be a number` });
        return;
      }
      if (spec.kind === 'int' && !Number.isInteger(value)) {
        errors.push({ code: 'parameter_out_of_range', field, message: `${name} must be a whole number` });
        return;
      }
      if (value < spec.min || value > spec.max) {
        errors.push({
          code: 'parameter_out_of_range',
          field,
          message: `${name} must be between ${spec.min} and ${spec.max}`,
        });
      }
      return;
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        errors.push({
          code: 'invalid_enum_value',
          field,
          message: `${name} does not accept "${String(value)}"`,
          supported: spec.values,
        });
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push({ code: 'parameter_out_of_range', field, message: `${name} must be true or false` });
      }
    }
  }
}

function resolveParameters(
  model: ModelDescriptor,
  requested: GenerationParameters | undefined,
  errors: GenerationConfigError[],
): GenerationParameters {
  const resolved = defaultParametersFor(model);
  const declared = Object.keys(model.parameters);
  for (const [name, value] of Object.entries(requested ?? {})) {
    const spec = model.parameters[name];
    if (!spec) {
      errors.push({
        code: 'unsupported_parameter',
        field: `parameters.${name}`,
        message: `${model.label} does not support "${name}"`,
        supported: declared,
      });
      continue;
    }
    validateParameterValue(name, spec, value, errors);
    resolved[name] = value;
  }
  return resolved;
}

function resolveModel(
  config: GenerationConfiguration,
  ctx: ResolutionContext,
  errors: GenerationConfigError[],
): ModelDescriptor | null {
  const requestedId = config.modelId ?? ctx.defaultModelId;
  if (!requestedId) {
    errors.push({
      code: 'no_model_available',
      field: 'modelId',
      message: 'no model was selected and no default model is configured',
      supported: listModels(config.type).map((m) => m.id),
    });
    return null;
  }
  const model = findModel(requestedId);
  if (!model) {
    errors.push({
      code: 'unknown_model',
      field: 'modelId',
      message: `"${requestedId}" is not a registered model`,
      supported: listModels(config.type).map((m) => m.id),
    });
    return null;
  }
  if (model.type !== config.type) {
    errors.push({
      code: 'model_type_mismatch',
      field: 'modelId',
      message: `${model.label} is a ${model.type} model and cannot run a ${config.type} job`,
      supported: listModels(config.type).map((m) => m.id),
    });
    return null;
  }
  return model;
}

function validateQuantity(
  requested: number | undefined,
  model: ModelDescriptor,
  errors: GenerationConfigError[],
): number {
  const quantity = requested ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > model.quantity.max) {
    errors.push({
      code: 'invalid_quantity',
      field: 'quantity',
      message: `quantity must be a whole number between 1 and ${model.quantity.max}`,
    });
  }
  return quantity;
}

export function resolveGenerationConfiguration(
  config: GenerationConfiguration,
  ctx: ResolutionContext,
): GenerationConfigResolution {
  const errors: GenerationConfigError[] = [];

  if (!config.characterId || config.characterId.trim().length === 0) {
    errors.push({ code: 'character_required', field: 'characterId', message: 'a character is required' });
  }

  const model = resolveModel(config, ctx, errors);
  if (!model) return { ok: false, errors };

  const quantity = validateQuantity(config.quantity, model, errors);
  const parameters = resolveParameters(model, config.parameters, errors);

  let prompt: string;
  let primaryReferenceAssetId: string | null = null;
  let sourceImageAssetId: string | null = null;

  if (config.type === 'image' && model.type === 'image') {
    prompt = config.prompt ?? '';
    if (prompt.trim().length === 0) {
      errors.push({ code: 'prompt_required', field: 'prompt', message: 'a prompt is required' });
    }

    const width = config.width ?? model.dimensions.default.width;
    const height = config.height ?? model.dimensions.default.height;
    const d = model.dimensions;
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      errors.push({ code: 'invalid_dimensions', field: 'width', message: 'width and height must be whole numbers' });
    } else if (
      width < d.minWidth ||
      width > d.maxWidth ||
      height < d.minHeight ||
      height > d.maxHeight
    ) {
      errors.push({
        code: 'invalid_dimensions',
        field: 'width',
        message: `${model.label} supports ${d.minWidth}-${d.maxWidth} x ${d.minHeight}-${d.maxHeight}`,
      });
    } else if (!d.normalizesDimensions && (width % d.multipleOf !== 0 || height % d.multipleOf !== 0)) {
      errors.push({
        code: 'invalid_dimensions',
        field: 'width',
        message: `${model.label} requires width and height in multiples of ${d.multipleOf}`,
      });
    } else if (width * height > d.maxPixels) {
      errors.push({
        code: 'invalid_dimensions',
        field: 'width',
        message: `${width}x${height} exceeds the ${(d.maxPixels / 1_000_000).toFixed(1)}MP ceiling for ${model.label}`,
      });
    }
    parameters.width = width;
    parameters.height = height;

    if (config.primaryReferenceAssetId) {
      if (!model.supportsReferenceImage) {
        errors.push({
          code: 'reference_not_supported',
          field: 'primaryReferenceAssetId',
          message: `${model.label} does not accept a reference image`,
        });
      } else {
        primaryReferenceAssetId = config.primaryReferenceAssetId;
      }
    }
  } else if (config.type === 'video' && model.type === 'video') {
    prompt = config.motionPrompt ?? '';
    if (prompt.trim().length === 0) {
      errors.push({ code: 'prompt_required', field: 'motionPrompt', message: 'a motion prompt is required' });
    }
    if (!config.sourceImageAssetId || config.sourceImageAssetId.trim().length === 0) {
      errors.push({
        code: 'video_source_required',
        field: 'sourceImageAssetId',
        message: 'video generation needs an approved source image to animate',
      });
    } else {
      sourceImageAssetId = config.sourceImageAssetId;
    }

    const resolution = config.resolution ?? model.resolutions[model.resolutions.length - 1];
    if (!model.resolutions.includes(resolution)) {
      errors.push({
        code: 'invalid_enum_value',
        field: 'resolution',
        message: `${model.label} does not support ${resolution}`,
        supported: model.resolutions,
      });
    }
    const duration = config.durationSeconds ?? model.duration.default;
    if (!Number.isFinite(duration) || duration < model.duration.min || duration > model.duration.max) {
      errors.push({
        code: 'parameter_out_of_range',
        field: 'durationSeconds',
        message: `${model.label} supports ${model.duration.min}-${model.duration.max} seconds`,
      });
    }
    parameters.resolution = resolution;
    parameters.durationSeconds = duration;
  } else {
    return { ok: false, errors };
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    effective: {
      type: config.type,
      characterId: config.characterId,
      visualIdentityId: ctx.visualIdentityId,
      provider: model.provider,
      modelId: model.id,
      prompt,
      primaryReferenceAssetId,
      sourceImageAssetId,
      quantity,
      contentRating: config.contentRating ?? 'sfw',
      parameters,
      resultStatus: GENERATED_ASSET_STATUS,
    },
  };
}
