import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { loadEnv } from './env.js';
import { selectReplyProvider } from './services/llm-reply-provider.js';
import { selectMemoryExtractor } from './services/memory-extractor.js';

const env = loadEnv();
const { db } = createDb(env.databaseUrl);

// US-08: configured endpoint → real inference; unset → deterministic fallback
// in development only. In production without configuration, sends fail with
// a clear ai_not_configured error instead of faking AI.
const app = await buildApp(env, db, {
  replyProvider: selectReplyProvider(env),
  // US-12: memory extraction follows the same selection logic — real LLM
  // when configured, deterministic rules in dev, nothing in unconfigured prod.
  memoryExtractor: selectMemoryExtractor(env),
});
// Model/base URL/key values are never logged — only the mode.
app.log.info(
  env.llm
    ? 'AI replies: LLM inference endpoint configured (openai-compatible)'
    : env.isProduction
      ? 'AI replies: NOT CONFIGURED — production sends will fail with ai_not_configured until LLM_* variables are set'
      : 'AI replies: no LLM configured — using deterministic fallback provider (development only)',
);

try {
  await app.listen({ port: env.port, host: env.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
