import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ProviderError,
  type GenerationResult,
  type ImageGenerationRequest,
  type ImageProvider,
  type MediaProviders,
  type VideoGenerationRequest,
  type VideoProvider,
} from './types.js';

/**
 * RunPod Serverless ComfyUI adapter (US-87).
 * Tries baseUrl, then the alternate official host if the first fails at network layer.
 * SECRETS: RUNPOD_API_KEY at call time only; never logged.
 */

export interface RunPodImageOptions {
  endpointId: string;
  baseUrl?: string;
  imageUnitCostUsd?: number;
  workflow?: Record<string, unknown>;
  promptNodeId?: string;
  loadImageNodeId?: string;
  contractConfirmed?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  baseUrl: 'https://api.runpod.ai/v2',
  imageUnitCostUsd: 0.05,
  promptNodeId: '6',
  timeoutMs: 600_000,
};

const ALT_BASE = 'https://api1.runpod.ai/v2';

export const DEFAULT_COMFY_WORKFLOW: Record<string, unknown> = {
  '6': {
    inputs: { text: 'PROMPT_PLACEHOLDER', clip: ['30', 1] },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'CLIP Text Encode (Positive Prompt)' },
  },
  '8': {
    inputs: { samples: ['31', 0], vae: ['30', 2] },
    class_type: 'VAEDecode',
    _meta: { title: 'VAE Decode' },
  },
  '9': {
    inputs: { filename_prefix: 'Over18', images: ['8', 0] },
    class_type: 'SaveImage',
    _meta: { title: 'Save Image' },
  },
  '27': {
    inputs: { width: 768, height: 1024, batch_size: 1 },
    class_type: 'EmptySD3LatentImage',
    _meta: { title: 'EmptySD3LatentImage' },
  },
  '30': {
    inputs: { ckpt_name: 'flux1-dev-fp8.safetensors' },
    class_type: 'CheckpointLoaderSimple',
    _meta: { title: 'Load Checkpoint' },
  },
  '31': {
    inputs: {
      seed: 0,
      steps: 20,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1,
      model: ['30', 0],
      positive: ['6', 0],
      negative: ['33', 0],
      latent_image: ['27', 0],
    },
    class_type: 'KSampler',
    _meta: { title: 'KSampler' },
  },
  '33': {
    inputs: { text: '', clip: ['30', 1] },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'CLIP Text Encode (Negative Prompt)' },
  },
  '35': {
    inputs: { guidance: 3.5, conditioning: ['6', 0] },
    class_type: 'FluxGuidance',
    _meta: { title: 'FluxGuidance' },
  },
};

function apiKey(): string {
  const key = (process.env.RUNPOD_API_KEY ?? '').trim();
  if (!key) throw new ProviderError('auth', 'RUNPOD_API_KEY is not set.');
  return key;
}

function requireConfirmed(confirmed: boolean | undefined): void {
  if (!confirmed) {
    throw new ProviderError(
      'not_verified',
      'Live RunPod calls require MEDIA_RUNPOD_CONFIRM=true (and key + endpoint).',
    );
  }
}

function patchPrompt(
  workflow: Record<string, unknown>,
  promptNodeId: string,
  prompt: string,
): Record<string, unknown> {
  const cloned = structuredClone(workflow) as Record<string, unknown>;
  const node = cloned[promptNodeId] as { inputs?: Record<string, unknown> } | undefined;
  if (!node?.inputs) {
    throw new ProviderError(
      'unsupported_request',
      `Comfy workflow missing prompt node "${promptNodeId}" (inputs.text)`,
    );
  }
  node.inputs.text = prompt;
  for (const value of Object.values(cloned)) {
    const n = value as { inputs?: Record<string, unknown> };
    if (n?.inputs && typeof n.inputs.seed === 'number') {
      n.inputs.seed = Math.floor(Math.random() * 1_000_000_000);
    }
  }
  return cloned;
}

function stripDataUrl(b64: string): string {
  const m = /^data:[^;]+;base64,(.+)$/i.exec(b64);
  return m ? m[1]! : b64;
}

function extractBase64Images(payload: unknown): string[] {
  const found: string[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      if (
        v.startsWith('data:image/') ||
        (v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 80)))
      ) {
        if (v.length > 500) found.push(stripDataUrl(v.trim()));
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.image === 'string') visit(o.image, depth + 1);
      if (typeof o.data === 'string') visit(o.data, depth + 1);
      if (Array.isArray(o.images)) visit(o.images, depth + 1);
      if (o.output != null) visit(o.output, depth + 1);
      for (const [k, val] of Object.entries(o)) {
        if (k === 'image' || k === 'data' || k === 'images' || k === 'output') continue;
        visit(val, depth + 1);
      }
    }
  };
  visit(payload, 0);
  return found;
}

