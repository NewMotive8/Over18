import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { HealthResponse } from '@over18/shared';

/**
 * Builds and configures the Fastify instance.
 * Kept separate from server.ts so it can be reused in tests later.
 */
export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  });

  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      service: 'over18-api',
      timestamp: new Date().toISOString(),
    };
  });

  return app;
}
