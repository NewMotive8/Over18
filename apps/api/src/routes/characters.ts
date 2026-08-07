import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { getActiveCharacterById, listActiveCharacters } from '../services/character-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  app.get<{ Params: { characterId: string } }>(
    '/api/characters/:characterId',
    async (request, reply) => {
      const { characterId } = request.params;
      // Malformed ids read as "not found" rather than a Postgres cast error.
      if (!UUID_RE.test(characterId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      const character = await getActiveCharacterById(opts.db, characterId);
      if (!character) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      return character;
    },
  );
}
