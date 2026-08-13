import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
 * Deterministic zero-cost mock provider for pipeline validation.
 *
 * Copies fixture files when present. If a fixture path is missing (common on
 * Railway API deploys that don't include apps/web/public/media), writes a tiny
 * valid placeholder so the job path still completes end-to-end.
 */

export interface MockOptions {
  imageFixturePath: string;
  videoFixturePath: string;
  imageUnitCostUsd?: number;
  videoUnitCostPerSecondUsd?: number;
  failureMode?: 'provider_error' | 'malformed_response';
}

/** Minimal valid 1x1 JPEG (bytes). */
const MINI_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUQEhIVFRUVFRUVFRUVFRUVFRUWFxUXFhUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAACAwEBAQAAAAAAAAAAAAADBAECBQYAB//EAD0QAAIBAgQDBgQFAwUAAAAAAAECAwQRAAUSITFBBhMiUWFxMoGRFEJSobHB0fAHFSNictLh8RYWQ1OCk//EABkBAAMBAQEAAAAAAAAAAAAAAAABAgMEBf/EACIRAAICAQUBAQEBAQAAAAAAAAABAhEDITESQQRREyJhcTH/2gAMAwEAAhEDEQA/APfQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//Z',
  'base64',
);

/** Minimal valid-ish MP4 ftyp placeholder (not a full video, enough for bytes on disk). */
const MINI_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x31, 0x00, 0x00, 0x00, 0x08,
  0x66, 0x72, 0x65, 0x65,
]);

export function createMockProviders(options: MockOptions): { image: ImageProvider; video: VideoProvider } {
  const imageUnitCost = options.imageUnitCostUsd ?? 0.025;
  const videoPerSecond = options.videoUnitCostPerSecondUsd ?? 0.02;

  function materialize(fixturePath: string, outputPath: string, fallback: Buffer): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    if (existsSync(fixturePath)) {
      copyFileSync(fixturePath, outputPath);
      return;
    }
    writeFileSync(outputPath, fallback);
  }

  function simulateFailure(): void {
    if (options.failureMode === 'provider_error') {
      throw new ProviderError('http', 'mock provider returned HTTP 500');
    }
    if (options.failureMode === 'malformed_response') {
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
      materialize(options.imageFixturePath, request.outputPath, MINI_JPEG);
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
      materialize(options.videoFixturePath, request.outputPath, MINI_MP4);
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
