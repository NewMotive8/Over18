import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import type { CharacterVisualAssetRow } from '../db/schema.js';
import { CostLedger } from '../media-pipeline/cost-ledger.js';
import type { MediaProviders } from '../media-pipeline/types.js';
import {
  type MediaJobResult,
  type MediaStorageConfig,
} from '../services/media-generation-service.js';
import { submitAsMediaJobResult } from '../generation/jobs.js';
import { modelIdForProviders } from '../services/media-providers.js';
import { getVisualAssetById } from '../services/visual-asset-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATINGS = ['sfw', 'explicit'] as const;
const STATUSES = ['generated', 'under_review'] as const;
const RESOLUTIONS = ['480p', '720p', '1080p'] as const;

/** Input-validation / precondition failures map to 400; everything else 502. */
const CLIENT_ERROR_KINDS = new Set([
  'invalid_configuration',
  'no_active_identity',
  'reference_not_found',
  'reference_not_local',
  'source_not_found',
  'source_file_missing',
  'budget_refused',
]);

const imageBodySchema = {
  type: 'object',
  required: ['characterId', 'prompt'],
  additionalProperties: false,
  properties: {
    characterId: { type: 'string' },
    prompt: { type: 'string', minLength: 1, maxLength: 2000 },
    referenceAssetId: { type: 'string' },
    contentRating: { type: 'string', enum: RATINGS },
    status: { type: 'string', enum: STATUSES },
    width: { type: 'integer', minimum: 64, maximum: 4096 },
    height: { type: 'integer', minimum: 64, maximum: 4096 },
  },
} as const;

const videoBodySchema = {
  type: 'object',
  required: ['characterId', 'sourceImageAssetId', 'motionPrompt'],
  additionalProperties: false,
  properties: {
    characterId: { type: 'string' },
    sourceImageAssetId: { type: 'string' },
    motionPrompt: { type: 'string', minLength: 1, maxLength: 2000 },
    durationSeconds: { type: 'integer', minimum: 2, maximum: 15 },
    resolution: { type: 'string', enum: RESOLUTIONS },
    contentRating: { type: 'string', enum: RATINGS },
    status: { type: 'string', enum: STATUSES },
  },
} as const;

/** Deterministic, provenance-light projection of the persisted asset row. */
function assetView(row: CharacterVisualAssetRow) {
  const provenance = row.provenance as Record<string, unknown>;
  return {
    id: row.id,
    characterId: row.characterId,
    visualIdentityId: row.visualIdentityId,
    kind: row.kind,
    status: row.status,
    contentRating: row.contentRating,
    isCanonical: row.isCanonical,
    storageKey: row.storageKey,
    mediaType: provenance.mediaType ?? null,
    provider: provenance.provider ?? null,
    model: provenance.model ?? null,
    createdAt: row.createdAt,
  };
}

function respond(reply: FastifyReply, result: MediaJobResult) {
  if (result.ok) {
    return reply.code(201).send({ jobId: result.jobId, asset: assetView(result.asset), cost: result.cost });
  }
  const status = CLIENT_ERROR_KINDS.has(result.error.kind) ? 400 : 502;
  return reply.code(status).send({ jobId: result.jobId, error: result.error });
}

function contentTypeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  return 'image/jpeg';
}

/**
 * Internal media generation endpoints (US-36 PoC).
 *
 * Gated by a shared secret (INTERNAL_MEDIA_TOKEN) presented as `x-internal-token`
 * — these endpoints can spend real provider money, so they are deliberately NOT
 * exposed to ordinary authenticated users. When the token is unconfigured the
 * routes refuse with 503 rather than running open. Prompts are passed through
 * from the request body; no content is baked into the server.
 */