function candidateBases(preferred: string): string[] {
  const p = preferred.replace(/\/+$/, '');
  const alt = p.includes('api1.') ? DEFAULTS.baseUrl : ALT_BASE;
  return p === alt ? [p] : [p, alt];
}

export function createRunPodImageProvider(options: RunPodImageOptions): ImageProvider {
  const cfg = {
    baseUrl: options.baseUrl ?? DEFAULTS.baseUrl,
    imageUnitCostUsd: options.imageUnitCostUsd ?? DEFAULTS.imageUnitCostUsd,
    promptNodeId: options.promptNodeId ?? DEFAULTS.promptNodeId,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const workflowTemplate = options.workflow ?? DEFAULT_COMFY_WORKFLOW;

  return {
    name: 'runpod-comfyui',
    imageModel: `runpod/${options.endpointId}`,
    estimateImageCost: () => cfg.imageUnitCostUsd,
    async generateImage(request: ImageGenerationRequest): Promise<GenerationResult> {
      requireConfirmed(options.contractConfirmed);

      const workflow = patchPrompt(workflowTemplate, cfg.promptNodeId, request.prompt);
      const images: Array<{ name: string; image: string }> = [];
      if (request.referenceImagePath) {
        if (!existsSync(request.referenceImagePath)) {
          throw new ProviderError(
            'output_missing',
            `reference image missing: ${request.referenceImagePath}`,
          );
        }
        const bytes = readFileSync(request.referenceImagePath);
        images.push({
          name: 'reference.png',
          image: `data:image/png;base64,${bytes.toString('base64')}`,
        });
      }

      const body = JSON.stringify({
        input: {
          workflow,
          ...(images.length ? { images } : {}),
        },
      });

      const bases = candidateBases(cfg.baseUrl);
      let lastNet = '';
      let res: Response | null = null;
      let usedBase = bases[0]!;

      for (const base of bases) {
        const url = `${base}/${options.endpointId}/runsync`;
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey()}`,
            },
            body,
            signal: AbortSignal.timeout(cfg.timeoutMs),
          });
          usedBase = base;
          // 404 on first host → try alternate before giving up
          if (res.status === 404 && bases.length > 1 && base === bases[0]) {
            lastNet = `HTTP 404 from ${base}`;
            continue;
          }
          break;
        } catch (err) {
          if (err instanceof ProviderError) throw err;
          lastNet = err instanceof Error ? err.message : String(err);
          res = null;
        }
      }

      if (!res) {
        throw new ProviderError(
          'network',
          `could not reach RunPod (tried ${bases.join(', ')}): ${lastNet.slice(0, 180)}`,
        );
      }

      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 200);
        } catch {
          /* ignore */
        }
        throw new ProviderError(
          'http',
          `RunPod HTTP ${res.status} via ${usedBase}${detail ? `: ${detail}` : ''}`,
        );
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        throw new ProviderError('malformed_response', 'RunPod returned non-JSON');
      }

      const status =
        typeof (payload as { status?: unknown })?.status === 'string'
          ? String((payload as { status: string }).status).toUpperCase()
          : '';
      if (status && status !== 'COMPLETED' && status !== 'SUCCESS') {
        const errMsg =
          typeof (payload as { error?: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : status;
        throw new ProviderError('http', `RunPod job did not complete: ${errMsg.slice(0, 300)}`);
      }

      const b64s = extractBase64Images(payload);
      if (b64s.length === 0) {
        throw new ProviderError(
          'malformed_response',
          'RunPod response contained no image bytes (check workflow / worker output shape)',
        );
      }

      const outBytes = Buffer.from(b64s[0]!, 'base64');
      if (outBytes.length < 100) {
        throw new ProviderError('malformed_response', 'RunPod image payload too small');
      }
      mkdirSync(dirname(request.outputPath), { recursive: true });
      writeFileSync(request.outputPath, outBytes);

      return {
        outputPath: request.outputPath,
        provider: 'runpod-comfyui',
        model: `runpod/${options.endpointId}`,
        unit: 'image',
        quantity: 1,
        unitCostUsd: cfg.imageUnitCostUsd,
        estimatedCostUsd: cfg.imageUnitCostUsd,
      };
    },
  };
}

export function createRunPodImageOnlyProviders(
  imageOpts: RunPodImageOptions,
  video: VideoProvider,
): MediaProviders {
  return {
    image: createRunPodImageProvider(imageOpts),
    video,
  };
}

export function createUnavailableVideoProvider(reason: string): VideoProvider {
  return {
    name: 'unavailable',
    videoModel: 'none',
    estimateVideoCost: () => 0.01,
    async imageToVideo(_request: VideoGenerationRequest): Promise<GenerationResult> {
      throw new ProviderError('unsupported_request', reason);
    },
  };
}
