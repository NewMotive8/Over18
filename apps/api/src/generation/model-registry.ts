/**
 * US-105 — registered providers/models and their real capabilities.
 *
 * WHY CODE AND NOT A TABLE: capability metadata is only correct if it matches the
 * adapter that implements it (FLUX's multiple-of-16 rule lives in
 * `atlas-adapter.normalizeFluxSize`; the 480p/720p/1080p enum lives in the video
 * request type). Versioning that metadata with the adapters keeps them honest.
 * Four providers do not justify three tables (ticket section 19).
 *
 * EVERY constraint below is taken from the existing adapters/types. Nothing here
 * is invented — if a model cannot do something, it is absent, not permissive.
 */

import type { GenerationParameters, GenerationType } from './config.js';

export type ParameterSpec =
  | { kind: 'int'; min: number; max: number; default?: number }
  | { kind: 'number'; min: number; max: number; default?: number }
  | { kind: 'enum'; values: readonly string[]; default?: string }
  | { kind: 'boolean'; default?: boolean };

export interface DimensionCapability {
  /** Native grid the model generates on. */
  multipleOf: number;
  /**
   * True when the ADAPTER snaps requested dimensions onto the grid itself, so
   * the configuration layer must not reject an off-grid request.
   *
   * This is the repo's established split — "the pipeline expresses intent, the
   * adapter owns capability": `atlas-adapter.normalizeFluxSize` maps 1080x1920
   * to 1056x1888 (0.6% aspect drift) rather than failing. Enforcing the grid
   * here would reject the PoC's own approved portrait size.
   *
   * False means nothing normalizes downstream, so an off-grid request really is
   * invalid and is refused before any paid call.
   */
  normalizesDimensions: boolean;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  /** Hard pixel ceiling (BFL: max 4MP, <=2MP recommended). */
  maxPixels: number;
  default: { width: number; height: number };
}

interface BaseModelDescriptor {
  id: string;
  provider: string;
  /** Human label for the Studio's model picker. */
  label: string;
  /**
   * Quantity is a PRODUCT-level capability, not a provider one: an operator may
   * ask for 3 videos from one Primary image regardless of whether the vendor
   * has a batch endpoint.
   *
   * - `max` is a safety ceiling on one job, not a claim about the vendor.
   * - `nativeBatch` says whether the adapter can satisfy n>1 in a single call.
   *   Every current adapter is false — `ImageGenerationRequest` /
   *   `VideoGenerationRequest` each produce exactly one output — so the runner
   *   fans out into n independent provider requests, each separately
   *   budget-authorized and each yielding an independently reviewable asset.
   *   Flip to true (and teach the adapter) if a vendor gains real batching.
   */
  quantity: { max: number; nativeBatch: boolean };
  /** Extra model-specific parameters beyond the structural ones below. */
  parameters: Readonly<Record<string, ParameterSpec>>;
}

export interface ImageModelDescriptor extends BaseModelDescriptor {
  type: 'image';
  dimensions: DimensionCapability;
  supportsReferenceImage: boolean;
  costUnit: 'image';
}

export interface VideoModelDescriptor extends BaseModelDescriptor {
  type: 'video';
  resolutions: readonly string[];
  duration: { min: number; max: number; default: number };
  /** Image-to-video only — identity is anchored by the source still, never t2v. */
  requiresSourceImage: true;
  costUnit: 'second';
}

export type ModelDescriptor = ImageModelDescriptor | VideoModelDescriptor;

/** Portrait default used across the PoC (US-16H approved benchmark). */
const PORTRAIT_DEFAULT = { width: 1080, height: 1920 } as const;

const FLUX_DIMENSIONS: DimensionCapability = {
  multipleOf: 16,
  normalizesDimensions: true,
  minWidth: 256,
  maxWidth: 2048,
  minHeight: 256,
  maxHeight: 2048,
  maxPixels: 4_000_000,
  default: PORTRAIT_DEFAULT,
};

const SDXL_DIMENSIONS: DimensionCapability = {
  multipleOf: 8,
  normalizesDimensions: false,
  minWidth: 512,
  maxWidth: 1536,
  minHeight: 512,
  maxHeight: 2048,
  maxPixels: 2_100_000,
  default: PORTRAIT_DEFAULT,
};

export const MODEL_REGISTRY: readonly ModelDescriptor[] = [
  {
    id: 'atlas:flux-image',
    provider: 'atlas',
    label: 'Atlas · FLUX',
    type: 'image',
    dimensions: FLUX_DIMENSIONS,
    supportsReferenceImage: true,
    quantity: { max: 10, nativeBatch: false },
    costUnit: 'image',
    parameters: {},
  },
  {
    id: 'runpod:sdxl-turbo',
    provider: 'runpod',
    label: 'RunPod · SDXL Turbo',
    type: 'image',
    dimensions: SDXL_DIMENSIONS,
    supportsReferenceImage: true,
    quantity: { max: 10, nativeBatch: false },
    costUnit: 'image',
    parameters: {
      steps: { kind: 'int', min: 1, max: 50, default: 8 },
      guidance: { kind: 'number', min: 0, max: 20, default: 2 },
      seed: { kind: 'int', min: 0, max: 2_147_483_647 },
    },
  },
  {
    id: 'atlas:video',
    provider: 'atlas',
    label: 'Atlas · image-to-video',
    type: 'video',
    resolutions: ['480p', '720p', '1080p'],
    duration: { min: 1, max: 10, default: 5 },
    requiresSourceImage: true,
    quantity: { max: 10, nativeBatch: false },
    costUnit: 'second',
    parameters: {},
  },
  {
    id: 'runpod:wan-2-1-i2v-720',
    provider: 'runpod',
    label: 'RunPod · Wan 2.1 I2V 720',
    type: 'video',
    // The public Wan 2.1 720 endpoint is a 720p endpoint. Offering 1080p here
    // would be inventing a capability the endpoint does not have.
    resolutions: ['480p', '720p'],
    duration: { min: 1, max: 5, default: 5 },
    requiresSourceImage: true,
    quantity: { max: 10, nativeBatch: false },
    costUnit: 'second',
    parameters: {},
  },
  {
    id: 'mock:image',
    provider: 'mock',
    label: 'Mock image (fixture copy)',
    type: 'image',
    dimensions: FLUX_DIMENSIONS,
    supportsReferenceImage: true,
    quantity: { max: 10, nativeBatch: false },
    costUnit: 'image',
    parameters: {},
  },
  {
    id: 'mock:video',
    provider: 'mock',
    label: 'Mock video (fixture copy)',
    type: 'video',
    resolutions: ['480p', '720p', '1080p'],
    duration: { min: 1, max: 10, default: 5 },
    requiresSourceImage: true,
    quantity: { max: 10, nativeBatch: false },
    costUnit: 'second',
    parameters: {},
  },
];

export function findModel(modelId: string): ModelDescriptor | null {
  return MODEL_REGISTRY.find((m) => m.id === modelId) ?? null;
}

export function listModels(type?: GenerationType): readonly ModelDescriptor[] {
  return type ? MODEL_REGISTRY.filter((m) => m.type === type) : MODEL_REGISTRY;
}

/** Declared defaults for a model's own parameters. */
export function defaultParametersFor(model: ModelDescriptor): GenerationParameters {
  const out: GenerationParameters = {};
  for (const [name, spec] of Object.entries(model.parameters)) {
    if (spec.default !== undefined) out[name] = spec.default;
  }
  return out;
}
