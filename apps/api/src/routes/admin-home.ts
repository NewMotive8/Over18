import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import {
  addHeroClips,
  HomeAdminOrderError,
  HomeAdminValidationError,
  listHeroCandidates,
  listHeroClipsForAdmin,
  listHomeCategories,
  removeHeroClip,
  reorderHeroClips,
  reorderHomeCategories,
  setCategoryHomePublication,
} from '../services/home-admin-service.js';
import { composeHome, heroFallback, listPlayWithMe } from '../services/home-composition-service.js';

/**
 * Admin → Categories & Publishing → Home (US-102.4).
 *
 * Every route is `requireAuth` + `requireAdmin`, like the rest of the admin
 * API — including the preview, which renders real composed content and is
 * therefore exactly as sensitive as the rest of this surface.
 *
 * PREVIEW IS THE PUBLIC COMPOSITION, NOT A SEPARATE RENDERER. It calls the same
 * composeHome the public route calls, with an explicit viewer, so what an
 * operator previews is what the app produces. A second implementation would
 * drift, and the drift would show up as a preview that lies.
 */
export default async function adminHomeRoutes(
  app: FastifyInstance,
  opts: { db: Db; mediaStorageDir?: string | null },
) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };
  const storageDir = opts.mediaStorageDir ?? null;

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof HomeAdminValidationError) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', field: error.field, message: error.message });
    }
    if (error instanceof HomeAdminOrderError) {
      return reply
        .code(409)
        .send({ error: 'order_out_of_date', reason: error.reason, message: error.message });
    }
    throw error;
  };

  /**
   * A caller-supplied limit, clamped. Passing one straight through lets
   * `?limit=-5` reach Postgres, which raises "LIMIT must not be negative" — and
   * with no custom error handler installed, Fastify returns that as a 500 with
   * the database's own message in the body.
   */
  const boundedLimit = (raw: string | undefined, fallback = 100, max = 200): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
  };

  const orderBody = {
    type: 'object',
    required: ['orderedIds'],
    additionalProperties: false,
    properties: { orderedIds: { type: 'array', items: { type: 'string' }, maxItems: 500 } },
  } as const;

  /* ---------------- the composition ---------------- */

  app.get('/admin/home', adminOnly, async () => {
    const hero = await listHeroClipsForAdmin(opts.db);
    return {
      categories: await listHomeCategories(opts.db),
      hero,
      /**
       * What the public Hero is showing RIGHT NOW because nothing is assigned.
       *
       * Computed on read and never stored. An operator must be able to see the
       * difference between "I chose these clips" and "nothing is chosen, so the
       * app is borrowing some" — otherwise a full-looking Hero on the app looks
       * like configuration that does not exist. Empty whenever `hero` is not,
       * because a configured Hero is never topped up.
       */
      heroFallback: hero.length > 0 ? [] : heroFallback(await listPlayWithMe(opts.db)),
    };
  });

  /**
   * Preview — the real public payload, for both audience cases.
   *
   * Both viewers are composed because the audience model can put different
   * banners in front of new and returning users, and an operator previewing
   * only one of them would not see half of what they published.
   */
  app.get('/admin/home/preview', adminOnly, async () => {
    const now = new Date();
    const [newVisitor, returning] = await Promise.all([
      composeHome(opts.db, { storageDir: storageDir ?? '' }, { now, viewer: { isReturning: false } }),
      composeHome(opts.db, { storageDir: storageDir ?? '' }, { now, viewer: { isReturning: true } }),
    ]);
    return { generatedAt: now.toISOString(), newVisitor, returning };
  });

  /* ---------------- category publication ---------------- */

  app.patch<{ Params: { categoryId: string }; Body: { homePublished: boolean } }>(
    '/admin/home/categories/:categoryId',
    {
      ...adminOnly,
      schema: {
        body: {
          type: 'object',
          required: ['homePublished'],
          additionalProperties: false,
          properties: { homePublished: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      try {
        const updated = await setCategoryHomePublication(
          opts.db,
          request.params.categoryId,
          request.body.homePublished,
        );
        return updated ?? reply.code(404).send({ error: 'not_found', message: 'Category not found.' });
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.put<{ Body: { orderedIds: string[] } }>(
    '/admin/home/categories/order',
    { ...adminOnly, schema: { body: orderBody } },
    async (request, reply) => {
      try {
        await reorderHomeCategories(opts.db, request.body.orderedIds);
      } catch (error) {
        return failed(reply, error);
      }
      return { categories: await listHomeCategories(opts.db) };
    },
  );

  /* ---------------- hero ---------------- */

  app.get('/admin/home/hero', adminOnly, async () => ({
    clips: await listHeroClipsForAdmin(opts.db),
  }));

  app.get<{ Querystring: { limit?: string } }>(
    '/admin/home/hero/candidates',
    adminOnly,
    async (request) => ({
      candidates: await listHeroCandidates(opts.db, boundedLimit(request.query.limit)),
    }),
  );

  app.post<{ Body: { assetIds: string[] } }>(
    '/admin/home/hero',
    {
      ...adminOnly,
      schema: {
        body: {
          type: 'object',
          required: ['assetIds'],
          additionalProperties: false,
          properties: { assetIds: { type: 'array', items: { type: 'string' }, maxItems: 100 } },
        },
      },
    },
    async (request, reply) => {
      try {
        const outcomes = await addHeroClips(opts.db, request.body.assetIds);
        return { outcomes, clips: await listHeroClipsForAdmin(opts.db) };
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /** Removes a clip from the Hero. The Library asset is never touched. */
  app.delete<{ Params: { assetId: string } }>(
    '/admin/home/hero/:assetId',
    adminOnly,
    async (request, reply) => {
      try {
        const removed = await removeHeroClip(opts.db, request.params.assetId);
        if (!removed) {
          return reply.code(404).send({ error: 'not_found', message: 'That clip is not in the Hero.' });
        }
        return { removed: true, assetKept: true, clips: await listHeroClipsForAdmin(opts.db) };
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.put<{ Body: { orderedIds: string[] } }>(
    '/admin/home/hero/order',
    { ...adminOnly, schema: { body: orderBody } },
    async (request, reply) => {
      try {
        await reorderHeroClips(opts.db, request.body.orderedIds);
      } catch (error) {
        return failed(reply, error);
      }
      return { clips: await listHeroClipsForAdmin(opts.db) };
    },
  );

}
