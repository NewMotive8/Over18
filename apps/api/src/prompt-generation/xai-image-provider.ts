import { Buffer } from 'node:buffer';
import type { GenerationParams } from './config.js';
import { backoffDelayMs, parseRetryAfter, type RateLimiter } from './rate-limiter.js';

/**
 * The xAI Image Generation client. One endpoint, one request shape.
 *
 * POST https://api.x.ai/v1/images/generations
 *
 * WRITTEN AGAINST `fetch`, WITH NO SDK, matching every other provider in this
 * codebase (Atlas, RunPod, the LLM client). `fetchImpl` is injectable so tests
 * assert the exact wire request without a network.
 *
 * THE KEY NEVER LEAVES THIS FILE'S CALLERS. It arrives as config, is used only
 * in an Authorization header, and appears in no error, no log line and no
 * return value. Response bodies are truncated before they reach an error
 * message, for the same reason the LLM client refuses to echo them: a provider
 * error body can contain the prompt.
 */

export type XaiErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'http'
  | 'network'
  | 'timeout'
  | 'malformed_response'
  | 'not_configured';

export class XaiError extends Error {
  constructor(
    public readonly kind: XaiErrorKind,
    message: string,
    public readonly status?: number,
    /** Seconds the provider asked us to wait. Only ever set for 429. */
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'XaiError';
  }

  /** Whether waiting and trying the same request again could plausibly work. */
  get retryable(): boolean {
    if (this.kind === 'rate_limited' || this.kind === 'network' || this.kind === 'timeout') {
      return true;
    }
    return this.kind === 'http' && this.status !== undefined && this.status >= 500;
  }
}

export interface XaiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Attempts spent on retryable failures INSIDE one call. */
  maxAttempts: number;
}

export interface GenerateRequest {
  prompt: string;
  /** How many images to ask for in this one call. */
  n: number;
  params: GenerationParams;
}

/** One generated image, already decoded. */
export interface GeneratedImage {
  bytes: Buffer;
}

export interface XaiImageProvider {
  /**
   * Generates up to `n` images for one prompt.
   *
   * MAY RETURN FEWER THAN `n`. That is a documented possibility rather than an
   * error, and the caller tops up the missing ordinals instead of discarding
   * the images that did arrive.
   */
  generate(request: GenerateRequest): Promise<GeneratedImage[]>;
}

interface XaiImagePayload {
  url?: string | null;
  b64_json?: string | null;
}

const truncate = (text: string, max = 300) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * The live provider.
 *
 * `response_format: 'b64_json'` IS A DELIBERATE CHOICE, not a preference. xAI's
 * documentation warns that returned URLs "are temporary, so download or process
 * promptly" — a second hop that can expire between the two calls, on bytes we
 * have already paid for. Base64 removes the race and the round trip; at 1-2K an
 * image is a few megabytes, which is well within a request's working set.
 */
export function createXaiImageProvider(
  config: XaiConfig,
  limiter: RateLimiter,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): XaiImageProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/images/generations`;

  async function attempt(request: GenerateRequest): Promise<GeneratedImage[]> {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          prompt: request.prompt,
          n: request.n,
          aspect_ratio: request.params.aspectRatio,
          resolution: request.params.resolution,
          quality: request.params.quality,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new XaiError('timeout', `Image request timed out after ${config.timeoutMs}ms.`);
      }
      throw new XaiError('network', 'Image request could not reach the provider.');
    }

    if (response.status === 401 || response.status === 403) {
      // No body, ever: an auth error body can name the key or the account.
      throw new XaiError('auth', 'The image provider refused our credentials.', response.status);
    }
    if (response.status === 429) {
      throw new XaiError(
        'rate_limited',
        'The image provider is rate limiting us.',
        429,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    if (!response.ok) {
      throw new XaiError(
        'http',
        `The image provider returned HTTP ${response.status}.`,
        response.status,
      );
    }

    let body: { data?: XaiImagePayload[] };
    try {
      body = (await response.json()) as { data?: XaiImagePayload[] };
    } catch {
      throw new XaiError('malformed_response', 'The image provider returned unreadable JSON.');
    }
    if (!Array.isArray(body.data)) {
      throw new XaiError('malformed_response', 'The image provider returned no image list.');
    }

    const images: GeneratedImage[] = [];
    for (const item of body.data) {
      if (typeof item?.b64_json !== 'string' || item.b64_json.length === 0) continue;
      const bytes = Buffer.from(item.b64_json, 'base64');
      // A zero-length decode means the payload was not base64 at all. Dropping
      // it here keeps a corrupt image out of the spool, where it would upload
      // to Drive as a broken file and look like a success.
      if (bytes.byteLength === 0) continue;
      images.push({ bytes });
    }
    return images;
  }

  return {
    async generate(request) {
      let lastError: XaiError | null = null;
      for (let i = 0; i < Math.max(1, config.maxAttempts); i += 1) {
        try {
          return await limiter.run(() => attempt(request));
        } catch (error) {
          const failure =
            error instanceof XaiError
              ? error
              : new XaiError('network', truncate(String((error as Error)?.message ?? 'unknown')));
          if (!failure.retryable || i === config.maxAttempts - 1) throw failure;
          lastError = failure;
          await sleep(backoffDelayMs(i, failure.retryAfterSeconds));
        }
      }
      throw lastError ?? new XaiError('network', 'Image generation failed.');
    },
  };
}

/**
 * The provider used when the feature is not confirmed live.
 *
 * THE DEFAULT, AND THAT IS THE POINT. This repository's standing rule is that a
 * paid provider is reached only when a confirm flag AND a key are both present
 * (see `MEDIA_LIVE_CONFIRM`). Everything downstream — the runner, the state
 * machine, the spool, the Drive upload, the whole UI — behaves identically
 * against this, so a batch can be exercised end to end for nothing.
 */
export function createMockXaiImageProvider(
  bytesFor: (prompt: string, ordinal: number) => Buffer = mockJpegBytes,
): XaiImageProvider {
  return {
    async generate(request) {
      return Array.from({ length: request.n }, (_unused, index) => ({
        bytes: bytesFor(request.prompt, index + 1),
      }));
    },
  };
}

/** A minimal valid-enough JPEG: SOI, a comment, EOI. Renders as a broken image. */
export function mockJpegBytes(prompt: string, ordinal: number): Buffer {
  const note = Buffer.from(`mock ${ordinal} ${prompt.slice(0, 40)}`, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(note.byteLength + 2, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xfe]),
    length,
    note,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** The provider that refuses, used when the key is missing but live was asked for. */
export function createUnconfiguredXaiProvider(): XaiImageProvider {
  return {
    async generate() {
      throw new XaiError(
        'not_configured',
        'Image generation is not configured on this server.',
      );
    },
  };
}