export default async function internalMediaRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    providers: MediaProviders;
    storage: MediaStorageConfig;
    ledgerPath: string;
    internalToken: string | null;
    characterBudgetUsd?: number;
  },
) {
  const requireInternalToken = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!opts.internalToken) {
      await reply.code(503).send({ error: 'internal_media_not_configured', message: 'INTERNAL_MEDIA_TOKEN is not set; internal media endpoints are disabled.' });
      return;
    }
    const presented = request.headers['x-internal-token'];
    const provided = typeof presented === 'string' ? presented : '';
    const a = Buffer.from(provided);
    const b = Buffer.from(opts.internalToken);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Valid x-internal-token required.' });
    }
  };

  const deps = () => ({
    providers: opts.providers,
    ledger: new CostLedger(opts.ledgerPath),
    storage: opts.storage,
    characterBudgetUsd: opts.characterBudgetUsd,
  });

  app.post<{ Body: { characterId: string; prompt: string; referenceAssetId?: string; contentRating?: 'sfw' | 'explicit'; status?: 'generated' | 'under_review'; width?: number; height?: number } }>(
    '/internal/media/generate-image',
    { preHandler: requireInternalToken, schema: { body: imageBodySchema } },
    async (request, reply) => {
      const b = request.body;
      if (!UUID_RE.test(b.characterId)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'characterId must be a UUID.' });
      }
      if (b.referenceAssetId && !UUID_RE.test(b.referenceAssetId)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'referenceAssetId must be a UUID.' });
      }
      // US-103: routed through the SHARED job path — the same one the future
      // Generation Studio uses. One execution path, no duplicated provider logic.
      const result = await submitAsMediaJobResult(opts.db, deps(), {
        type: 'image',
        characterId: b.characterId,
        prompt: b.prompt,
        primaryReferenceAssetId: b.referenceAssetId,
        contentRating: b.contentRating,
        width: b.width,
        height: b.height,
      }, modelIdForProviders('image', opts.providers));
      request.log.info({ jobId: result.jobId, ok: result.ok, op: 'generate-image' }, 'media job');
      return respond(reply, result);
    },
  );

  app.post<{ Body: { characterId: string; sourceImageAssetId: string; motionPrompt: string; durationSeconds?: number; resolution?: '480p' | '720p' | '1080p'; contentRating?: 'sfw' | 'explicit'; status?: 'generated' | 'under_review' } }>(
    '/internal/media/generate-video',
    { preHandler: requireInternalToken, schema: { body: videoBodySchema } },
    async (request, reply) => {
      const b = request.body;
      if (!UUID_RE.test(b.characterId)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'characterId must be a UUID.' });
      }
      if (!UUID_RE.test(b.sourceImageAssetId)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'sourceImageAssetId must be a UUID.' });
      }
      const result = await submitAsMediaJobResult(opts.db, deps(), {
        type: 'video',
        characterId: b.characterId,
        sourceImageAssetId: b.sourceImageAssetId,
        motionPrompt: b.motionPrompt,
        durationSeconds: b.durationSeconds,
        resolution: b.resolution,
        contentRating: b.contentRating,
      }, modelIdForProviders('video', opts.providers));
      request.log.info({ jobId: result.jobId, ok: result.ok, op: 'generate-video' }, 'media job');
      return respond(reply, result);
    },
  );

  /** Download a generated asset file (same internal token). */
  app.get<{ Params: { assetId: string } }>(
    '/internal/media/assets/:assetId',
    { preHandler: requireInternalToken },
    async (request, reply) => {
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'assetId must be a UUID.' });
      }
      const row = await getVisualAssetById(opts.db, assetId);
      if (!row || !row.storageKey) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      const filePath = row.storageKey;
      if (!existsSync(filePath)) {
        return reply.code(404).send({
          error: 'file_missing',
          message: 'Asset row exists but file is missing on disk (redeploy may have wiped /tmp).',
          storageKey: row.storageKey,
        });
      }
      reply.header('content-type', contentTypeForPath(filePath));
      reply.header('cache-control', 'private, max-age=60');
      return reply.send(createReadStream(filePath));
    },
  );
}
