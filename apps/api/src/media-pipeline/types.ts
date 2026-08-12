/**
 * US-16E — offline media-generation pipeline: provider-agnostic contracts.
 *
 * OFFLINE TOOLING ONLY. Nothing in the application (server.ts, app.ts, routes,
 * services) imports this directory; the app consumes finished media as opaque
 * URLs exactly as before. Providers are isolated behind these two capability
 * interfaces — image generation and image-to-video are SEPARATE capabilities
 * even when one vendor implements both.
 *
 * Fail-safe rules encoded in these types:
 * - Every generation request carries an explicit, pre-computed estimatedCost.
 *   Unknown cost is an ERROR, never zero (the ledger rejects non-finite/<=0).
 * - Adapters must throw on unexpected responses; a result object is returned
 *   ONLY for a verified successful generation (bytes on disk).
 */

export interface ImageGenerationRequest {
  /** Free-text prompt. Content boundary (non-explicit) is enforced by prompt
   * authoring + human review, not by this tooling. */
  prompt: string;
  /** Portrait target, e.g. 1080x1920. */
  width: number;
  height: number;
  /** Optional reference image path for identity-consistent models. */
  referenceImagePath?: string;
  /** Where the adapter must write the resulting image. */
  outputPath: string;
}

export interface VideoGenerationRequest {
  /** First-frame reference image — the canonical still. REQUIRED: identity
   * consistency is anchored by image-to-video, never text-to-video. */
  referenceImagePath: string;
  /** Motion prompt. */
  prompt: string;
  durationSeconds: number;
  resolution: '480p' | '720p' | '1080p';
  outputPath: string;
}

export interface GenerationResult {
  outputPath: string;
  provider: string;
  model: string;
  /** What the unit is priced in: 'image' or 'second'. */
  unit: 'image' | 'second';
  quantity: number;
  unitCostUsd: number;
  estimatedCostUsd: number;
}

export interface ImageProvider {
  readonly name: string;
  readonly imageModel: string;
  /** Price BEFORE calling — used for budget authorization. */
  estimateImageCost(request: ImageGenerationRequest): number;
  generateImage(request: ImageGenerationRequest): Promise<GenerationResult>;
}

export interface VideoProvider {
  readonly name: string;
  readonly videoModel: string;
  estimateVideoCost(request: VideoGenerationRequest): number;
  imageToVideo(request: VideoGenerationRequest): Promise<GenerationResult>;
}

/** A provider bundle the CLI resolves from --provider. */
export interface MediaProviders {
  image: ImageProvider;
  video: VideoProvider;
}

export class ProviderError extends Error {
  constructor(
    public readonly kind:
      | 'auth'
      | 'network'
      | 'http'
      | 'malformed_response'
      | 'not_verified'
      | 'output_missing'
      /** Request rejected LOCALLY against known model capability, BEFORE any
       * paid call — e.g. a duration the model does not support. */
      | 'unsupported_request',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
