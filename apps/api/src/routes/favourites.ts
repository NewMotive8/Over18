import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import {
  addFavourite,
  listFavourites,
  removeFavourite,
} from '../services/favourites-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Favourites — the user's saved characters.
 *
 * EVERY ROUTE HERE REQUIRES A SESSION, which is the whole reason this is its
 * own plugin rather than three more handlers in `public-home.ts`. That file is
 * the deliberately account-free public surface; a favourite is per-user data
 * and has no anonymous reading. Keeping them apart means no future edit can
 * make a favourite readable by omitting a parameter.
 *
 * `request.currentUser` is resolved once by the auth plugin and is the ONLY
 * source of the user id — it is never accepted from a path, a body or a query,
 * so one account cannot address another's favourites.
 *
 * NO LOCAL STORAGE ANYWHERE IN THIS FEATURE. These four routes are the entire
 * persistence story: the browser holds no favourite state it did not read back
 * from here, which is what makes a favourite survive a refresh, a new device
 * and a cleared cache.
 */
export default async function favouriteRoutes(app: FastifyInstance, opts: { db: Db }) {
  /**
   * The Favourites gallery.
   *
   * Cards in the SAME shape Play with me serves, composed by the same function,
   * so the gallery renders identical tiles from identical data. `clip` is null
   * for a saved character with no currently publishable video; the client
   * renders no tile for her rather than substituting an image.
   *
   * `characterIds` is the raw persisted relationship, unfiltered by
   * eligibility, and is what the heart reads. The two differ on purpose: a
   * character can be saved while temporarily unrenderable, and her heart must
   * stay filled through that.
   */
  app.get('/api/favourites', { preHandler: app.requireAuth }, async (request) =>
    listFavourites(opts.db, request.currentUser!.id),
  );

  /**
   * Save a character — what a RIGHT SWIPE does, and what the empty heart does.
   *
   * 201 when the row is new, 200 when it already existed. Both are success:
   * swiping right on an already-favourited character must leave her favourited,
   * so a repeat is a no-op rather than a conflict, and never a toggle.
   *
   * The character id travels in the path rather than a body because this is
   * addressing one relationship, not submitting a document — and it keeps the
   * route symmetrical with the DELETE below.
   */
  app.put<{ Params: { characterId: string } }>(
    '/api/favourites/:characterId',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { characterId } = request.params;
      // Malformed ids read as "not found" rather than a Postgres cast error —
      // the same treatment the character routes give them.
      if (!UUID_RE.test(characterId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      const result = await addFavourite(opts.db, request.currentUser!.id, characterId);
      if (!result.ok) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      return reply.code(result.created ? 201 : 200).send({ favourited: true });
    },
  );

  /**
   * Remove a character — what tapping the FILLED heart does, and the only way a
   * favourite is ever deleted. No swipe reaches this handler.
   *
   * 200 whether or not a row went: the caller asked for "not favourited" and
   * that is the state afterwards either way. Reporting 404 for an unsaved
   * character would make a double-tap look like a failure and would leak
   * whether a favourite existed.
   */
  app.delete<{ Params: { characterId: string } }>(
    '/api/favourites/:characterId',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      await removeFavourite(opts.db, request.currentUser!.id, characterId);
      return reply.code(200).send({ favourited: false });
    },
  );
}
