import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
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
 * Atlas Cloud adapter — the ONLY file that knows Atlas exists.
 *
 * ⚠ CONTRACT STATUS: PARTIALLY VERIFIED (docs read 2026-08-12, no live call
 * has been made). What IS documented on atlascloud.ai model pages:
 *   - auth via the ATLASCLOUD_API_KEY environment variable (bearer);
 *   - async video flow: submit → poll a prediction id → result URL;
 *   - models/prices: image flux-kontext-dev $0.025/image; video
 *     wan-2.2-turbo-spicy $0.02/s, wan-2.7-spicy $0.10/s.
 * What is NOT yet verified: exact request/response field names. Therefore this
 * adapter REFUSES to run until a human passes --confirm-contract (after the
 * cheapest possible live probe in US-36), and it treats every response
 * defensively: any missing/unschema'd field aborts the generation — a success
 * is recorded ONLY when the asset bytes are on disk. NEVER invent results.
 *
 * SECRETS: the key is read from the environment at call time, used only in the
 * Authorization header, and never logged, thrown, or written anywhere.
 */

export interface AtlasOptions {
  baseUrl?: string;
  imageModel?: string;
  videoModel?: string;
  imageUnitCostUsd?: number;
  videoUnitCostPerSecondUsd?: number;
  /** Human confirmation that the live contract has been probed (US-36 step 0). */
  contractConfirmed?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  baseUrl: 'https://api.atlascloud.ai/v1',
  imageModel: 'black-forest-labs/flux-kontext-dev',
  videoModel: 'atlascloud/wan-2.7-spicy',
  imageUnitCostUsd: 0.025,
  videoUnitCostPerSecondUsd: 0.1,
  pollIntervalMs: 3000,
  timeoutMs: 300_000,
};

function apiKey(): string {
  const key = process.env.ATLASCLOUD_API_KEY;
  if (!key) {
    throw new ProviderError('auth', 'ATLASCLOUD_API_KEY is not set. Export it in the shell that runs the pipeline; it is never stored.');
  }
  return key;
}

function requireConfirmed(confirmed: boolean | undefined): void {
  if (!confirmed) {
    throw new ProviderError(
      'not_verified',
      'Atlas API contract is not yet verified by a live probe. Run the cheapest probe first (US-36 step 0), then pass --confirm-contract. Refusing to guess at a paid API.',
    );
  }
}

async function downloadTo(url: string, outputPath: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new ProviderError('http', `asset download returned HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new ProviderError('malformed_response', 'asset download was empty');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes);
  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    throw new ProviderError('output_missing', 'asset file was not written');
  }
}

/** Defensive field access: unexpected shape → malformed_response, never success. */
function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProviderError('malformed_response', `Atlas response missing expected field "${field}"`);
  }
  return value;
}

export function createAtlasProviders(options: AtlasOptions = {}): { image: ImageProvider; video: VideoProvider } {
  const cfg = { ...DEFAULTS, ...options };
  const fetchImpl = options.fetchImpl ?? fetch;

  async function atlasPost(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('network', 'could not reach Atlas Cloud');
    }
    if (!res.ok) throw new ProviderError('http', `Atlas returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new ProviderError('malformed_response', 'Atlas returned non-JSON output');
    }
  }

  async function atlasGet(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('network', 'could not reach Atlas Cloud');
    }
    if (!res.ok) throw new ProviderError('http', `Atlas returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new ProviderError('malformed_response', 'Atlas returned non-JSON output');
    }
  }

  /** Documented async pattern: submit → poll /prediction/{id} until a result URL. */
  async function pollPrediction(id: string): Promise<string> {
    const deadline = Date.now() + cfg.timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new ProviderError('network', 'Atlas prediction polling timed out');
      const body = (await atlasGet(`/prediction/${id}`)) as {
        status?: unknown;
        output?: { url?: unknown } | unknown;
        error?: unknown;
      };
      const status = expectString(body.status, 'status');
      if (status === 'failed' || status === 'canceled') {
        throw new ProviderError('http', `Atlas prediction ended with status "${status}"`);
      }
      if (status === 'succeeded' || status === 'completed') {
        const url = (body.output as { url?: unknown } | undefined)?.url;
        return expectString(url, 'output.url');
      }
      await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs));
    }
  }

  const image: ImageProvider = {
    name: 'atlas',
    imageModel: cfg.imageModel,
    estimateImageCost: () => cfg.imageUnitCostUsd,
    async generateImage(request: ImageGenerationRequest): Promise<GenerationResult> {
      requireConfirmed(cfg.contractConfirmed);
      const body = (await atlasPost('/generateImage', {
        model: cfg.imageModel,
        prompt: request.prompt,
        width: request.width,
        height: request.height,
      })) as { id?: unknown; output?: { url?: unknown } };
      // Either an immediate result URL or an async prediction id.
      const direct = (body.output as { url?: unknown } | undefined)?.url;
      const url = typeof direct === 'string' && direct.length > 0 ? direct : await pollPrediction(expectString(body.id, 'id'));
      await downloadTo(url, request.outputPath, fetchImpl);
      return {
        outputPath: request.outputPath,
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
      const reference = Buffer.from(await import('node:fs').then((fs) => fs.readFileSync(request.referenceImagePath))).toString('base64');
      const body = (await atlasPost('/generateVideo', {
        model: cfg.videoModel,
        prompt: request.prompt,
        image: reference, // documented: Base64 or URL image inputs
        duration: request.durationSeconds,
        resolution: request.resolution,
      })) as { id?: unknown };
      const url = await pollPrediction(expectString(body.id, 'id'));
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
