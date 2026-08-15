import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import {
  approveVisualAsset,
  rejectVisualAsset,
  VisualAssetNotFoundError,
  VisualAssetTransitionError,
  type ContentRating,
  type VisualAssetStatus,
} from '../services/visual-asset-service.js';
import {
  getReviewAsset,
  listReviewQueue,
  summariseReviewByCharacter,
  updateAssetMetadata,
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

export default async function adminContentRoutes(app: FastifyInstance, opts: { db: Db }) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };

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
