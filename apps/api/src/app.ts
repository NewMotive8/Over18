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
import { deterministicReplyProvider, type ReplyProvider } from './services/character-reply.js';

export interface BuildAppOptions {
  /** Reply provider for chat messages. Defaults to the deterministic fallback. */
  replyProvider?: ReplyProvider;
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
  });

  return app;
}
