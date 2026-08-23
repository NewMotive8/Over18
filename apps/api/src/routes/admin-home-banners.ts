import { createReadStream } from 'node:fs';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HomeBannerSlot } from '@over18/shared';
import { BANNER_AUDIENCES, BANNER_DESTINATION_KINDS, HOME_BANNER_SLOTS } from '@over18/shared';
import type { Db } from '../db/client.js';
import {
  BannerCreativeError,
  BANNER_CREATIVE_MAX_BYTES,
  bannerCreativeRequirements,
  createBannerCreative,
  getBannerCreative,
  listBannerCreatives,
  resolveBannerCreative,
  toBannerCreativeView,
  type BannerCreativeStorage,
} from '../services/banner-creative-service.js';
import {
  createHomeBanner,
  deleteHomeBanner,
  getHomeBanner,
  HomeBannerNotPublishableError,
  HomeBannerOrderError,
  HomeBannerValidationError,
  listBannerDestinations,
  listHomeBanners,
  publishHomeBanner,
  reorderHomeBanners,
  unpublishHomeBanner,
  updateHomeBanner,
} from '../services/home-banner-service.js';

/**
 * Admin → Categories & Publishing → Banners (US-102.3).
 *
 * Every route is `requireAuth` + `requireAdmin`, like the rest of the admin
 * API. There is deliberately NO public route in this file: what the app shows
 * on Home is US-102.4's to build, and it consumes listEligibleHomeBanners from
 * the service rather than anything exposed here.
 *
 * `now` is resolved once per request and threaded into the service, so a single
 * response can never straddle a schedule boundary and report one banner as
 * Scheduled and its neighbour as Live from two different clock reads.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bannerBodyProperties = {
  title: { type: 'string', minLength: 1, maxLength: 300 },
  subtitle: { type: ['string', 'null'], maxLength: 500 },
  ctaLabel: { type: ['string', 'null'], maxLength: 120 },
  creativeId: { type: ['string', 'null'] },
  destinationKind: { type: 'string', enum: [...BANNER_DESTINATION_KINDS] },
  destinationCategoryId: { type: ['string', 'null'] },
  destinationCharacterId: { type: ['string', 'null'] },
  destinationAssetId: { type: ['string', 'null'] },
  destinationUrl: { type: ['string', 'null'], maxLength: 2000 },
  audience: { type: 'string', enum: [...BANNER_AUDIENCES] },
  /** US-102.4 — which Home slot this banner renders in. */
  slot: { type: 'string', enum: [...HOME_BANNER_SLOTS] },
  startsAt: { type: ['string', 'null'] },
  endsAt: { type: ['string', 'null'] },
  scheduleTimezone: { type: ['string', 'null'], maxLength: 100 },
} as const;

const createBodySchema = {
  type: 'object',
  required: ['title', 'destinationKind'],
  additionalProperties: false,
  properties: bannerBodyProperties,
} as const;

const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...bannerBodyProperties,
    // Accepted only so the handler can explain why it is refused.
    status: {},
  },
} as const;

const orderBodySchema = {
  type: 'object',
  required: ['slot', 'orderedIds'],
  additionalProperties: false,
  properties: {
    // Ordering is per slot (US-102.4), so the slot is part of the request.
    slot: { type: 'string', enum: [...HOME_BANNER_SLOTS] },
    orderedIds: { type: 'array', items: { type: 'string' }, maxItems: 200 },
  },
} as const;

