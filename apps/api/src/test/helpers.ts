import { execSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/client.js';
import { buildApp, type BuildAppOptions } from '../app.js';
import type { Env } from '../env.js';

/**
 * Test harness: builds the app against an ISOLATED local test database.
 *
 * Safety: refuses to run against anything that is not an explicitly named
 * *_test database, so these destructive tests can never touch the Railway
 * production database.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://over18:over18_local_dev@127.0.0.1:5432/over18_test';

if (!/_test(\?|$)/.test(new URL(TEST_DATABASE_URL).pathname)) {
  throw new Error('Refusing to run tests: TEST_DATABASE_URL must point at a *_test database.');
}

export const testEnv: Env = {
  databaseUrl: TEST_DATABASE_URL,
  port: 0,
  host: '127.0.0.1',
  corsOrigin: 'http://localhost:5173',
  cookieSecure: false,
  cookieSameSite: 'lax',
  sessionTtlDays: 30,
  isProduction: false,
  llm: null, // tests always inject providers explicitly — no real endpoint
  memory: { maxInjected: 10, maxInjectedChars: 2_000, maxStored: 100 },
};

export function migrateTestDb(): void {
  execSync('npx drizzle-kit migrate', {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}

export interface TestContext {
  app: FastifyInstance;
  db: ReturnType<typeof createDb>['db'];
  pool: ReturnType<typeof createDb>['pool'];
}

export async function createTestContext(options: BuildAppOptions = {}): Promise<TestContext> {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  const app = await buildApp(testEnv, db, options);
  return { app, db, pool };
}

export async function truncateAll(ctx: TestContext): Promise<void> {
  await ctx.pool.query(
    'TRUNCATE TABLE memories, messages, conversations, sessions, users, characters CASCADE',
  );
}

export async function destroyTestContext(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.pool.end();
}

/** Extracts the session cookie value from a light-my-request response. */
export function extractSessionCookie(res: {
  cookies: Array<{ name: string; value: string }>;
}): { name: string; value: string } | undefined {
  return res.cookies.find((c) => c.name === 'over18_session');
}
