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
  /**
   * The provider generated an image and then refused to hand it over, because
   * its own content moderation rejected the result.
   *
   * ITS OWN KIND, NOT `http`, BECAUSE THE ANSWER IS DIFFERENT. Every other 4xx
   * says we asked wrongly; this one says the request was understood, the work
   * was done, and the OUTPUT was refused. Nothing about waiting, or about
   * sending the same prompt again, changes that — and it is not free: a refusal
   * costs around 100 seconds of generation before it arrives. Collapsed into
   * `http` it was indistinguishable from a malformed request, so the runner
   * kept spending the output's generation budget on it.
   */
  | 'content_moderated'
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
    // Stated explicitly rather than left to fall through the `http` test below.
    // It already returned false there, but by accident of not being `http`
    // rather than by intent — and "the provider refused the output" is the one
    // kind where retrying is guaranteed to cost money and change nothing.
    if (this.kind === 'content_moderated') return false;
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

const pickString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

/**
 * The reason xAI refused us, and nothing else from the body.
 *
 * WHY THIS EXISTS. "The image provider returned HTTP 400." is true and
 * useless — it says something is wrong without saying whether to fix the
 * prompt, wait, top up the account, or change the request. xAI had already
 * answered that in the response body and this client threw the body away, so a
 * production failure could not be diagnosed at all without guessing. This is
 * the same lesson already learned on the Google token path; the fix is the
 * same shape, deliberately.
 *
 * AN ALLOWLIST, NOT A REDACTION, for the same reason as there: a provider error
 * body is not safe to echo wholesale. Exactly two fields are read BY NAME —
 * a machine-readable `code` and a human-readable message — so every other key
 * is never looked at and cannot leak by being overlooked.
 *
 * TWO BODY SHAPES, BOTH READ BY NAME. xAI answers with a flat
 * `{ code, error }`; the OpenAI-compatible convention nests
 * `{ error: { code, message } }`. Reading both by name costs one branch and
 * means a provider-side shape change degrades to "no reason" rather than to a
 * wrong one.
 *
 * SWEPT FOR THE API KEY *AND* THE PROMPT. The key is obvious. The prompt
 * matters because this file's standing rule is that a provider error body can
 * contain it, and prompts here are operator content that has no business
 * travelling into a stored error row. The reason code survives that sweep,
 * which is the part worth having.
 */
export function xaiErrorReason(
  body: string,
  secrets: readonly string[],
): { code: string | null; description: string | null } {
  const redact = (value: string): string => {
    let out = value;
    for (const secret of secrets) {
      // Short strings are not swept: they match everywhere and would turn a
      // useful sentence into confetti.
      if (secret.length >= 8) out = out.split(secret).join('[redacted]');
    }
    return out;
  };

  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown; message?: unknown };
    const nested =
      typeof parsed.error === 'object' && parsed.error !== null
        ? (parsed.error as { code?: unknown; message?: unknown })
        : null;

    const rawCode = pickString(parsed.code) ?? pickString(nested?.code);
    const rawDescription =
      pickString(typeof parsed.error === 'string' ? parsed.error : null) ??
      pickString(nested?.message) ??
      pickString(parsed.message);

    // The code is a machine identifier — xAI's own look like
    // `unauthenticated:no-credentials`, so `:` and `.` are kept and nothing
    // else is. A key or a prompt pasted into this field could not survive it.
    const code = rawCode
      ? redact(rawCode.trim().slice(0, 64)).replace(/[^a-zA-Z0-9_:.-]/g, '')
      : null;
    // Printable ASCII only, and bounded: enough to name a reason, never enough
    // to carry a payload.
    const description = rawDescription
      ? redact(rawDescription.trim().slice(0, 200)).replace(/[^\x20-\x7e]/g, '')
      : null;

    return { code: code || null, description: description || null };
  } catch {
    return { code: null, description: null };
  }
}

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

    // The values that must never appear in a message or a log, whatever the
    // provider sends back: our key, and the operator's prompt.
    const secrets = [config.apiKey, request.prompt];
    /**
     * The provider's reason CODE, and deliberately not its prose.
     *
     * THE CODE ONLY, AND WHY THAT IS THE WHOLE POINT. This file's standing rule
     * is that a provider error body can contain the prompt, so no part of it is
     * echoed. A reason code does not break that rule and a human message would:
     * xAI's codes are namespaced machine identifiers — `unauthenticated:no-credentials`
     * — which are enough to tell a content refusal from a bad parameter from an
     * exhausted account, while being structurally incapable of carrying prose.
     * The character class below enforces that rather than trusting it.
     *
     * The human-readable message IS parsed by `xaiErrorReason` and is
     * deliberately dropped here. Surfacing it would be a policy decision about
     * echoing provider prose, not a bug fix, so it is not taken silently.
     */
    /** The allowlisted detail, read ONCE — a body can only be consumed once. */
    const detailOf = async () => xaiErrorReason(await response.text().catch(() => ''), secrets);
    const suffix = (code: string | null) => (code ? ` — ${code}` : '');

    if (response.status === 401 || response.status === 403) {
      // No body, ever — unchanged. An auth error body can name the key or the
      // account, and neither is something an operator needs in order to act:
      // the answer is always "fix the credential".
      throw new XaiError('auth', 'The image provider refused our credentials.', response.status);
    }
    if (response.status === 429) {
      // Named, because "rate limited" and "out of credit" arrive at the same
      // status and want opposite responses from the operator.
      const detail = await detailOf();
      throw new XaiError(
        'rate_limited',
        `The image provider is rate limiting us${suffix(detail.code)}.`,
        429,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    if (!response.ok) {
      const detail = await detailOf();
      /**
       * MODERATION IS MATCHED ON THE REASON CODE, NOT THE STATUS.
       *
       * The refusal arrives as a 400 today, but a 400 is also what a malformed
       * request returns, and those want opposite handling — one is terminal,
       * the other is a bug to fix. The code is the only field that separates
       * them, and it survives the allowlist by construction. Matched loosely so
       * a provider-side rename (`content-moderated` -> `content_moderated`,
       * say) degrades to the old generic behaviour rather than to a wrong kind.
       */
      if (detail.code && /moderat/i.test(detail.code)) {
        throw new XaiError(
          'content_moderated',
          `The image provider generated the image and then refused it${suffix(detail.code)}. ` +
            'Asking again for the same prompt will be refused the same way, so this is not retried.',
          response.status,
        );
      }
      throw new XaiError(
        'http',
        `The image provider returned HTTP ${response.status}${suffix(detail.code)}.`,
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
