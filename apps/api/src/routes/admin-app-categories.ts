import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import {
  addAssetsToCategory,
  categoryAssignmentCounts,
  getCategoryBySlug,
  listAssignmentCandidates,
  listCategoryAssetsForAdmin,
  MerchandisingOrderError,
  removeAssetsFromCategory,
  reorderCategoryAssets,
  setAssetFeatured,
} from '../services/app-merchandising-service.js';
import {
  AppCategoryOrderError,
  AppCategorySlugTakenError,
  AppCategoryValidationError,
  createAppCategory,
  deleteAppCategory,
  getAppCategory,
  listAppCategories,
  reorderAppCategories,
  updateAppCategory,
} from '../services/app-category-service.js';

/**
 * Admin → Categories & Publishing → App Categories (US-102.1).
 *
 * The App CMS surface for how approved Library content is ORGANISED in the
 * app. Every route is `requireAuth` + `requireAdmin`, identical to the rest of
 * the admin API — there is no new authorization concept here.
 *
 * These routes touch `app_categories` and its link table only. Managing a
 * category cannot, by construction, read or write an asset row, a content
 * requirement or anything in the Review → Approved → Library lifecycle.
 *
 * Registered as its own plugin rather than inside admin-settings: content
 * requirements define what to PRODUCE, app categories define how to
 * MERCHANDISE. Two different jobs that happen to share the word "category",
 * kept in two different files so they cannot drift into each other.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Body schemas. `additionalProperties: false` means an unexpected field is a
 * 400 before a handler runs — including a stray `slug` on PATCH, which gets
 * its own explicit message below rather than a generic schema rejection.
 */
const createBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    slug: { type: 'string', minLength: 1, maxLength: 60 },
    tagline: { type: ['string', 'null'], maxLength: 400 },
    enabled: { type: 'boolean' },
  },
} as const;

const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    // Accepted by the schema ONLY so the handler can explain why it is refused.
    slug: {},
    tagline: { type: ['string', 'null'], maxLength: 400 },
    enabled: { type: 'boolean' },
  },
} as const;

const assetIdsBodySchema = {
  type: 'object',
  required: ['assetIds'],
  additionalProperties: false,
  properties: { assetIds: { type: 'array', items: { type: 'string' }, maxItems: 500 } },
} as const;

const assetOrderBodySchema = {
  type: 'object',
  required: ['orderedAssetIds'],
  additionalProperties: false,
  properties: { orderedAssetIds: { type: 'array', items: { type: 'string' }, maxItems: 500 } },
} as const;

const featuredBodySchema = {
  type: 'object',
  required: ['featured'],
  additionalProperties: false,
  properties: { featured: { type: 'boolean' } },
} as const;

const orderBodySchema = {
  type: 'object',
  required: ['orderedIds'],
  additionalProperties: false,
  properties: {
    orderedIds: { type: 'array', items: { type: 'string' } },
  },
} as const;

