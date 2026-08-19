import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { loadEnv } from './env.js';
import { selectReplyProvider } from './services/llm-reply-provider.js';
import { selectMemoryExtractor } from './services/memory-extractor.js';
import { selectMediaProviders } from './services/media-providers.js';
import { selectProfileAuthor } from './services/character-profile-service.js';

const env = loadEnv();
const { db } = createDb(env.databaseUrl);

const app = await buildApp(env, db, {
  replyProvider: selectReplyProvider(env),
  memoryExtractor: selectMemoryExtractor(env),
  mediaProviders: selectMediaProviders(env),
  profileAuthor: selectProfileAuthor(env),
});

app.log.info(
  env.llm
    ? 'AI replies: LLM inference endpoint configured (openai-compatible)'
    : env.isProduction
      ? 'AI replies: NOT CONFIGURED — production sends will fail with ai_not_configured until LLM_* variables are set'
      : 'AI replies: no LLM configured — using deterministic fallback provider (development only)',
);

const mediaMode =
  env.media.runpod.live && env.media.runpod.preferForImages
    ? 'Media generation: RunPod ComfyUI LIVE for images' +
      (env.media.atlas.live ? ' + Atlas LIVE for video' : ' (video needs Atlas live)')
    : env.media.atlas.live
      ? 'Media generation: Atlas LIVE (paid calls enabled via MEDIA_LIVE_CONFIRM)'
      : 'Media generation: mock provider (set MEDIA_RUNPOD_CONFIRM or MEDIA_LIVE_CONFIRM to go live)';
app.log.info(mediaMode);
// Booleans only — never keys or endpoint ids.
app.log.info(
  `Media flags: atlas.live=${env.media.atlas.live} runpod.live=${env.media.runpod.live} runpod.preferForImages=${env.media.runpod.preferForImages} runpod.endpointSet=${Boolean(env.media.runpod.endpointId)}`,
);

app.log.info(
  env.media.internalToken
    ? 'Media endpoints: /internal/media/* enabled (INTERNAL_MEDIA_TOKEN set)'
    : 'Media endpoints: /internal/media/* DISABLED until INTERNAL_MEDIA_TOKEN is set',
);

try {
  await app.listen({ port: env.port, host: env.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
