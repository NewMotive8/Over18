import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { getActiveCharacterById, listActiveCharacters } from '../services/character-service.js';
import { getPublicVisualIdentity } from '../services/visual-read-service.js';
import { listPublicCharacterClips } from '../services/home-composition-service.js';

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

  /**
   * This character's public content collection — every clip of hers a visitor
   * may see, in full.
   *
   * SEPARATE FROM `visual-identity` ON PURPOSE. That route returns her
   * canonical REFERENCE images: who she is. This returns her CONTENT: what she
   * has posted. Conflating the two is exactly the defect this closes — the
   * Posts tab used to show her reference image and call it a post.
   *
   * NO LIMIT AND NO PAGINATION. The collection is small, operator-curated, and
   * the product requirement is that the tab shows all of it.
   *
   * The service applies `publiclyReachableCondition`, so this route adds no
   * visibility rule of its own and cannot relax one. An unknown or inactive
   * character reads as not-found, consistent with the two routes above.
   */
  app.get<{ Params: { characterId: string } }>(
    '/api/characters/:characterId/clips',
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      const character = await getActiveCharacterById(opts.db, characterId);
      if (!character) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      return { clips: await listPublicCharacterClips(opts.db, characterId) };
    },
  );
}
