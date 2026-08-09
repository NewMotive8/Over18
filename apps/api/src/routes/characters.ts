import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { getActiveCharacterById, listActiveCharacters } from '../services/character-service.js';
import { getPublicVisualIdentity } from '../services/visual-read-service.js';

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

  /**
   * Public visual identity read (US-16B). Same public/discovery model as the
   * character routes above. Returns the active identity projection + approved
   * canonical gallery, or a clean empty state ({ identity: null, ... }) when a
   * (valid, active) character has no visual identity yet. Internal fields
   * (provenance, content_rating, draft/rejected/generated assets, raw DNA) are
   * never projected — see visual-read-service.
   */
  app.get<{ Params: { characterId: string } }>(
    '/api/characters/:characterId/visual-identity',
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      // Unknown or inactive characters read as not-found, consistent with the
      // character detail route above.
      const character = await getActiveCharacterById(opts.db, characterId);
      if (!character) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      return getPublicVisualIdentity(opts.db, characterId);
    },
  );
}
