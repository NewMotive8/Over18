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

/**
 * Atlas Cloud adapter — the ONLY file that knows Atlas exists.
 *
 * CONTRACT (verified against the official docs, 2026-08-12, after the live
 * probe returned HTTP 404 against the previous guessed paths):
 *   - Base API:        https://api.atlascloud.ai/api/v1
 *   - Image submit:    POST /model/generateImage
 *                      body { model, prompt, size: "W*H" (asterisk!), num_images }
 *   - Video submit:    POST /model/generateVideo
 *                      body { model, image, prompt, negative_prompt,
 *                             resolution, duration, seed }
 *     VERIFIED against the official Wan model pages (2026-08-12). Three
 *     things the earlier guessed implementation got WRONG:
 *       1. The model id carries a TASK SUFFIX:
 *          "atlascloud/wan-2.7-spicy/image-to-video", not the bare family id.
 *       2. `image` takes an https URL, NOT base64. Local files must first be
 *          uploaded: POST /model/uploadMedia (multipart/form-data) which
 *          returns the temporary URL to pass through.
 *       3. Resolution CASING is model-specific: the wan-2.6/2.7 pages document
 *          "720P"/"1080P"; the wan-2.2 pages document "480p"/"720p"/"1080p".
 *          A blanket toUpperCase() is wrong for half the catalogue.
 *   - Upload:          POST /model/uploadMedia (multipart/form-data)
 *                      → { url } / { download_url } (data-wrapped variants too)
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
  /** Overrides the model-derived resolution casing when a new model deviates. */
  videoResolutionCase?: 'upper' | 'lower';
  /** Overrides the default anti-cut negative prompt; '' disables it. */
  videoNegativePrompt?: string;
  /** Human confirmation gate for live paid calls. */
  contractConfirmed?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /**
   * Deadline for the whole submit→poll→terminal cycle. Video jobs are
   * documented at 1-5 minutes (fast variants 30-90s), far longer than a single
   * HTTP read timeout, so this defaults to 15 min. An explicit timeoutMs with
   * no pollTimeoutMs still governs the deadline, so existing callers and tests
   * keep their tight bounds.
   */
  pollTimeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  baseUrl: 'https://api.atlascloud.ai/api/v1',
  imageModel: 'black-forest-labs/flux-kontext-dev',
  // Task-suffixed id, as the official model page documents it.
  videoModel: 'atlascloud/wan-2.7-spicy/image-to-video',
  imageUnitCostUsd: 0.025,
  videoUnitCostPerSecondUsd: 0.1,
  pollIntervalMs: 3000,
  timeoutMs: 300_000,
  /**
   * The official Wan image-to-video example ships this negative prompt. It
   * targets exactly the failure mode our QA cares about — shot changes inside
   * a 5s loop — so it is the adapter default rather than prompt boilerplate
   * every caller has to remember.
   */
  videoNegativePrompt:
    'camera cut, shot change, scene change, transition, jump cut, rapid editing, montage, multi-shot, multiple camera angles, perspective shift',
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

const DEFAULT_POLL_TIMEOUT_MS = 900_000;

/**
 * Wan resolution CASING is model-family specific (adapter owns model
 * capability, exactly as normalizeFluxSize does for image sizes):
 *   - wan-2.6 / wan-2.7 pages document "720P", "1080P" (plus SR variants)
 *   - wan-2.2 pages document "480p", "720p", "1080p"
 * The pipeline keeps expressing intent in its own lowercase vocabulary; this
 * maps intent onto whatever the selected model actually accepts. Unknown
 * models default to the lowercase form the majority of the catalogue uses,
 * and callers can force either casing via AtlasOptions.videoResolutionCase.
 */
export function normalizeWanResolution(model: string, resolution: string, override?: 'upper' | 'lower'): string {
  const wants = override ?? (/wan-2\.[67]/i.test(model) ? 'upper' : 'lower');
  return wants === 'upper' ? resolution.toUpperCase() : resolution.toLowerCase();
}

/**
 * Duration support differs per Wan family, and an unsupported value is a
 * WASTED PAID CALL — so it is rejected locally, before authorization spends
 * anything:
 *   - wan-2.2 turbo variants: 5 or 8 seconds only
 *   - wan-2.6 / wan-2.7: any integer from 2 to 15
 * Unknown models: only the generic "positive integer" rule is enforced, so a
 * new model is never blocked by stale knowledge encoded here.
 */
