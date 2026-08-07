import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

/**
 * Creates a connection pool + Drizzle instance for the given DATABASE_URL.
 * Kept as a factory (rather than a module-level singleton) so tests can
 * point at an isolated database.
 */
export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
