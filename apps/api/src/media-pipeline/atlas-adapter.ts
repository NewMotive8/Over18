import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
 * CONTRACT (verified against the official docs, 2026-08-12, after the live
 * probe returned HTTP 404 against the previous guessed paths):
 *   - Base API:        https://api.atlascloud.ai/api/v1
 *   - Image submit:    POST /model/generateImage
 *                      body { model, prompt, size: "W*H" (asterisk!), num_images }
 *   - Video submit:    POST /model/generateVideo  (same /model/ prefix pattern;
 *                      wan model docs: submit → poll → result URL)
 *   - Auth:            Authorization: Bearer $ATLASCLOUD_API_KEY
 *   - Response envelope: { id, status, output: [urls...], urls: { result }, ... }
 *     Generation is ASYNC: initial status "processing"; poll the ABSOLUTE
 *     urls.result URL from the envelope (never a constructed path).
 *   - Poll response: same envelope; success when status ∈ {succeeded, completed,
 *     success} with a usable output; failure on {failed, canceled, cancelled,
 *     error}; keep polling on {processing, pending, queued, starting, running}.
 *     Any OTHER status or shape is rejected as malformed — never a success.
 *   - output variants accepted (documented array-of-URLs, plus tolerated
 *     url-string / {url} forms some model pages show): anything else rejected.
 *
 * Defensive rules unchanged: a success is recorded ONLY when the asset bytes
 * are verified on disk; unexpected responses abort loudly. --confirm-contract
 * remains the explicit human gate for live paid calls.
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
  /** Human confirmation gate for live paid calls. */
  contractConfirmed?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  baseUrl: 'https://api.atlascloud.ai/api/v1',
  imageModel: 'black-forest-labs/flux-kontext-dev',
  videoModel: 'atlascloud/wan-2.7-spicy',
  imageUnitCostUsd: 0.025,
  videoUnitCostPerSecondUsd: 0.1,
  pollIntervalMs: 3000,
  timeoutMs: 300_000,
};

const CONTINUE_STATUSES = new Set(['processing', 'pending', 'queued', 'starting', 'running']);
const SUCCESS_STATUSES = new Set(['succeeded', 'completed', 'success']);
const FAILURE_STATUSES = new Set(['failed', 'canceled', 'cancelled', 'error']);

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
      'Live Atlas calls require the explicit --confirm-contract gate. Refusing to spend without it.',
    );
  }
}

/** Envelope fields we rely on; everything is checked before use. */
interface AtlasEnvelope {
  id?: unknown;
  status?: unknown;
  output?: unknown;
  urls?: { result?: unknown } | unknown;
  data?: unknown;
}

/**
 * SANITIZED shape summary for diagnostics: top-level key names, value types,
 * and array lengths ONLY — never values, so no credential, URL, or prompt
 * material can leak into errors, run-records, or the ledger.
 */
export function describeShape(value: unknown): string {
  if (value === null || typeof value !== 'object') return typeof value;
  const parts = Object.entries(value as Record<string, unknown>).map(([key, v]) => {
    if (Array.isArray(v)) return `${key}:array(${v.length})`;
    if (v === null) return `${key}:null`;
    return `${key}:${typeof v}`;
  });
  return `{${parts.join(', ')}}`;
}

/** Some gateways wrap the documented envelope in a {data: {...}} container. */
function unwrap(envelope: AtlasEnvelope): AtlasEnvelope {
  if (envelope && typeof envelope === 'object' && envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)) {
    return envelope.data as AtlasEnvelope;
  }
  return envelope;
}


