import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import {
  createDiscoveryCategory,
  deleteDiscoveryCategory,
  DiscoveryOrderError,
  DiscoverySlugTakenError,
  DiscoveryValidationError,
  listAssetKeywords,
  listDiscoveryCategories,
  listKeywords,
  listTaggableAssets,
  reorderDiscoveryCategories,
  setAssetKeywords,
  setDiscoveryCategoryKeywords,
  updateDiscoveryCategory,
} from '../services/discovery-service.js';

/**
 * Admin → Categories & Publishing → Discovery (US-102.4).
 *
 * Manages the keyword vocabulary, the discovery categories built from it, and
 * the keywords carried by individual pieces of content.
 *
 * SEPARATE FROM APP CATEGORIES, all the way down. Different routes, different
 * services, different tables. Nothing here can publish anything to Home, and
 * nothing in the Home routes can change a keyword.
 *
 * Every route is `requireAuth` + `requireAdmin`.
 */
export default async function adminDiscoveryRoutes(app: FastifyInstance, opts: { db: Db }) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof DiscoveryValidationError) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', field: error.field, message: error.message });
    }
    if (error instanceof DiscoverySlugTakenError) {
      return reply.code(409).send({ error: 'slug_taken', slug: error.slug, message: error.message });
    }
    if (error instanceof DiscoveryOrderError) {
      return reply
        .code(409)
        .send({ error: 'order_out_of_date', reason: error.reason, message: error.message });
    }
    throw error;
  };

  /** Clamped — see the note in admin-home.ts; a negative LIMIT is a 500. */
  const boundedLimit = (raw: string | undefined, fallback = 100, max = 200): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
  };

  const keywordArray = { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 50 } as const;

  /* ---------------- keywords ---------------- */

  app.get('/admin/discovery/keywords', adminOnly, async () => ({
    keywords: await listKeywords(opts.db),
  }));

  /* ---------------- discovery categories ---------------- */

  app.get('/admin/discovery/categories', adminOnly, async () => ({
    categories: await listDiscoveryCategories(opts.db),
  }));

  app.post<{ Body: { name: string; slug?: string; keywords?: string[]; enabled?: boolean } }>(
    '/admin/discovery/categories',
    {
      ...adminOnly,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            slug: { type: 'string', maxLength: 60 },
            keywords: keywordArray,
            enabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.code(201).send(await createDiscoveryCategory(opts.db, request.body));
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /** Declared before `:categoryId` so "order" is never parsed as an id. */
  app.put<{ Body: { orderedIds: string[] } }>(
    '/admin/discovery/categories/order',
    {
      ...adminOnly,
      schema: {
        body: {
          type: 'object',
          required: ['orderedIds'],
          additionalProperties: false,
          properties: { orderedIds: { type: 'array', items: { type: 'string' }, maxItems: 200 } },
        },
      },
    },
    async (request, reply) => {
      try {
        await reorderDiscoveryCategories(opts.db, request.body.orderedIds);
      } catch (error) {
        return failed(reply, error);
      }
      return { categories: await listDiscoveryCategories(opts.db) };
    },
  );

  /** Renames or enables/disables. The slug is immutable, as in US-102.1. */
  app.patch<{ Params: { categoryId: string }; Body: { name?: string; enabled?: boolean } }>(
    '/admin/discovery/categories/:categoryId',
    {
      ...adminOnly,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            enabled: { type: 'boolean' },
            // Accepted only so the handler can explain why it is refused.
            slug: {},
          },
        },
      },
    },
    async (request, reply) => {
      if ('slug' in (request.body ?? {})) {
        return reply.code(400).send({
          error: 'immutable_field',
          message: 'A discovery category\'s slug is its permanent identity. Rename it instead.',
        });
      }
      try {
        const updated = await updateDiscoveryCategory(opts.db, request.params.categoryId, request.body);
        return updated ?? reply.code(404).send({ error: 'not_found', message: 'Category not found.' });
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /** Replaces the keyword set. No asset's own keywords are changed. */
  app.put<{ Params: { categoryId: string }; Body: { keywords: string[] } }>(
    '/admin/discovery/categories/:categoryId/keywords',
    {
      ...adminOnly,
      schema: {
        body: {
          type: 'object',
          required: ['keywords'],
          additionalProperties: false,
          properties: { keywords: keywordArray },
        },
      },
    },
    async (request, reply) => {
      try {
        const updated = await setDiscoveryCategoryKeywords(
          opts.db,
          request.params.categoryId,
          request.body.keywords,
        );
        return updated ?? reply.code(404).send({ error: 'not_found', message: 'Category not found.' });
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /**
   * Removes a discovery category. THE CONTENT AND ITS KEYWORDS SURVIVE — the
   * response states both counts rather than asking anyone to trust it.
   */
  app.delete<{ Params: { categoryId: string } }>(
    '/admin/discovery/categories/:categoryId',
    adminOnly,
    async (request, reply) => {
      try {
        const result = await deleteDiscoveryCategory(opts.db, request.params.categoryId);
        if (!result.deleted) {
          return reply.code(404).send({ error: 'not_found', message: 'Category not found.' });
        }
        return result;
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /* ---------------- content keywords ---------------- */

  app.get<{ Querystring: { limit?: string } }>(
    '/admin/discovery/content',
    adminOnly,
    async (request) => ({
      assets: await listTaggableAssets(opts.db, boundedLimit(request.query.limit)),
    }),
  );

  app.get<{ Params: { assetId: string } }>(
    '/admin/discovery/content/:assetId/keywords',
    adminOnly,
    async (request, reply) => {
      try {
        return { keywords: await listAssetKeywords(opts.db, request.params.assetId) };
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /**
   * Replaces one asset's keywords.
   *
   * Writes only `asset_keywords`. Tagging is metadata: it cannot change an
   * asset's status, its bytes, its rating or its review history.
   */
  app.put<{ Params: { assetId: string }; Body: { keywords: string[] } }>(
    '/admin/discovery/content/:assetId/keywords',
    {
      ...adminOnly,
      schema: {
        body: {
          type: 'object',
          required: ['keywords'],
          additionalProperties: false,
          properties: { keywords: keywordArray },
        },
      },
    },
    async (request, reply) => {
      try {
        return {
          keywords: await setAssetKeywords(opts.db, request.params.assetId, request.body.keywords),
        };
      } catch (error) {
        return failed(reply, error);
      }
    },
  );
}
