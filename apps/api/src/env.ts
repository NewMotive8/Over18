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
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Deliberately does NOT print any connection details — there are none to print.
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

  // LLM inference endpoint (US-08). Configured entirely through env vars so
  // the model/provider can be selected later without code changes. Unset:
  // development falls back to deterministic replies; production refuses to
  // fake AI and answers sends with a clear ai_not_configured error.
  let llm: LlmEnv | null = null;
  if (process.env.LLM_BASE_URL) {
    const model = process.env.LLM_MODEL;
    if (!model) {
      // Values are never logged — only which variable is missing.
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
  };
}