/** Accepts the documented output variants; rejects anything else. */
function extractOutputUrl(output: unknown): string | null {
  if (Array.isArray(output)) {
    const first = output[0];
    return typeof first === 'string' && first.length > 0 ? first : null;
  }
  if (typeof output === 'string' && output.length > 0) return output;
  if (output && typeof output === 'object' && typeof (output as { url?: unknown }).url === 'string') {
    return (output as { url: string }).url;
  }
  return null;
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
    if (!res.ok) throw new ProviderError('http', `Atlas returned HTTP ${res.status} for ${new URL(url).pathname}`);
    try {
      return (await res.json()) as AtlasEnvelope;
    } catch {
      throw new ProviderError('malformed_response', 'Atlas returned non-JSON output');
    }
  }

  /**
   * Resolves a submit/poll envelope to the final output URL.
   *
   * The LIVE API has been observed returning envelopes WITHOUT the top-level
   * `status` the docs show (US-36 probe #2), so `status` is now optional and
   * every path stays verifiable — success is never inferred from an unknown
   * shape:
   * - `data`-wrapped envelopes are unwrapped first;
   * - a success status requires a usable output URL;
   * - a failure status aborts;
   * - a continue status (or NO status) with `urls.result` → poll that ABSOLUTE
   *   URL until a terminal state;
   * - NO status and no poll URL but a usable output URL → treat as a sync
   *   result; the subsequent download must produce non-empty bytes, which is
   *   the actual success verification;
   * - anything else → malformed, with a SANITIZED key/type shape summary so
   *   the next live attempt is self-diagnosing without leaking values.
   */
  async function resolveOutput(rawEnvelope: AtlasEnvelope): Promise<string> {
    let envelope = unwrap(rawEnvelope);
    let polled = false;
    const deadline = Date.now() + cfg.timeoutMs;
    for (;;) {
      const statusRaw = envelope.status;
      const status = typeof statusRaw === 'string' && statusRaw.length > 0 ? statusRaw.toLowerCase() : undefined;
      const outputUrl = extractOutputUrl(envelope.output);
      const resultUrl = (envelope.urls as { result?: unknown } | undefined)?.result;
      const canPoll = typeof resultUrl === 'string' && resultUrl.length > 0;

      if (status !== undefined) {
        if (SUCCESS_STATUSES.has(status)) {
          if (outputUrl) return outputUrl;
          throw new ProviderError('malformed_response', `Atlas reported success without a usable output URL (response shape: ${describeShape(envelope)})`);
        }
        if (FAILURE_STATUSES.has(status)) {
          throw new ProviderError('http', `Atlas generation ended with status "${status}"`);
        }
        if (!CONTINUE_STATUSES.has(status)) {
          throw new ProviderError('malformed_response', `Atlas returned unknown status "${status}" (response shape: ${describeShape(envelope)})`);
        }
        // continue status → fall through to polling below
      } else if (!canPoll) {
        // No status and nothing to poll: a sync result is acceptable ONLY if
        // there is an output URL to download — bytes on disk verify success.
        if (outputUrl) return outputUrl;
        throw new ProviderError(
          'malformed_response',
          `Atlas response has no status, no urls.result, and no usable output (response shape: ${describeShape(envelope)})`,
        );
      }

      if (!canPoll) {
        throw new ProviderError('malformed_response', `Atlas response is in progress but has no urls.result to poll (response shape: ${describeShape(envelope)})`);
      }
      if (Date.now() > deadline) throw new ProviderError('network', 'Atlas result polling timed out');
      await new Promise((resolve) => setTimeout(resolve, polled ? cfg.pollIntervalMs : Math.min(cfg.pollIntervalMs, 1000)));
      polled = true;
      envelope = unwrap(await atlasRequest('GET', resultUrl as string));
    }
  }

  const image: ImageProvider = {
    name: 'atlas',
    imageModel: cfg.imageModel,
    estimateImageCost: () => cfg.imageUnitCostUsd,
    async generateImage(request: ImageGenerationRequest): Promise<GenerationResult> {
      requireConfirmed(cfg.contractConfirmed);
      const envelope = await atlasRequest('POST', `${cfg.baseUrl}/model/generateImage`, {
        model: cfg.imageModel,
        prompt: request.prompt,
        // Documented size format uses an ASTERISK separator, e.g. "1024*1024".
        size: `${request.width}*${request.height}`,
        num_images: 1,
      });
      const url = await resolveOutput(envelope);
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
      const reference = readFileSync(request.referenceImagePath).toString('base64');
      const envelope = await atlasRequest('POST', `${cfg.baseUrl}/model/generateVideo`, {
        model: cfg.videoModel,
        prompt: request.prompt,
        image: reference, // documented: Base64 or URL image inputs
        duration: request.durationSeconds,
        // Wan model pages document uppercase resolution labels (720P/1080P).
        resolution: request.resolution.toUpperCase(),
      });
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
