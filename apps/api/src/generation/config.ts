/**
 * US-105 — the shared generation configuration contract.
 *
 * ONE contract, two callers: the existing automated/internal generation path and
 * the future Manual Generation Studio (US-104). Both build a
 * `GenerationConfiguration`; both get it resolved into an
 * `EffectiveGenerationConfiguration` before any provider is touched.
 *
 * Boundaries this file deliberately keeps apart (ticket section 17):
 *   Configuration — "what do we want to generate?"   (this file)
 *   Job           — "what did we actually submit?"   (generation_jobs row)
 *   Adapter       — "how does this provider want it?" (media-pipeline/*-adapter)
 *   Asset         — "what was produced?"             (character_visual_assets)
 *
 * Nothing here knows a vendor. Provider-specific request construction stays in
 * the adapters, exactly as it already is.
 */

import type { ContentRating, VisualAssetStatus } from '../services/visual-asset-service.js';

/**
 * The lifecycle state newly generated content enters. EPIC 11 non-negotiable:
 * generation NEVER makes content live. Approval is a separate, human act.
 */
export const GENERATED_ASSET_STATUS = 'under_review' as const satisfies VisualAssetStatus;

export type GenerationType = 'image' | 'video';

/** Model-specific parameters. Only keys the selected model declares are allowed. */
export type GenerationParameters = Record<string, string | number | boolean>;

/** What the operator (or the automation) asked for. Everything optional except
 * the irreducible minimum, so defaults can come from model capabilities. */
export interface ImageGenerationConfiguration {
  type: 'image';
  characterId: string;
  prompt: string;
  /** Model id from the registry. Omitted = resolve the environment default. */
  modelId?: string;
  /** Identity-consistent reference. Operator-facing name for this is "Primary". */
  primaryReferenceAssetId?: string;
  width?: number;
  height?: number;
  quantity?: number;
  contentRating?: ContentRating;
  /**
   * Which CONFIGURED content requirement this generation is meant to satisfy.
   *
   * Optional and never defaulted. When set, it rides through the job's
   * effective config onto every produced asset, so generated content arrives in
   * Review already filed under its category — the same field a manual upload
   * carries. This is the whole integration point for "Generate Missing
   * Content"; no category name or quantity is known here.
   */
  requirementKey?: string;
  parameters?: GenerationParameters;
}

export interface VideoGenerationConfiguration {
  type: 'video';
  characterId: string;
  /** Approved source still to animate. Identity is anchored by image-to-video. */
  sourceImageAssetId: string;
  motionPrompt: string;
  modelId?: string;
  durationSeconds?: number;
  resolution?: string;
  quantity?: number;
  contentRating?: ContentRating;
  /** See ImageGenerationConfiguration.requirementKey. */
  requirementKey?: string;
  parameters?: GenerationParameters;
}

export type GenerationConfiguration =
  | ImageGenerationConfiguration
  | VideoGenerationConfiguration;

/**
 * The resolved, validated, reproducible configuration persisted with every job.
 *
 * Contains NO credentials — provider is recorded by name only. Never put an API
 * key, endpoint secret or authorization header in here; it is written to the
 * database and shown to operators.
 */
export interface EffectiveGenerationConfiguration {
  type: GenerationType;
  characterId: string;
  /** Active identity version the asset will be attributed to. */
  visualIdentityId: string;
  provider: string;
  modelId: string;
  prompt: string;
  primaryReferenceAssetId: string | null;
  sourceImageAssetId: string | null;
  quantity: number;
  /**
   * NULL means "inherit from the source asset" and is only valid for video,
   * where the still being animated already carries a rating. Defaulting video
   * to 'sfw' here would silently relabel an explicit source as safe — a
   * content-safety bug, not a cosmetic one. Images have no source to inherit
   * from, so they always resolve to a concrete rating.
   */
  contentRating: ContentRating | null;
  /**
   * The target content requirement, persisted with the job so a retry produces
   * an asset filed under the same category as the original attempt.
   */
  requirementKey: string | null;
  /** Fully resolved model parameters — declared defaults merged with requests. */
  parameters: GenerationParameters;
  /** Where the produced asset lands. Always `under_review`. */
  resultStatus: typeof GENERATED_ASSET_STATUS;
}

/** Structured so a UI can say "this model does not support 16:9 video" rather
 * than "generation failed" (ticket section 7). */
export type GenerationConfigErrorCode =
  | 'character_required'
  | 'prompt_required'
  | 'unknown_model'
  | 'model_type_mismatch'
  | 'no_model_available'
  | 'unsupported_parameter'
  | 'parameter_out_of_range'
  | 'invalid_enum_value'
  | 'invalid_dimensions'
  | 'invalid_quantity'
  | 'video_source_required'
  | 'reference_not_supported';

export interface GenerationConfigError {
  code: GenerationConfigErrorCode;
  /** Dotted path of the offending field, e.g. `parameters.steps`. */
  field: string;
  message: string;
  /** Populated when the failure is "not one of these", so a UI can offer them. */
  supported?: readonly (string | number)[];
}

export class GenerationConfigurationError extends Error {
  constructor(public readonly errors: readonly GenerationConfigError[]) {
    super(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
    this.name = 'GenerationConfigurationError';
  }
}

export type GenerationConfigResolution =
  | { ok: true; effective: EffectiveGenerationConfiguration }
  | { ok: false; errors: readonly GenerationConfigError[] };
