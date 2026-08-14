import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { sniffImageFormat, type ImageFormat } from './media-qa.js';
import {
  ProviderError,
  type GenerationResult,
  type ImageGenerationRequest,
  type ImageProvider,
  type VideoGenerationRequest,
  type VideoProvider,
} from './types.js';

export interface AtlasOptions {
  baseUrl?: string;
  imageModel?: string;
  videoModel?: string;
  imageUnitCostUsd?: number;
  videoUnitCostPerSecondUsd?: number;
  videoResolutionCase?: 'upper' | 'lower';
  videoNegativePrompt?: string;
  contractConfirmed?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  pollTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  baseUrl: 'https://api.atlascloud.ai/api/v1',
  imageModel: 'black-forest-labs/flux-kontext-dev',
  videoModel: 'atlascloud/wan-2.7-spicy/image-to-video',
  imageUnitCostUsd: 0.025,
  videoUnitCostPerSecondUsd: 0.1,
  pollIntervalMs: 3000,
  timeoutMs: 300_000,
  videoNegativePrompt:
    'camera cut, shot change, scene change, transition, jump cut, rapid editing, montage, multi-shot, multiple camera angles, perspective shift',
};

const SUCCESS_STATUSES = new Set(['succeeded', 'completed', 'success']);
const FAILURE_STATUSES = new Set(['failed', 'canceled', 'cancelled', 'error']);
const DEFAULT_POLL_TIMEOUT_MS = 900_000;

function apiKey(): string {
  const key = process.env.ATLASCLOUD_API_KEY;
  if (!key) {
    throw new ProviderError('auth', 'ATLASCLOUD_API_KEY is not set.');
  }
  return key;
}

function requireConfirmed(confirmed: boolean | undefined): void {
  if (!confirmed) {
    throw new ProviderError('not_verified', 'Live Atlas calls require contractConfirmed.');
  }
}

interface AtlasEnvelope {
  id?: unknown;
  status?: unknown;
  output?: unknown;
  outputs?: unknown;
  error?: unknown;
  urls?: { result?: unknown } | unknown;
  data?: unknown;
}

export function describeShape(value: unknown, depth = 1): string {
  if (value === null || typeof value !== 'object') return typeof value;
  const parts = Object.entries(value as Record<string, unknown>).map(([key, v]) => {
    if (Array.isArray(v)) return `${key}:array(${v.length})`;
    if (v === null) return `${key}:null`;
    if (typeof v === 'object' && depth > 0) return `${key}:${describeShape(v, depth - 1)}`;
    return `${key}:${typeof v}`;
  });
  return `{${parts.join(', ')}}`;
}

export function normalizeFluxSize(
  width: number,
  height: number,
  maxPixels = 2_000_000,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ProviderError('malformed_response', `invalid requested image size ${width}x${height}`);
  }
  let w = width;
  let h = height;
  if (w * h > maxPixels) {
    const scale = Math.sqrt(maxPixels / (w * h));
    w *= scale;
    h *= scale;
  }
  const snap = (v: number): number => Math.max(64, Math.round(v / 16) * 16);
  return { width: snap(w), height: snap(h) };
}

export function normalizeWanResolution(model: string, resolution: string, override?: 'upper' | 'lower'): string {
  const wants = override ?? (/wan-2\.[67]/i.test(model) ? 'upper' : 'lower');
  return wants === 'upper' ? resolution.toUpperCase() : resolution.toLowerCase();
}

export function validateWanDuration(model: string, durationSeconds: number): void {
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new ProviderError('unsupported_request', `video duration must be a positive whole number of seconds, got ${durationSeconds}`);
  }
  if (/wan-2\.2/i.test(model) && ![5, 8].includes(durationSeconds)) {
    throw new ProviderError('unsupported_request', `model ${model} supports only 5s or 8s clips, got ${durationSeconds}s`);
  }
  if (/wan-2\.[67]/i.test(model) && (durationSeconds < 2 || durationSeconds > 15)) {
    throw new ProviderError('unsupported_request', `model ${model} supports 2-15s clips, got ${durationSeconds}s`);
  }
}

function unwrap(envelope: AtlasEnvelope): AtlasEnvelope {
  if (envelope && typeof envelope === 'object' && envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)) {
    return envelope.data as AtlasEnvelope;
  }
  return envelope;
}

function extractOutputUrl(envelope: AtlasEnvelope): string | null {
  for (const field of [envelope.outputs, envelope.output]) {
    if (Array.isArray(field)) {
      const first = field[0];
      if (typeof first === 'string' && first.length > 0) return first;
    }
    if (typeof field === 'string' && field.length > 0) return field;
    if (field && typeof field === 'object' && !Array.isArray(field) && typeof (field as { url?: unknown }).url === 'string') {
      return (field as { url: string }).url;
    }
  }
  return null;
}

