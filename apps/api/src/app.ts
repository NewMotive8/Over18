import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import type { HealthResponse } from '@over18/shared';
import type { Env } from './env.js';
import type { Db } from './db/client.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import characterRoutes from './routes/characters.js';
import conversationRoutes from './routes/conversations.js';
import messageRoutes from './routes/messages.js';
import internalMediaRoutes from './routes/internal-media.js';
import { deterministicReplyProvider, type ReplyProvider } from './services/character-reply.js';
import { noopMemoryExtractor, type MemoryExtractor } from './services/memory-extractor.js';
import type { MediaProviders } from './media-pipeline/types.js';

export interface BuildAppOptions {
  /** Reply provider for chat messages. Defaults to the deterministic fallback. */
  replyProvider?: ReplyProvider;
  /**
   * US-12 memory extractor. Defaults to noop so existing tests/behavior are
   * unchanged unless one is injected (server.ts selects from the env).
   */
  memoryExtractor?: MemoryExtractor;
  /**
   * US-36 media providers (image + video). When provided, the internal media
   * endpoints are registered. Tests inject the mock adapter; server.ts injects
   * the env-selected providers.
   */
  mediaProviders?: MediaProviders;
}

/**
 * Builds and configures the Fastify instance.
 * Kept separate from server.ts so tests can build an app against an
 * isolated database (and an injected fake reply provider) without opening
 * a network port.
 */
export async function buildApp(env: Env, db: Db, options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: {
      // Never log request bodies (passwords) or cookie headers (session tokens).
      serializers: {
        req(request) {
          return { method: request.method, url: request.url };
        },
      },
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
  });

  await app.register(cors, {
    // Origin-specific (never "*") so credentialed requests are allowed.
    origin: env.corsOrigin,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(authPlugin, { db });

  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      service: 'over18-api',
      timestamp: new Date().toISOString(),
    };
  });

  await app.register(authRoutes, { db, env });
  await app.register(characterRoutes, { db });
  await app.register(conversationRoutes, { db });
  await app.register(messageRoutes, {
    db,
    replyProvider: options.replyProvider ?? deterministicReplyProvider,
    memoryExtractor: options.memoryExtractor ?? noopMemoryExtractor,
    memoryMaxStored: env.memory.maxStored,
  });

  // US-36 internal media endpoints — registered only when providers are
  // injected (server.ts wires the env-selected adapter; tests inject the mock).
  if (options.mediaProviders) {
    await app.register(internalMediaRoutes, {
      db,
      providers: options.mediaProviders,
      storage: { storageDir: env.media.storageDir, publicBaseUrl: env.media.publicBaseUrl },
      ledgerPath: env.media.ledgerPath,
      internalToken: env.media.internalToken,
    });
  }

  return app;
}
