import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ProviderError,
  type GenerationResult,
  type ImageGenerationRequest,
  type ImageProvider,
  type VideoGenerationRequest,
  type VideoProvider,
} from './types.js';

/**
 * Deterministic zero-cost-in-reality mock provider for pipeline validation.
 *
 * "Generates" by copying real fixture media (by default the existing approved
 * Luna assets from apps/web/public/media) so downstream technical QA runs
 * against genuinely representative files. Costs mirror the real Atlas prices
 * so budget accounting is exercised realistically — but nothing is spent.
 *
 * Failure injection for tests (never reads env in production paths):
 *   failureMode: 'provider_error'     → throws ProviderError('http')
 *   failureMode: 'malformed_response' → simulates a 200-with-garbage payload:
 *                                       the adapter detects it and throws;
 *                                       NO output file is produced.
 */

export interface MockOptions {
  imageFixturePath: string;
  videoFixturePath: string;
  imageUnitCostUsd?: number;
  videoUnitCostPerSecondUsd?: number;
  failureMode?: 'provider_error' | 'malformed_response';
}

export function createMockProviders(options: MockOptions): { image: ImageProvider; video: VideoProvider } {
  const imageUnitCost = options.imageUnitCostUsd ?? 0.025;
  const videoPerSecond = options.videoUnitCostPerSecondUsd ?? 0.02;

  function ensureFixture(path: string): void {
    if (!existsSync(path)) {
      throw new ProviderError('output_missing', `mock fixture missing: ${path}`);
    }
  }

  function simulateFailure(): void {
    if (options.failureMode === 'provider_error') {
      throw new ProviderError('http', 'mock provider returned HTTP 500');
    }
    if (options.failureMode === 'malformed_response') {
      // Simulates a response that parsed but has no usable asset reference.
      const body: unknown = { unexpected: 'shape' };
      const url = (body as { output?: { url?: string } }).output?.url;
      if (typeof url !== 'string') {
        throw new ProviderError('malformed_response', 'mock provider returned an unexpected response shape');
      }
    }
  }

  const image: ImageProvider = {
    name: 'mock',
    imageModel: 'mock-image-fixture',
    estimateImageCost: () => imageUnitCost,
    async generateImage(request: ImageGenerationRequest): Promise<GenerationResult> {
      simulateFailure();
      ensureFixture(options.imageFixturePath);
      mkdirSync(dirname(request.outputPath), { recursive: true });
      copyFileSync(options.imageFixturePath, request.outputPath);
      return {
        outputPath: request.outputPath,
        provider: 'mock',
        model: 'mock-image-fixture',
        unit: 'image',
        quantity: 1,
        unitCostUsd: imageUnitCost,
        estimatedCostUsd: imageUnitCost,
      };
    },
  };

  const video: VideoProvider = {
    name: 'mock',
    videoModel: 'mock-video-fixture',
    estimateVideoCost: (request) => videoPerSecond * request.durationSeconds,
    async imageToVideo(request: VideoGenerationRequest): Promise<GenerationResult> {
      simulateFailure();
      if (!existsSync(request.referenceImagePath)) {
        throw new ProviderError('output_missing', `reference image missing: ${request.referenceImagePath}`);
      }
      ensureFixture(options.videoFixturePath);
      mkdirSync(dirname(request.outputPath), { recursive: true });
      copyFileSync(options.videoFixturePath, request.outputPath);
      return {
        outputPath: request.outputPath,
        provider: 'mock',
        model: 'mock-video-fixture',
        unit: 'second',
        quantity: request.durationSeconds,
        unitCostUsd: videoPerSecond,
        estimatedCostUsd: videoPerSecond * request.durationSeconds,
      };
    },
  };

  return { image, video };
}