async function fetchBytes(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new ProviderError('http', `asset download returned HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new ProviderError('malformed_response', 'asset download was empty');
  return bytes;
}

function writeBytes(outputPath: string, bytes: Buffer): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes);
  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    throw new ProviderError('output_missing', 'asset file was not written');
  }
}

async function downloadTo(url: string, outputPath: string, fetchImpl: typeof fetch): Promise<void> {
  writeBytes(outputPath, await fetchBytes(url, fetchImpl));
}

const CANONICAL_IMAGE_EXT: Record<ImageFormat, string> = { jpeg: '.jpg', png: '.png', webp: '.webp' };
const ACCEPTED_IMAGE_EXT: Record<ImageFormat, string[]> = { jpeg: ['.jpg', '.jpeg'], png: ['.png'], webp: ['.webp'] };

function truthfulImagePath(requestedPath: string, format: ImageFormat): string {
  const ext = extname(requestedPath).toLowerCase();
  if (ACCEPTED_IMAGE_EXT[format].includes(ext)) return requestedPath;
  const base = ext ? requestedPath.slice(0, requestedPath.length - ext.length) : requestedPath;
  return base + CANONICAL_IMAGE_EXT[format];
}

export function createAtlasProviders(options: AtlasOptions = {}): { image: ImageProvider; video: VideoProvider } {
  const cfg = { ...DEFAULTS, ...options };
  const fetchImpl = options.fetchImpl ?? fetch;

  async function atlasRequest(method: 'GET' | 'POST', url: string, body?: unknown): Promise<AtlasEnvelope> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${apiKey()}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('network', 'could not reach Atlas Cloud');
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 400);
      } catch {
        /* ignore */
      }
      throw new ProviderError(
        'http',
        `Atlas returned HTTP ${res.status} for ${new URL(url).pathname}${detail ? `: ${detail}` : ''}`,
      );
    }
    try {
      return (await res.json()) as AtlasEnvelope;
    } catch {
      throw new ProviderError('malformed_response', 'Atlas returned non-JSON output');
    }
  }

  async function uploadMedia(filePath: string): Promise<string> {
    const bytes = readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), basename(filePath));
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/model/uploadMedia`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}` },
        body: form,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('network', 'could not reach Atlas Cloud to upload the reference image');
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new ProviderError('http', `Atlas returned HTTP ${res.status} for /model/uploadMedia${detail ? `: ${detail}` : ''}`);
    }
    let payload: AtlasEnvelope;
    try {
      payload = (await res.json()) as AtlasEnvelope;
    } catch {
      throw new ProviderError('malformed_response', 'Atlas upload returned non-JSON output');
    }
    const body = unwrap(payload) as { url?: unknown; download_url?: unknown };
    for (const candidate of [body.url, body.download_url]) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    throw new ProviderError(
      'malformed_response',
      `Atlas upload returned no usable URL (response shape: ${describeShape(unwrap(payload))})`,
    );
  }

  async function resolveOutput(rawEnvelope: AtlasEnvelope): Promise<string> {
    let envelope = unwrap(rawEnvelope);
    const submitId = typeof envelope.id === 'string' && envelope.id.length > 0 ? envelope.id : undefined;
    let polled = false;
    const deadline = Date.now() + (options.pollTimeoutMs ?? options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
    for (;;) {
      const statusRaw = envelope.status;
      const status = typeof statusRaw === 'string' && statusRaw.length > 0 ? statusRaw.toLowerCase() : undefined;
      const outputUrl = extractOutputUrl(envelope);
      const providerError =
        typeof envelope.error === 'string' && envelope.error.trim().length > 0
          ? envelope.error.trim()
          : undefined;

      if (providerError) {
        throw new ProviderError('http', `Atlas reported a generation error: ${providerError.slice(0, 300)}`);
      }
      if (status !== undefined && SUCCESS_STATUSES.has(status)) {
        if (outputUrl) return outputUrl;
        throw new ProviderError(
          'malformed_response',
          `Atlas reported success without a usable output URL (response shape: ${describeShape(envelope)})`,
        );
      }
      if (status !== undefined && FAILURE_STATUSES.has(status)) {
        throw new ProviderError('http', `Atlas generation ended with status "${status}"`);
      }
      if (status === undefined) {
        if (outputUrl) return outputUrl;
        if (!submitId) {
          throw new ProviderError(
            'malformed_response',
            `Atlas response has no status, no id to poll, and no usable output (response shape: ${describeShape(envelope)})`,
          );
        }
      }
      const pollUrl = submitId
        ? `${cfg.baseUrl}/model/prediction/${submitId}`
        : typeof (envelope.urls as { result?: unknown } | undefined)?.result === 'string'
          ? ((envelope.urls as { result: string }).result as string)
          : undefined;
      if (!pollUrl) {
        throw new ProviderError(
          'malformed_response',
          `Atlas response is in progress but has no id or urls.result to poll (response shape: ${describeShape(envelope)})`,
        );
      }
      if (Date.now() > deadline) throw new ProviderError('network', 'Atlas result polling timed out');
      await new Promise((resolve) => setTimeout(resolve, polled ? cfg.pollIntervalMs : Math.min(cfg.pollIntervalMs, 1000)));
      polled = true;
      envelope = unwrap(await atlasRequest('GET', pollUrl));
    }
  }

  const image: ImageProvider = {
    name: 'atlas',
    imageModel: cfg.imageModel,
    estimateImageCost: () => cfg.imageUnitCostUsd,
    async generateImage(request: ImageGenerationRequest): Promise<GenerationResult> {
      requireConfirmed(cfg.contractConfirmed);
      const native = normalizeFluxSize(request.width, request.height);
      if (native.width !== request.width || native.height !== request.height) {
        console.warn(
          `! image size normalized to model-native ${native.width}x${native.height} (requested ${request.width}x${request.height})`,
        );
      }
      let referenceUrl: string | undefined;
      if (request.referenceImagePath) {
        if (!existsSync(request.referenceImagePath)) {
          throw new ProviderError('output_missing', `reference image missing: ${request.referenceImagePath}`);
        }
        referenceUrl = await uploadMedia(request.referenceImagePath);
      }
      const envelope = await atlasRequest('POST', `${cfg.baseUrl}/model/generateImage`, {
        model: cfg.imageModel,
        prompt: request.prompt,
        size: `${native.width}*${native.height}`,
        num_images: 1,
        ...(referenceUrl ? { image: referenceUrl, enable_safety_checker: false } : {}),
      });
      const url = await resolveOutput(envelope);
      const bytes = await fetchBytes(url, fetchImpl);
      const format = sniffImageFormat(bytes);
      if (!format) {
        throw new ProviderError('malformed_response', 'downloaded asset is not a recognized image (jpeg/png/webp)');
      }
      const outputPath = truthfulImagePath(request.outputPath, format);
      writeBytes(outputPath, bytes);
      return {
        outputPath,
        provider: 'atlas',
        model: cfg.imageModel,
        unit: 'image',
        quantity: 1,
        unitCostUsd: cfg.imageUnitCostUsd,
        estimatedCostUsd: cfg.imageUnitCostUsd,
      };
    },
  };

  const video: VideoProvider = {
    name: 'atlas',
    videoModel: cfg.videoModel,
    estimateVideoCost: (request) => cfg.videoUnitCostPerSecondUsd * request.durationSeconds,
    async imageToVideo(request: VideoGenerationRequest): Promise<GenerationResult> {
      requireConfirmed(cfg.contractConfirmed);
      if (!existsSync(request.referenceImagePath)) {
        throw new ProviderError('output_missing', `reference image missing: ${request.referenceImagePath}`);
      }
      validateWanDuration(cfg.videoModel, request.durationSeconds);
      // Docs: image = URL or Base64. Try upload URL first; on HTTP 400 retry data-URI.
      const imgBytes = readFileSync(request.referenceImagePath);
      const ext = extname(request.referenceImagePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const imageDataUri = `data:${mime};base64,${imgBytes.toString('base64')}`;
      let imageRef: string;
      try {
        imageRef = await uploadMedia(request.referenceImagePath);
      } catch {
        imageRef = imageDataUri;
      }
      const negativePrompt = cfg.videoNegativePrompt;
      const body = {
        model: cfg.videoModel,
        image: imageRef,
        prompt: request.prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        resolution: normalizeWanResolution(cfg.videoModel, request.resolution, cfg.videoResolutionCase),
        duration: request.durationSeconds,
        seed: -1,
      };
      let envelope: AtlasEnvelope;
      try {
        envelope = await atlasRequest('POST', `${cfg.baseUrl}/model/generateVideo`, body);
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'http' && imageRef !== imageDataUri) {
          envelope = await atlasRequest('POST', `${cfg.baseUrl}/model/generateVideo`, {
            ...body,
            image: imageDataUri,
          });
        } else {
          throw err;
        }
      }
      const url = await resolveOutput(envelope);
      await downloadTo(url, request.outputPath, fetchImpl);
      return {
        outputPath: request.outputPath,
        provider: 'atlas',
        model: cfg.videoModel,
        unit: 'second',
        quantity: request.durationSeconds,
        unitCostUsd: cfg.videoUnitCostPerSecondUsd,
        estimatedCostUsd: cfg.videoUnitCostPerSecondUsd * request.durationSeconds,
      };
    },
  };

  return { image, video };
}
