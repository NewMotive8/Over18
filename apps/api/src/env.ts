/**
 * Central, fail-fast environment access.
 *
 * DATABASE_URL is required: the process exits with a clear message when it is
 * missing. Its value is never logged anywhere.
 */

export interface LlmEnv {
  /** Adapter selection; only 'openai-compatible' exists today. */
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  /** US-10 context window: max prior messages sent to the model. */
  contextMaxMessages: number;
  /** US-10 context window: max total chars of prior-message content sent. */
  contextMaxChars: number;
}

/** US-12 basic user memory tuning. Always present (defaults apply). */
export interface MemoryEnv {
  /** Max memories injected into a single prompt. */
  maxInjected: number;
  /** Max total characters of memory content injected into a single prompt. */
  maxInjectedChars: number;
  /** Max memories stored per (user, character); oldest are evicted beyond this. */
  maxStored: number;
}

/**
 * Media generation config (US-36 PoC + US-87 RunPod). Always present (defaults apply).
 * `atlas.live` / `runpod.live` are explicit paid-call gates.
 */
export interface MediaEnv {
  /** Directory generated media bytes are written to. */
  storageDir: string;
  /** Optional URL prefix; when set, storage_key = `${publicBaseUrl}/<relpath>`. */
  publicBaseUrl: string | null;
  /** Shared secret required on /internal/media/* requests. Null = unconfigured. */
  internalToken: string | null;
  /** Cost ledger file path (JSON, cumulative spend across runs). */
  ledgerPath: string;
  atlas: {
    baseUrl: string;
    imageModel: string;
    videoModel: string;
    /** True only when a key is present AND live calls are explicitly confirmed. */
    live: boolean;
  };
  /** US-87 RunPod Serverless ComfyUI for uncensored stills. */
  runpod: {
    endpointId: string | null;
    /** True when key + endpoint + MEDIA_RUNPOD_CONFIRM=true. */
    live: boolean;
    /** Prefer RunPod for images when live (Atlas remains for video if live). */
    preferForImages: boolean;
  };
}

export interface Env {
  databaseUrl: string;
  port: number;
  host: string;
  corsOrigin: string;
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'strict' | 'none';
  sessionTtlDays: number;
  /** True when NODE_ENV=production — deterministic fallback replies are forbidden there. */
  isProduction: boolean;
  /** Null when no inference endpoint is configured. */
  llm: LlmEnv | null;
  /** US-12 memory bounds (defaults apply when env vars are unset). */
  memory: MemoryEnv;
  /** US-36 media generation (defaults apply when env vars are unset). */
  media: MediaEnv;
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      'FATAL: DATABASE_URL is not set. ' +
        'Provide a PostgreSQL connection string via the DATABASE_URL environment variable ' +
        '(on Railway this is injected automatically; locally, copy apps/api/.env.example to .env).',
    );
    process.exit(1);
  }

  const sameSite = process.env.COOKIE_SAMESITE ?? 'lax';
  if (sameSite !== 'lax' && sameSite !== 'strict' && sameSite !== 'none') {
    console.error(`FATAL: COOKIE_SAMESITE must be one of lax|strict|none, got "${sameSite}".`);
    process.exit(1);
  }

  let llm: LlmEnv | null = null;
  if (process.env.LLM_BASE_URL) {
    const model = process.env.LLM_MODEL;
    if (!model) {
      console.error('FATAL: LLM_BASE_URL is set but LLM_MODEL is missing.');
      process.exit(1);
    }
    const provider = process.env.LLM_PROVIDER ?? 'openai-compatible';
    if (provider !== 'openai-compatible') {
      console.error(`FATAL: unsupported LLM_PROVIDER "${provider}" (supported: openai-compatible).`);
      process.exit(1);
    }
    llm = {
      provider,
      baseUrl: process.env.LLM_BASE_URL,
      model,
      apiKey: process.env.LLM_API_KEY || undefined,
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 30_000),
      maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 512),
      temperature: Number(process.env.LLM_TEMPERATURE ?? 0.8),
      contextMaxMessages: Number(process.env.LLM_CONTEXT_MAX_MESSAGES ?? 40),
      contextMaxChars: Number(process.env.LLM_CONTEXT_MAX_CHARS ?? 16_000),
    };
  }

  return {
    databaseUrl,
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? '0.0.0.0',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    cookieSecure: (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
    cookieSameSite: sameSite,
    sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
    isProduction: process.env.NODE_ENV === 'production',
    llm,
    memory: {
      maxInjected: Number(process.env.MEMORY_MAX_INJECTED ?? 10),
      maxInjectedChars: Number(process.env.MEMORY_MAX_INJECTED_CHARS ?? 2_000),
      maxStored: Number(process.env.MEMORY_MAX_STORED ?? 100),
    },
    media: {
      storageDir: process.env.MEDIA_STORAGE_DIR ?? 'var/media',
      publicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL || null,
      internalToken: process.env.INTERNAL_MEDIA_TOKEN || null,
      ledgerPath: process.env.MEDIA_LEDGER_PATH ?? 'var/media/cost-ledger.json',
      atlas: {
        baseUrl: process.env.ATLAS_BASE_URL ?? 'https://api.atlascloud.ai/api/v1',
        imageModel: process.env.ATLAS_IMAGE_MODEL ?? 'black-forest-labs/flux-kontext-dev',
        videoModel: process.env.ATLAS_VIDEO_MODEL ?? 'atlascloud/wan-2.7-spicy/image-to-video',
        live: process.env.MEDIA_LIVE_CONFIRM === 'true' && Boolean(process.env.ATLASCLOUD_API_KEY),
      },
      runpod: {
        endpointId: process.env.RUNPOD_ENDPOINT_ID || null,
        live:
          process.env.MEDIA_RUNPOD_CONFIRM === 'true' &&
          Boolean(process.env.RUNPOD_API_KEY) &&
          Boolean(process.env.RUNPOD_ENDPOINT_ID),
        preferForImages: (process.env.MEDIA_IMAGE_PROVIDER ?? 'runpod') !== 'atlas',
      },
    },
  };
}
