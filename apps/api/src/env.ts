/**
 * Central, fail-fast environment access.
 *
 * DATABASE_URL is required: the process exits with a clear message when it is
 * missing. Its value is never logged anywhere.
 */

export interface LlmEnv {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  contextMaxMessages: number;
  contextMaxChars: number;
}

export interface MemoryEnv {
  maxInjected: number;
  maxInjectedChars: number;
  maxStored: number;
}

export interface MediaEnv {
  storageDir: string;
  publicBaseUrl: string | null;
  internalToken: string | null;
  ledgerPath: string;
  atlas: {
    baseUrl: string;
    imageModel: string;
    videoModel: string;
    live: boolean;
  };
  runpod: {
    endpointId: string | null;
    live: boolean;
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
  isProduction: boolean;
  llm: LlmEnv | null;
  memory: MemoryEnv;
  media: MediaEnv;
}

/** True for "true" / "TRUE" / " true " — ignores accidental whitespace. */
function envFlagTrue(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

function envNonEmpty(name: string): boolean {
  return (process.env[name] ?? '').trim().length > 0;
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

  const runpodEndpointId = (process.env.RUNPOD_ENDPOINT_ID ?? '').trim() || null;

  return {
    databaseUrl,
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? '0.0.0.0',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    cookieSecure:
      (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')).trim() ===
      'true',
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
        live: envFlagTrue('MEDIA_LIVE_CONFIRM') && envNonEmpty('ATLASCLOUD_API_KEY'),
      },
      runpod: {
        endpointId: runpodEndpointId,
        live:
          envFlagTrue('MEDIA_RUNPOD_CONFIRM') &&
          envNonEmpty('RUNPOD_API_KEY') &&
          Boolean(runpodEndpointId),
        preferForImages: (process.env.MEDIA_IMAGE_PROVIDER ?? 'runpod').trim().toLowerCase() !== 'atlas',
      },
    },
  };
}
