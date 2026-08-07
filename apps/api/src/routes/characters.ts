import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { listActiveCharacters } from '../services/character-service.js';

/**
 * Character discovery routes.
 *
 * Public by design (agreed in US-02): browsing characters requires no
 * account. All DB access goes through the character service.
 */
export default async function characterRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.get('/api/characters', async () => {
    return listActiveCharacters(opts.db);
  });
}
