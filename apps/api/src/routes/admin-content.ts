import { createReadStream, existsSync } from 'node:fs';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import {
  approveVisualAsset,
  getVisualAssetById,
  rejectVisualAsset,
  VisualAssetNotFoundError,
  VisualAssetTransitionError,
  type ContentRating,
  type VisualAssetStatus,
} from '../services/visual-asset-service.js';
import {
  LibraryUploadError,
  uploadLibraryAsset,
  uploadedMimeTypeOf,
  uploadedPathOf,
  type LibraryUploadStorage,
} from '../services/library-upload-service.js';
import {
  getReviewAsset,
  listLibrary,
  listRecentLibrary,
  listReviewQueue,
  summariseReviewByCharacter,
  updateAssetMetadata,
  type LibraryAsset,
  type MediaType,
} from '../services/content-review-service.js';

/**
 * US-106 — admin content review API.
 *
 * Every route is `requireAuth` + `requireAdmin`, reusing the existing session
 * auth established in US-99/US-103. No new lifecycle: approve and reject are
 * the existing EPIC 7 operations, and "remove" is a REJECT, never a delete, so
 * provenance survives.
 */
const RATINGS: ContentRating[] = ['sfw', 'explicit'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assetView(a: Awaited<ReturnType<typeof getReviewAsset>>) {
  if (!a) return null;
  const provenance = (a.provenance ?? {}) as Record<string, unknown>;
  return {
    assetId: a.id,
    characterId: a.characterId,
    characterName: a.characterName,
    visualIdentityId: a.visualIdentityId,
    mediaType: a.mediaType,
    status: a.status,
    kind: a.kind,
    contentRating: a.contentRating,
    /** DB column is is_canonical; the product term is Primary. */
    isPrimary: a.isCanonical,
    position: a.position,
    storageKey: a.storageKey,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    approvedAt: a.approvedAt,
    // Only what the model actually stores — nothing invented.
    provenance: {
      jobId: provenance.jobId ?? null,
      provider: provenance.provider ?? null,
      model: provenance.model ?? null,
      generatedAt: provenance.generatedAt ?? null,
    },
  };
}

/** Library view = the review view plus why the item counts as recent. */
function libraryView(a: LibraryAsset) {
  return { ...assetView(a)!, recencyBasis: a.recencyBasis, recentAt: a.recentAt };
}

/** Max bytes accepted for one manual upload (videos need real headroom). */
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export default async function adminContentRoutes(
  app: FastifyInstance,
  opts: { db: Db; uploadStorage?: LibraryUploadStorage },
) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };

  // Scoped to this plugin: multipart parsing exists only where uploads land.
  await app.register(multipart, { limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } });

  /**
   * US-100 — the Content Library. One request returns BOTH the recent strip and
   * the filtered library, so the operator sees what just changed without
   * searching, and the UI needs no second round trip to render its default view.
   */
  app.get<{
    Querystring: { characterId?: string; status?: string; mediaType?: string; search?: string };
  }>('/admin/content/library', adminOnly, async (request, reply) => {
    const q = request.query;
    const filtered = Object.keys(q).length > 0;
    const [recent, all] = await Promise.all([
      listRecentLibrary(opts.db),
      listLibrary(opts.db, {
        characterId: q.characterId,
        status: q.status as never,
        mediaType: q.mediaType as MediaType | undefined,
        search: q.search,
      }),
    ]);
    return reply.send({
      // Recent is always present and always first — it is the default view, not
      // a filter the operator has to discover.
      recent: recent.map(libraryView),
      assets: all.map(libraryView),
      filtered,
    });
  });

  /**
   * Manual Library upload. NOT generation: no provider, model, cost or job is
   * involved. `characterId` is REQUIRED because character_visual_assets cannot
   * hold an unattached row; the upload lands on that character's active visual
   * identity, approved into the Library but never canonical, so the public
   * gallery rules are untouched.
   */
  app.post('/admin/content/uploads', adminOnly, async (request, reply) => {
    if (!opts.uploadStorage) {
      return reply.code(503).send({
        error: 'uploads_unavailable',
        message: 'Media storage is not configured for this environment.',
      });
    }
    const file = await request.file();
    if (!file) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'A file part is required.' });
    }
    // Multipart fields arrive alongside the file part.
    const characterId = (file.fields.characterId as { value?: string } | undefined)?.value;
    if (typeof characterId !== 'string' || !UUID_RE.test(characterId)) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'characterId must be a character UUID.' });
    }
    const rating = (file.fields.contentRating as { value?: string } | undefined)?.value;
    if (rating !== undefined && !RATINGS.includes(rating as ContentRating)) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'contentRating must be sfw or explicit.' });
    }

    const bytes = await file.toBuffer();
    if (file.file.truncated) {
      return reply.code(413).send({
        error: 'file_too_large',
        message: `That file exceeds the ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))}MB upload limit.`,
      });
    }

    try {
      const asset = await uploadLibraryAsset(opts.db, opts.uploadStorage, {
        characterId,
        mimeType: file.mimetype,
        bytes,
        originalName: file.filename,
        contentRating: rating as ContentRating | undefined,
        uploadedBy: request.currentUser?.id,
      });
      return reply.code(201).send(assetView(await getReviewAsset(opts.db, asset.id)));
    } catch (err) {
      if (err instanceof LibraryUploadError) {
        return reply.code(400).send({ error: err.kind, message: err.message });
      }
      throw err;
    }
  });

  /** Streams an uploaded asset's bytes. Admin-only, like the rest of this API. */
  app.get<{ Params: { assetId: string } }>(
    '/admin/content/uploads/:assetId/file',
    adminOnly,
    async (request, reply) => {
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      const asset = await getVisualAssetById(opts.db, assetId);
      const path = asset ? uploadedPathOf(asset) : null;
      if (!asset || !path) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      if (!existsSync(path)) {
        return reply.code(404).send({
          error: 'file_missing',
          message: 'Upload row exists but the file is missing (storage may not be persistent).',
        });
      }
      reply.header('content-type', uploadedMimeTypeOf(asset));
      reply.header('cache-control', 'private, max-age=60');
      return reply.send(createReadStream(path));
    },
  );

  /** Character-first entry: who has content waiting. */
  app.get('/admin/content/review/summary', adminOnly, async (_request, reply) => {
    return reply.send({ characters: await summariseReviewByCharacter(opts.db) });
  });

  /** The queue itself, newest first, optionally scoped to one character. */
  app.get<{ Querystring: { characterId?: string; status?: string; mediaType?: string } }>(
    '/admin/content/review',
    adminOnly,
    async (request, reply) => {
      const q = request.query;
      const assets = await listReviewQueue(opts.db, {
        characterId: q.characterId,
        status: q.status as VisualAssetStatus | undefined,
        mediaType: q.mediaType as MediaType | undefined,
      });
      return reply.send({ assets: assets.map(assetView) });
    },
  );

  app.get<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId',
    adminOnly,
    async (request, reply) => {
      const view = assetView(await getReviewAsset(opts.db, request.params.assetId));
      if (!view) return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      return reply.send(view);
    },
  );

  app.post<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId/approve',
    adminOnly,
    async (request, reply) => {
      try {
        await approveVisualAsset(opts.db, request.params.assetId, request.currentUser?.id);
        return reply.send(assetView(await getReviewAsset(opts.db, request.params.assetId)));
      } catch (err) {
        if (err instanceof VisualAssetNotFoundError) {
          return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
        }
        if (err instanceof VisualAssetTransitionError) {
          return reply.code(409).send({ error: 'invalid_transition', message: err.message });
        }
        throw err;
      }
    },
  );

  /**
   * Reject === the operator's "remove". The row, its provenance and its media
   * are preserved; only the lifecycle status changes. There is deliberately no
   * hard-delete endpoint.
   */
  app.post<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId/reject',
    adminOnly,
    async (request, reply) => {
      try {
        await rejectVisualAsset(opts.db, request.params.assetId);
        return reply.send(assetView(await getReviewAsset(opts.db, request.params.assetId)));
      } catch (err) {
        if (err instanceof VisualAssetNotFoundError) {
          return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
        }
        throw err;
      }
    },
  );

  /** Narrow metadata edit. Unsupported fields are refused, not ignored. */
  app.patch<{ Params: { assetId: string }; Body: Record<string, unknown> }>(
    '/admin/content/assets/:assetId',
    adminOnly,
    async (request, reply) => {
      const body = request.body ?? {};
      const allowed = new Set(['contentRating', 'position']);
      const unsupported = Object.keys(body).filter((k) => !allowed.has(k));
      if (unsupported.length > 0) {
        return reply.code(400).send({
          error: 'unsupported_field',
          message: `Not editable in review: ${unsupported.join(', ')}.`,
          supported: [...allowed],
        });
      }
      if (body.contentRating !== undefined && !RATINGS.includes(body.contentRating as ContentRating)) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: 'contentRating must be sfw or explicit.' });
      }

      const updated = await updateAssetMetadata(opts.db, request.params.assetId, {
        contentRating: body.contentRating as ContentRating | undefined,
        position: body.position as number | null | undefined,
      });
      if (!updated) return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      return reply.send(assetView(await getReviewAsset(opts.db, request.params.assetId)));
    },
  );
}