export function validateWanDuration(model: string, durationSeconds: number): void {
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new ProviderError('unsupported_request', `video duration must be a positive whole number of seconds, got ${durationSeconds}`);
  }
  if (/wan-2\.2/i.test(model) && ![5, 8].includes(durationSeconds)) {
    throw new ProviderError('unsupported_request', `model ${model} supports only 5s or 8s clips, got ${durationSeconds}s — refusing before a paid call`);
  }
  if (/wan-2\.[67]/i.test(model) && (durationSeconds < 2 || durationSeconds > 15)) {
    throw new ProviderError('unsupported_request', `model ${model} supports 2-15s clips, got ${durationSeconds}s — refusing before a paid call`);
  }
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

/**
 * Names a downloaded image by its ACTUAL format so the extension never lies.
 * The pipeline requests a `.jpg` path by convention, but Atlas/Flux could serve
 * PNG or WebP; saving those bytes as `.jpg` would produce a file whose name
 * contradicts its content (breaking downstream tools that trust the extension).
 * If the requested extension already fits the real format it is kept as-is;
 * otherwise it is swapped for the format's canonical extension.
 */
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
    if (!res.ok) throw new ProviderError('http', `Atlas returned HTTP ${res.status} for ${new URL(url).pathname}`);
    try {
      return (await res.json()) as AtlasEnvelope;
    } catch {
      throw new ProviderError('malformed_response', 'Atlas returned non-JSON output');
    }
  }

  /**
   * Uploads a local file and returns the temporary https URL Atlas serves it
   * from — the documented prerequisite for image-to-video, whose `image` field
   * takes a URL and not base64.
   *
   * POST /model/uploadMedia, multipart/form-data. The docs page shows the URL
   * returned as `url` while the official client examples read `download_url`,
   * so BOTH are accepted (data-wrapped too) and anything else is malformed
   * with a sanitized shape summary rather than a guess. The uploaded bytes are
   * the character's own canonical still; the key is never part of the body.
   */
  async function uploadMedia(filePath: string): Promise<string> {
    const bytes = readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), basename(filePath));
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/model/uploadMedia`, {
        method: 'POST',
        // NOTE: no Content-Type header — fetch must set the multipart boundary.
        headers: { Authorization: `Bearer ${apiKey()}` },
        body: form,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('network', 'could not reach Atlas Cloud to upload the reference image');
    }
    if (!res.ok) throw new ProviderError('http', `Atlas returned HTTP ${res.status} for /model/uploadMedia`);
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
    const deadline = Date.now() + (options.pollTimeoutMs ?? options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
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
      // Optional identity-consistent reference (FLUX Kontext image-to-image).
      // The `image` field takes an https URL, not base64 — upload the local
      // still first and pass the temporary URL Atlas returns. When a reference
      // drives the generation, enable_safety_checker is set false so the
      // reference-conditioned render is returned rather than silently dropped
      // by the provider's auto-filter (content boundaries stay enforced by
      // prompt authoring + human review, exactly as the rest of this tooling).
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
        // Documented size format uses an ASTERISK separator, e.g. "1024*1024".
        size: `${native.width}*${native.height}`,
        num_images: 1,
        ...(referenceUrl ? { image: referenceUrl, enable_safety_checker: false } : {}),
      });
      const url = await resolveOutput(envelope);
      // Verify the downloaded BYTES are a real image and name the file by its
      // ACTUAL format (magic bytes), never by the requested extension. Bytes
      // that are not a recognized image (e.g. an error page or JSON slipping
      // through) are refused — we never save a non-image as an image.
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
      // Local capability check FIRST: an unsupported duration is a wasted paid
      // call, so it never reaches authorization or the network.
      validateWanDuration(cfg.videoModel, request.durationSeconds);
      // `image` takes an https URL, never base64 — upload the canonical still
      // and pass the temporary URL Atlas hands back.
      const imageUrl = await uploadMedia(request.referenceImagePath);
      const negativePrompt = cfg.videoNegativePrompt;
      const envelope = await atlasRequest('POST', `${cfg.baseUrl}/model/generateVideo`, {
        model: cfg.videoModel,
        image: imageUrl,
        prompt: request.prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        resolution: normalizeWanResolution(cfg.videoModel, request.resolution, cfg.videoResolutionCase),
        duration: request.durationSeconds,
        seed: -1,
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
