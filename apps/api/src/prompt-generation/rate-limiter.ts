/**
 * Controlled concurrency and request pacing for a paid API.
 *
 * xAI documents SIX REQUESTS PER SECOND for grok-imagine-image-2.0. Firing a
 * 200-prompt batch as fast as the event loop allows would earn a wall of 429s,
 * and a wall of 429s on a paid endpoint is how a batch turns into a long
 * retry storm.
 *
 * Two independent limits, because they solve different problems:
 *
 *   RATE decides how often a request may START (a token bucket).
 *   CONCURRENCY decides how many may be IN FLIGHT at once.
 *
 * Rate alone is not enough: six slow requests per second, each taking twenty
 * seconds, is a hundred and twenty open sockets. Concurrency alone is not
 * enough either: three fast requests can still exceed six per second.
 */

export interface RateLimiterOptions {
  /** Requests per second the bucket refills at. Kept under the published cap. */
  requestsPerSecond: number;
  /** Maximum simultaneous in-flight requests. */
  maxConcurrent: number;
  /** Injected for tests, so pacing can be asserted without real time passing. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A token bucket plus a concurrency gate.
 *
 * The bucket starts FULL, so a small batch is not artificially slowed at the
 * start; it is a ceiling on sustained rate, not a mandatory delay.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RateLimiterOptions) {
    this.tokens = options.requestsPerSecond;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const at = this.now();
    const elapsedMs = at - this.lastRefill;
    if (elapsedMs <= 0) return;
    const gained = (elapsedMs / 1000) * this.options.requestsPerSecond;
    this.tokens = Math.min(this.options.requestsPerSecond, this.tokens + gained);
    this.lastRefill = at;
  }

  /** Milliseconds until one token is available. 0 when one already is. */
  private waitForTokenMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const missing = 1 - this.tokens;
    return Math.ceil((missing / this.options.requestsPerSecond) * 1000);
  }

  private acquireSlot(): Promise<void> {
    if (this.inFlight < this.options.maxConcurrent) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * Runs `task` once a concurrency slot AND a rate token are available.
   *
   * The slot is released in a `finally`, so a throwing task can never leak a
   * permit and wedge the batch — the failure mode that turns "one prompt
   * failed" into "the queue stopped".
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      for (;;) {
        const waitMs = this.waitForTokenMs();
        if (waitMs === 0) break;
        await this.sleep(waitMs);
      }
      this.tokens -= 1;
      return await task();
    } finally {
      this.releaseSlot();
    }
  }
}

/**
 * Backoff for a 429 or a transient 5xx.
 *
 * Exponential with FULL JITTER. Without jitter, a batch that hits one 429
 * retries in lockstep and hits the same wall again — the herd has to be broken
 * up, not just delayed. `Retry-After` always wins when the provider sends one:
 * it is the only party that actually knows.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random,
): number {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, 60_000);
  }
  const ceiling = Math.min(1000 * 2 ** Math.max(0, attempt), 30_000);
  return Math.floor(random() * ceiling);
}

/** Parses `Retry-After`, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: () => number = Date.now): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, (at - now()) / 1000);
}