export default async function adminAppCategoryRoutes(app: FastifyInstance, opts: { db: Db }) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'not_found', message: 'Category not found.' });

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AppCategoryValidationError) {
      return reply
        .code(400)
        .send({ error: 'invalid_category', field: error.field, message: error.message });
    }
    if (error instanceof AppCategorySlugTakenError) {
      return reply
        .code(409)
        .send({ error: 'slug_taken', slug: error.slug, message: error.message });
    }
    throw error;
  };

  /** Every category in merchandising order, each with its assignment count. */
  app.get('/admin/app-categories', adminOnly, async () => {
    const categories = await listAppCategories(opts.db);
    // US-102.2: how much of each category's content is CURRENTLY publishable.
    // An assignment whose asset was rejected afterwards still counts as
    // assigned but not as publishable, and the workspace says so.
    const counts = await categoryAssignmentCounts(opts.db);
    const withCounts = categories.map((category) => ({
      ...category,
      publishableAssetCount: counts.get(category.id)?.publishable ?? 0,
    }));
    return {
      categories: withCounts,
      totals: {
        categories: categories.length,
        enabled: categories.filter((category) => category.enabled).length,
        assignedAssets: categories.reduce((n, category) => n + category.assignedAssetCount, 0),
      },
    };
  });

  app.post<{ Body: { name: string; slug?: string; tagline?: string | null; enabled?: boolean } }>(
    '/admin/app-categories',
    { ...adminOnly, schema: { body: createBodySchema } },
    async (request, reply) => {
      try {
        const created = await createAppCategory(opts.db, request.body);
        return reply.code(201).send(created);
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /**
   * Reorder. Declared BEFORE the `:categoryId` routes so "order" is never
   * parsed as an id — Fastify's router prefers the static segment, but the
   * ordering here makes that independent of router internals.
   */
  app.put<{ Body: { orderedIds: string[] } }>(
    '/admin/app-categories/order',
    { ...adminOnly, schema: { body: orderBodySchema } },
    async (request, reply) => {
      try {
        const categories = await reorderAppCategories(opts.db, request.body.orderedIds);
        return { categories };
      } catch (error) {
        if (error instanceof AppCategoryOrderError) {
          // 409, not 400: the request is well-formed, it just describes a world
          // that has moved on. The client's fix is to reload, not to re-encode.
          return reply.code(409).send({
            error: 'order_out_of_date',
            reason: error.reason,
            message: error.message,
          });
        }
        return failed(reply, error);
      }
    },
  );

  app.patch<{
    Params: { categoryId: string };
    Body: { name?: string; tagline?: string | null; enabled?: boolean; slug?: unknown };
  }>(
    '/admin/app-categories/:categoryId',
    { ...adminOnly, schema: { body: updateBodySchema } },
    async (request, reply) => {
      const { categoryId } = request.params;
      if (!UUID_RE.test(categoryId)) return notFound(reply);
      // The slug is the stable identity anything referencing this category
      // holds. Changing it would break those references silently, so it is
      // refused with an explanation rather than ignored.
      if ('slug' in (request.body ?? {})) {
        return reply.code(400).send({
          error: 'immutable_field',
          message:
            "A category's identifier cannot change — it is what keeps existing references working. Rename the category instead; the name is free to change.",
        });
      }
      try {
        const { slug: _ignored, ...changes } = request.body ?? {};
        const updated = await updateAppCategory(opts.db, categoryId, changes);
        return updated ?? notFound(reply);
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /**
   * Deletes a category. ALWAYS ALLOWED, including when content is merchandised
   * in it — deliberately unlike content requirements, which refuse deletion
   * while in use.
   *
   * The product rule: deleting a category never deletes content. Its
   * assignments are released by an ON DELETE CASCADE on the LINK table, so the
   * assets stay in the Library, unassigned and available for reassignment. The
   * response reports how many became unassigned so the UI can say so honestly.
   */
  app.delete<{ Params: { categoryId: string } }>(
    '/admin/app-categories/:categoryId',
    adminOnly,
    async (request, reply) => {
      const { categoryId } = request.params;
      if (!UUID_RE.test(categoryId)) return notFound(reply);
      if (!(await getAppCategory(opts.db, categoryId))) return notFound(reply);
      const result = await deleteAppCategory(opts.db, categoryId);
      if (!result) return notFound(reply);
      return reply.code(200).send({
        deleted: true,
        releasedAssetCount: result.releasedAssetCount,
      });
    },
  );

  /* ---------------------------------------------------------------- *
   * US-102.2 — content distribution & category merchandising
   * ---------------------------------------------------------------- */

  /**
   * The picker's source list: APPROVED Library content only.
   *
   * Declared before the `:categoryId` routes so "candidates" is never read as
   * an id. Rating and Primary status are returned as visible facts and are
   * never used to exclude anything.
   *
   * THREE conditions now, not one: approved, not an identity reference, and a
   * video. A category is a public surface, and identity portraits and approved
   * images could both reach one through an assignment. Both exclusions live in
   * `listAssignmentCandidates`, so no query string reaches past them —
   * `mediaType` can narrow the list but never widen it.
   */
  app.get<{
    Querystring: {
      characterId?: string;
      mediaType?: string;
      contentRating?: string;
      search?: string;
      categoryId?: string;
      excludeAssigned?: string;
    };
  }>('/admin/app-categories/candidates', adminOnly, async (request) => {
    const q = request.query;
    const assets = await listAssignmentCandidates(opts.db, {
      characterId: q.characterId && UUID_RE.test(q.characterId) ? q.characterId : undefined,
      mediaType: q.mediaType === 'image' || q.mediaType === 'video' ? q.mediaType : undefined,
      contentRating: q.contentRating,
      search: q.search,
      categoryId: q.categoryId && UUID_RE.test(q.categoryId) ? q.categoryId : undefined,
      excludeAssigned: q.excludeAssigned === 'true',
    });
    return { assets };
  });

  /** Resolves the workspace URL's stable slug to the category it names. */
  app.get<{ Params: { slug: string } }>(
    '/admin/app-categories/by-slug/:slug',
    adminOnly,
    async (request, reply) => {
      const row = await getCategoryBySlug(opts.db, request.params.slug.toLowerCase());
      if (!row) return notFound(reply);
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        tagline: row.tagline,
        enabled: row.enabled,
        position: row.position,
      };
    },
  );

  /**
   * Everything assigned to a category — including items that have since lost
   * approval, flagged rather than hidden, so the operator can clean them up.
   * The approved-only view is a different function in the service.
   */
  app.get<{ Params: { categoryId: string } }>(
    '/admin/app-categories/:categoryId/assets',
    adminOnly,
    async (request, reply) => {
      const { categoryId } = request.params;
      if (!UUID_RE.test(categoryId)) return notFound(reply);
      if (!(await getAppCategory(opts.db, categoryId))) return notFound(reply);
      const assets = await listCategoryAssetsForAdmin(opts.db, categoryId);
      return {
        assets,
        totals: {
          assigned: assets.length,
          publishable: assets.filter((a) => a.publishable).length,
          featured: assets.filter((a) => a.featured).length,
        },
      };
    },
  );

  /**
   * Bulk add. Reports EVERY id's outcome rather than failing the batch: one
   * asset rejected while the picker was open must not discard the rest, and
   * must not be silently reported as added.
   */
  app.post<{ Params: { categoryId: string }; Body: { assetIds: string[] } }>(
    '/admin/app-categories/:categoryId/assets',
    { ...adminOnly, schema: { body: assetIdsBodySchema } },
    async (request, reply) => {
      const { categoryId } = request.params;
      if (!UUID_RE.test(categoryId)) return notFound(reply);
      if (!(await getAppCategory(opts.db, categoryId))) return notFound(reply);
      const outcomes = await addAssetsToCategory(opts.db, categoryId, request.body.assetIds);
      return reply.code(200).send({
        outcomes,
        added: outcomes.filter((o) => o.added).length,
        refused: outcomes.filter((o) => !o.added).length,
      });
    },
  );

  /**
   * Bulk remove. A POST rather than a DELETE because it carries a body, which
   * DELETE handling is inconsistent about across proxies and clients.
   *
   * Removes LINK ROWS ONLY — the assets keep their status, their approval and
   * their place in the Library, and stay in every other category they are in.
   */
  app.post<{ Params: { categoryId: string }; Body: { assetIds: string[] } }>(
    '/admin/app-categories/:categoryId/assets/remove',
    { ...adminOnly, schema: { body: assetIdsBodySchema } },
    async (request, reply) => {
      const { categoryId } = request.params;
      if (!UUID_RE.test(categoryId)) return notFound(reply);
      if (!(await getAppCategory(opts.db, categoryId))) return notFound(reply);
      const result = await removeAssetsFromCategory(opts.db, categoryId, request.body.assetIds);
      return { removed: result.removed };
    },
  );

  /** Whole-list reorder within a category. Exact permutation or 409. */
  app.put<{ Params: { categoryId: string }; Body: { orderedAssetIds: string[] } }>(
    '/admin/app-categories/:categoryId/assets/order',
    { ...adminOnly, schema: { body: assetOrderBodySchema } },
    async (request, reply) => {
      const { categoryId } = request.params;
      if (!UUID_RE.test(categoryId)) return notFound(reply);
      if (!(await getAppCategory(opts.db, categoryId))) return notFound(reply);
      try {
        await reorderCategoryAssets(opts.db, categoryId, request.body.orderedAssetIds);
      } catch (error) {
        if (error instanceof MerchandisingOrderError) {
          return reply.code(409).send({
            error: 'order_out_of_date',
            reason: error.reason,
            message: error.message,
          });
        }
        throw error;
      }
      return { assets: await listCategoryAssetsForAdmin(opts.db, categoryId) };
    },
  );

  /** Feature / un-feature one assignment. A link property, never an asset one. */
  app.patch<{
    Params: { categoryId: string; assetId: string };
    Body: { featured: boolean };
  }>(
    '/admin/app-categories/:categoryId/assets/:assetId',
    { ...adminOnly, schema: { body: featuredBodySchema } },
    async (request, reply) => {
      const { categoryId, assetId } = request.params;
      if (!UUID_RE.test(categoryId) || !UUID_RE.test(assetId)) return notFound(reply);
      const changed = await setAssetFeatured(opts.db, categoryId, assetId, request.body.featured);
      if (!changed) return notFound(reply);
      return { assets: await listCategoryAssetsForAdmin(opts.db, categoryId) };
    },
  );
}
