/**
 * Central, fail-fast environment access.
 *
 * DATABASE_URL is required: the process exits with a clear message when it is
 * missing. Its value is never logged anywhere.
 */

export interface Env {
  databaseUrl: string;
  port: number;
  host: string;
  corsOrigin: string;
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'strict' | 'none';
  sessionTtlDays: number;
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

  return {
    databaseUrl,
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? '0.0.0.0',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    cookieSecure: (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
    cookieSameSite: sameSite,
    sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
  };
}
