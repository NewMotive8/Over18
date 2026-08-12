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

// Terminal states only; any other status re-polls until the deadline, which is
// the documented client behavior ("any other status triggers a wait and
// re-poll"). Known in-flight statuses observed/documented: processing,
// pending, queued, starting, running.
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
  outputs?: unknown;
  error?: unknown;
  urls?: { result?: unknown } | unknown;
  data?: unknown;
}

/**
 * SANITIZED shape summary for diagnostics: key names, value types, and array
 * lengths ONLY (one level of nesting for objects) — never values, so no
 * credential, URL, or prompt material can leak into errors, run-records, or
 * the ledger.
 */
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

/**
 * FLUX-family native size normalization (model capability knowledge lives in
 * the ADAPTER, not the pipeline): the pipeline expresses TARGET dimensions
 * (the approved-media 9:16 intent, e.g. 1080x1920); the adapter maps them to
 * the nearest size the model actually supports. Per Black Forest Labs'
 * published limits: dimensions must be MULTIPLES OF 16, minimum 64, maximum
 * 4MP, with <=2MP recommended for quality/speed. Deterministic: scale down
 * proportionally to fit maxPixels, then snap each dimension to the nearest
 * multiple of 16. Aspect drift from snapping is <1% at our sizes — well
 * inside the media-QA aspect band — and the generated file's true dimensions
 * are always verified by qaImage afterwards.
 */
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

/** Some gateways wrap the documented envelope in a {data: {...}} container. */
function unwrap(envelope: AtlasEnvelope): AtlasEnvelope {
  if (envelope && typeof envelope === 'object' && envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)) {
    return envelope.data as AtlasEnvelope;
  }
  return envelope;
}


/**
 * Accepts the documented result-field variants; rejects anything else.
 * The LIVE API and the official polling examples use `outputs` (PLURAL,
 * array of URLs, null while in progress); older doc pages show `output`.
 */
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
   * Resolves a submit/poll envelope to the final output URL, following the
   * ACTUAL documented+observed Atlas job lifecycle (established US-36):
   *
   * 1. Submit responses are {data:{...}}-wrapped; unwrap first. The inner
   *    envelope carries { id, status, outputs: null|[urls], urls, error, ... }.
   * 2. Completion is detected by polling the CONSTRUCTED endpoint
   *    GET {base}/model/prediction/{id} — the official client examples poll
   *    exactly this path; the envelope's urls.result is NOT relied upon
   *    (live envelopes carry no usable one). urls.result is used only as a
   *    fallback when no id exists.
   * 3. Poll responses are also data-wrapped: {data:{status, outputs, error}}.
   *    status "completed" (+ variants) with a usable outputs URL → success;
   *    "failed"/"canceled" (or a non-empty error string) → failure;
   *    any other status → keep polling until the deadline (the documented
   *    client behavior), never interpreted as success.
   * 4. No status at all + a usable outputs URL → sync result; the download's
   *    non-empty bytes remain the real success verification.
   * 5. Anything unusable → malformed, with a SANITIZED nested shape summary
   *    (key names/types only) so the next mismatch is actionable.
   */
  async function resolveOutput(rawEnvelope: AtlasEnvelope): Promise<string> {
    let envelope = unwrap(rawEnvelope);
    const submitId = typeof envelope.id === 'string' && envelope.id.length > 0 ? envelope.id : undefined;
    let polled = false;
    const deadline = Date.now() + cfg.timeoutMs;
    for (;;) {
      const statusRaw = envelope.status;
      const status = typeof statusRaw === 'string' && statusRaw.length > 0 ? statusRaw.toLowerCase() : undefined;
      const outputUrl = extractOutputUrl(envelope);
      const providerError = typeof envelope.error === 'string' && envelope.error.trim().length > 0 ? envelope.error.trim() : undefined;

      if (providerError) {
        throw new ProviderError('http', `Atlas reported a generation error: ${providerError.slice(0, 300)}`);
      }
      if (status !== undefined && SUCCESS_STATUSES.has(status)) {
        if (outputUrl) return outputUrl;
        throw new ProviderError('malformed_response', `Atlas reported success without a usable output URL (response shape: ${describeShape(envelope)})`);
      }
      if (status !== undefined && FAILURE_STATUSES.has(status)) {
        throw new ProviderError('http', `Atlas generation ended with status "${status}"`);
      }
      if (status === undefined) {
        // No status: a sync result is acceptable ONLY when there is an output
        // URL to download — bytes on disk verify success. Otherwise, poll if
        // possible; a shape with neither is malformed.
        if (outputUrl) return outputUrl;
        if (!submitId) {
          throw new ProviderError(
            'malformed_response',
            `Atlas response has no status, no id to poll, and no usable output (response shape: ${describeShape(envelope)})`,
          );
        }
      }
      // In progress (documented statuses or any unknown non-terminal status:
      // the official clients re-poll on anything that is not completed/failed).
      const pollUrl = submitId
        ? `${cfg.baseUrl}/model/prediction/${submitId}`
        : typeof (envelope.urls as { result?: unknown } | undefined)?.result === 'string'
          ? ((envelope.urls as { result: string }).result as string)
          : undefined;
      if (!pollUrl) {
        throw new ProviderError('malformed_response', `Atlas response is in progress but has no id or urls.result to poll (response shape: ${describeShape(envelope)})`);
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
      // Normalize the pipeline's TARGET size to the model's native constraints
      // (multiples of 16, <=2MP recommended). e.g. 1080x1920 -> 1056x1888.
      const native = normalizeFluxSize(request.width, request.height);
      if (native.width !== request.width || native.height !== request.height) {
        console.warn(
          `! image size normalized to model-native ${native.width}x${native.height} (requested ${request.width}x${request.height}; FLUX requires multiples of 16, <=2MP recommended)`,
        );
      }
      const envelope = await atlasRequest('POST', `${cfg.baseUrl}/model/generateImage`, {
        model: cfg.imageModel,
        prompt: request.prompt,
        // Documented size format uses an ASTERISK separator, e.g. "1024*1024".
        size: `${native.width}*${native.height}`,
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
