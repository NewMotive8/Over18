import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ProviderError,
  type GenerationResult,
  type VideoGenerationRequest,
  type VideoProvider,
} from './types.js';

/**
 * RunPod Public Endpoint — Wan image-to-video (US-84).
 *
 * Wan 2.7 is NOT available on RunPod (no public weights). Closest options:
 *   - wan-2-1-i2v-720  (proven in PoC smoke)
 *   - wan-2-6-i2v      (newer managed endpoint)
 *   - wan-2-2-i2v-720
 *
 * SECRETS: RUNPOD_API_KEY at call time only; never logged.
 */

export interface RunPodPublicVideoOptions {
  /** Public endpoint slug, e.g. wan-2-1-i2v-720 */
  endpointId: string;
  baseUrl?: string;
  unitCostPerSecondUsd?: number;
  contractConfirmed?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  baseUrl: 'https://api.runpod.ai/v2',
  unitCostPerSecondUsd: 0.06,
  timeoutMs: 900_000,
  pollIntervalMs: 5_000,
};

function apiKey(): string {
  const key = (process.env.RUNPOD_API_KEY ?? '').trim();
  if (!key) throw new ProviderError('auth', 'RUNPOD_API_KEY is not set.');
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jobStatus(payload: unknown): string {
  if (payload && typeof payload === 'object' && typeof (payload as { status?: unknown }).status === 'string') {
    return String((payload as { status: string }).status).toUpperCase();
  }
  return '';
}

function jobIdOf(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string') {
    return (payload as { id: string }).id;
  }
  return null;
}

function extractVideoUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const o = payload as Record<string, unknown>;
  const out = o.output;
  if (typeof out === 'string' && /^https?:\/\//i.test(out)) return out;
  if (out && typeof out === 'object') {
    const u = out as Record<string, unknown>;
    for (const k of ['video_url', 'videoUrl', 'url', 'result']) {
      if (typeof u[k] === 'string' && /^https?:\/\//i.test(u[k] as string)) return u[k] as string;
    }
  }
  if (typeof o.video_url === 'string') return o.video_url;
  return null;
}

function sizeForResolution(resolution: string): string {
  const r = resolution.toLowerCase();
  if (r.includes('1080')) return '1080*1920';
  if (r.includes('480')) return '480*854';
  return '720*1280';
}

export function createRunPodPublicVideoProvider(options: RunPodPublicVideoOptions): VideoProvider {
  const cfg = {
    baseUrl: (options.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
    unitCostPerSecondUsd: options.unitCostPerSecondUsd ?? DEFAULTS.unitCostPerSecondUsd,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpointId = options.endpointId;

  return {
    name: 'runpod-wan-i2v',
    videoModel: `runpod/${endpointId}`,
    estimateVideoCost: (req) => cfg.unitCostPerSecondUsd * req.durationSeconds,
    async imageToVideo(request: VideoGenerationRequest): Promise<GenerationResult> {
      if (!options.contractConfirmed) {
        throw new ProviderError(
          'not_verified',
          'Live RunPod video requires MEDIA_RUNPOD_CONFIRM=true and RUNPOD_API_KEY.',
        );
      }
      if (!existsSync(request.referenceImagePath)) {
        throw new ProviderError('output_missing', `reference image missing: ${request.referenceImagePath}`);
      }

      const bytes = readFileSync(request.referenceImagePath);
      const b64 = bytes.toString('base64');
      const body = JSON.stringify({
        input: {
          prompt: request.prompt,
          image: b64,
          duration: request.durationSeconds,
          size: sizeForResolution(request.resolution),
          seed: -1,
          // Wan 2.6 endpoint accepts this; ignored by 2.1 if unknown.
          enable_safety_checker: false,
        },
      });

      const auth = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
      };

      let res: Response;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/${endpointId}/run`, {
          method: 'POST',
          headers: auth,
          body,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError('network', 'could not reach RunPod public video endpoint');
      }

      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
        throw new ProviderError('http', `RunPod video HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        throw new ProviderError('malformed_response', 'RunPod video returned non-JSON');
      }

      let status = jobStatus(payload);
      const id = jobIdOf(payload);
      if (!id) {
        throw new ProviderError('malformed_response', 'RunPod video response had no job id');
      }

      const deadline = Date.now() + cfg.timeoutMs;
      while (status === 'IN_QUEUE' || status === 'IN_PROGRESS' || status === '') {
        if (Date.now() > deadline) {
          throw new ProviderError('http', `RunPod video timed out after ${cfg.timeoutMs}ms`);
        }
        await sleep(DEFAULTS.pollIntervalMs);
        let stRes: Response;
        try {
          stRes = await fetchImpl(`${cfg.baseUrl}/${endpointId}/status/${id}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey()}` },
            signal: AbortSignal.timeout(30_000),
          });
        } catch {
          continue;
        }
        if (!stRes.ok) continue;
        try {
          payload = await stRes.json();
          status = jobStatus(payload);
        } catch {
          continue;
        }
        if (status === 'COMPLETED' || status === 'SUCCESS') break;
        if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
          throw new ProviderError('http', `RunPod video job ${status}`);
        }
      }

      const videoUrl = extractVideoUrl(payload);
      if (!videoUrl) {
        throw new ProviderError(
          'malformed_response',
          'RunPod video completed but no video_url in response',
        );
      }

      let dl: Response;
      try {
        dl = await fetchImpl(videoUrl, { signal: AbortSignal.timeout(120_000) });
      } catch {
        throw new ProviderError('network', 'could not download RunPod video output');
      }
      if (!dl.ok) {
        throw new ProviderError('http', `video download HTTP ${dl.status}`);
      }
      const outBytes = Buffer.from(await dl.arrayBuffer());
      if (outBytes.length < 1000) {
        throw new ProviderError('malformed_response', 'RunPod video payload too small');
      }
      mkdirSync(dirname(request.outputPath), { recursive: true });
      writeFileSync(request.outputPath, outBytes);

      return {
        outputPath: request.outputPath,
        provider: 'runpod-wan-i2v',
        model: `runpod/${endpointId}`,
        unit: 'second',
        quantity: request.durationSeconds,
        unitCostUsd: cfg.unitCostPerSecondUsd,
        estimatedCostUsd: cfg.unitCostPerSecondUsd * request.durationSeconds,
      };
    },
  };
}