export default async function adminHomeBannerRoutes(
  app: FastifyInstance,
  opts: { db: Db; creativeStorage?: BannerCreativeStorage },
) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };
  const storage = opts.creativeStorage ?? null;

  // Scoped to this plugin, exactly as the content routes do it: multipart
  // parsing exists only where an upload actually lands.
  await app.register(multipart, {
    limits: { fileSize: BANNER_CREATIVE_MAX_BYTES, files: 1, fields: 8, fieldSize: 4096 },
  });

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'not_found', message: 'Banner not found.' });

  const noStorage = (reply: FastifyReply) =>
    reply
      .code(503)
      .send({ error: 'media_unavailable', message: 'Banner media storage is not configured.' });

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof HomeBannerValidationError) {
      return reply
        .code(400)
        .send({ error: 'invalid_banner', field: error.field, message: error.message });
    }
    if (error instanceof HomeBannerNotPublishableError) {
      return reply.code(409).send({
        error: 'not_publishable',
        problems: error.problems,
        message: error.message,
      });
    }
    throw error;
  };

  /* ---------------- creatives ---------------- */

  /**
   * The rules, as data. The editor renders these rather than restating them,
   * so what an operator is told can never drift from what is enforced.
   */
  app.get('/admin/home-banners/creative-requirements', adminOnly, async () =>
    bannerCreativeRequirements(),
  );

  /**
   * Uploads one banner creative.
   *
   * DEDICATED CMS ASSET: it never becomes a character asset, never enters
   * Review, and counts toward no content requirement. Formats and the size
   * ceiling come from the shared authoritative list.
   */
  app.post('/admin/home-banners/creatives', adminOnly, async (request, reply) => {
    if (!storage) return noStorage(reply);
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'invalid_request', message: 'A file part is required.' });
    }
    const bytes = await file.toBuffer();
    if (file.file.truncated) {
      return reply.code(413).send({
        error: 'too_large',
        message: `That file exceeds the ${Math.round(BANNER_CREATIVE_MAX_BYTES / (1024 * 1024))}MB upload limit.`,
      });
    }
    try {
      const created = await createBannerCreative(opts.db, storage, {
        mimeType: file.mimetype,
        bytes,
        originalName: file.filename,
        uploadedBy: request.currentUser?.id ?? null,
      });
      return reply.code(201).send(toBannerCreativeView(created));
    } catch (err) {
      if (err instanceof BannerCreativeError) {
        return reply.code(err.kind === 'too_large' ? 413 : 400).send({
          error: err.kind,
          message: err.message,
        });
      }
      throw err;
    }
  });

  /** Previously uploaded creatives, so one can be reused without re-uploading. */
  app.get('/admin/home-banners/creatives', adminOnly, async () => {
    const rows = await listBannerCreatives(opts.db);
    return { creatives: rows.map(toBannerCreativeView) };
  });

  /**
   * Streams a creative by id. The ONLY locator the browser is given — the
   * storage path never leaves the server, and resolveBannerCreative enforces
   * MEDIA_STORAGE_DIR containment rather than trusting the column.
   */
  app.get<{ Params: { creativeId: string } }>(
    '/admin/home-banners/creatives/:creativeId/file',
    adminOnly,
    async (request, reply) => {
      if (!storage) return noStorage(reply);
      const { creativeId } = request.params;
      if (!UUID_RE.test(creativeId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Creative not found.' });
      }
      const row = await getBannerCreative(opts.db, creativeId);
      if (!row) {
        return reply.code(404).send({ error: 'not_found', message: 'Creative not found.' });
      }
      const resolved = resolveBannerCreative(row, storage);
      if (!resolved.ok) {
        return reply.code(404).send({
          error: resolved.reason === 'file_missing' ? 'file_missing' : 'not_found',
          message:
            resolved.reason === 'file_missing'
              ? 'The creative record exists but its file is missing.'
              : 'Creative not found.',
        });
      }
      reply.header('content-type', resolved.contentType);
      reply.header('cache-control', 'private, max-age=60');
      return reply.send(createReadStream(resolved.path));
    },
  );

  /* ---------------- destinations ---------------- */

  /**
   * Selectable entities for the destination picker — never raw ids typed by
   * hand. Only things that would actually work are offered.
   */
  app.get('/admin/home-banners/destinations', adminOnly, async () =>
    listBannerDestinations(opts.db),
  );

  /* ---------------- ordering ---------------- */

  /** Declared before `:bannerId` so "order" is never parsed as an id. */
  app.put<{ Body: { slot: HomeBannerSlot; orderedIds: string[] } }>(
    '/admin/home-banners/order',
    { ...adminOnly, schema: { body: orderBodySchema } },
    async (request, reply) => {
      if (!storage) return noStorage(reply);
      try {
        await reorderHomeBanners(opts.db, request.body.slot, request.body.orderedIds);
      } catch (error) {
        if (error instanceof HomeBannerOrderError) {
          return reply
            .code(409)
            .send({ error: 'order_out_of_date', reason: error.reason, message: error.message });
        }
        throw error;
      }
      return { banners: await listHomeBanners(opts.db, storage, new Date()) };
    },
  );

  /* ---------------- banners ---------------- */

  app.get('/admin/home-banners', adminOnly, async (_request, reply) => {
    if (!storage) return noStorage(reply);
    const banners = await listHomeBanners(opts.db, storage, new Date());
    return reply.send({
      banners,
      totals: {
        total: banners.length,
        live: banners.filter((b) => b.state === 'live').length,
        scheduled: banners.filter((b) => b.state === 'scheduled').length,
        needsAttention: banners.filter((b) => b.state === 'needs_attention').length,
      },
      requirements: bannerCreativeRequirements(),
    });
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/admin/home-banners',
    { ...adminOnly, schema: { body: createBodySchema } },
    async (request, reply) => {
      if (!storage) return noStorage(reply);
      try {
        // Always a draft: the service ignores any status the caller sends.
        const created = await createHomeBanner(
          opts.db,
          storage,
          request.body as never,
          new Date(),
        );
        return reply.code(201).send(created);
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.get<{ Params: { bannerId: string } }>(
    '/admin/home-banners/:bannerId',
    adminOnly,
    async (request, reply) => {
      if (!storage) return noStorage(reply);
      const { bannerId } = request.params;
      if (!UUID_RE.test(bannerId)) return notFound(reply);
      const banner = await getHomeBanner(opts.db, storage, bannerId, new Date());
      return banner ?? notFound(reply);
    },
  );

  app.patch<{ Params: { bannerId: string }; Body: Record<string, unknown> }>(
    '/admin/home-banners/:bannerId',
    { ...adminOnly, schema: { body: updateBodySchema } },
    async (request, reply) => {
      if (!storage) return noStorage(reply);
      const { bannerId } = request.params;
      if (!UUID_RE.test(bannerId)) return notFound(reply);
      // Lifecycle moves are explicit actions with their own routes: an edit
      // must never be able to publish or withdraw a banner as a side effect.
      if ('status' in (request.body ?? {})) {
        return reply.code(400).send({
          error: 'immutable_field',
          message:
            'A banner\'s state changes through Publish and Unpublish, not by editing. Use those actions.',
        });
      }
      try {
        const updated = await updateHomeBanner(
          opts.db,
          storage,
          bannerId,
          request.body as never,
          new Date(),
        );
        return updated ?? notFound(reply);
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.post<{ Params: { bannerId: string } }>(
    '/admin/home-banners/:bannerId/publish',
    adminOnly,
    async (request, reply) => {
      if (!storage) return noStorage(reply);
      const { bannerId } = request.params;
      if (!UUID_RE.test(bannerId)) return notFound(reply);
      try {
        const published = await publishHomeBanner(opts.db, storage, bannerId, new Date());
        return published ?? notFound(reply);
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.post<{ Params: { bannerId: string } }>(
    '/admin/home-banners/:bannerId/unpublish',
    adminOnly,
    async (request, reply) => {
      if (!storage) return noStorage(reply);
      const { bannerId } = request.params;
      if (!UUID_RE.test(bannerId)) return notFound(reply);
      const updated = await unpublishHomeBanner(opts.db, storage, bannerId, new Date());
      return updated ?? notFound(reply);
    },
  );

  /**
   * Deletes a banner. THE CREATIVE IS NOT DELETED — its row and its file
   * survive and can be reused by another banner.
   */
  app.delete<{ Params: { bannerId: string } }>(
    '/admin/home-banners/:bannerId',
    adminOnly,
    async (request, reply) => {
      const { bannerId } = request.params;
      if (!UUID_RE.test(bannerId)) return notFound(reply);
      const deleted = await deleteHomeBanner(opts.db, bannerId);
      if (!deleted) return notFound(reply);
      return reply.code(200).send({ deleted: true, creativeKept: true });
    },
  );
}
