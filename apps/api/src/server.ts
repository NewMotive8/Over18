import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const { db } = createDb(env.databaseUrl);
const app = await buildApp(env, db);

try {
  await app.listen({ port: env.port, host: env.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
