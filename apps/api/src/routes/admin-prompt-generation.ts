import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import {
  addPromptFiles,
  createBatch,
  deleteDraftBatch,
  getBatchDetail,
  listBatches,
} from '../prompt-generation/batches.js';
import {
  ASPECT_RATIOS,
  DEFAULT_MODEL,
  DEFAULT_PARAMS,
  MAX_FILES_PER_UPLOAD,
  MAX_PROMPT_FILE_BYTES,
  OUTPUTS_PER_PROMPT,
  estimateCost,
  pricePerImage,
  type AspectRatio,
  type GenerationParams,
  type PromptFileInput,
  type Quality,
  type Resolution,
} from '../prompt-generation/config.js';
import {
  pauseBatch,
  retryFailedInBatch,
  retryJob,
  retryOutput,
  startBatch,
  type PromptRunnerDeps,
} from '../prompt-generation/runner.js';

/**
 * Admin -> Generation. Every route is admin-only, and money can be spent
 * through two of them, so the guard is the same pair every other admin plugin
 * uses rather than anything bespoke.
 *
 * WHAT THIS PLUGIN DOES NOT DO, and the list is the point: it never writes a
 * `character_visual_asset`, never touches a category, a hero clip, the content
 * library or a character row, and never marks anything approved or published.
 * Its entire write surface is three tables that reference none of those. A
 * generated image reaches exactly one place — the operator's Drive folder.
 */

export interface PromptGenerationRouteOptions {
  db: Db;
  runner: PromptRunnerDeps;
  /** Reported to the UI so it can say which providers are live. Never a secret. */
  readiness: { xaiLive: boolean; driveLive: boolean; driveFolderId: string | null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function adminPromptGenerationRoutes(
  app: FastifyInstance,
  opts: PromptGenerationRouteOptions,
) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };

  /**
   * Scoped to this plugin, exactly as the other upload surfaces do it.
   * Prompt files are text: the per-file ceiling is tiny compared with the
   * 100MB media limit, because anything larger is not a prompt.
   */
  await app.register(multipart, {
    limits: {
      fileSize: MAX_PROMPT_FILE_BYTES,
      files: MAX_FILES_PER_UPLOAD,
      fields: 8,
      fieldSize: 4096,
    },
  });

  /** Defaults and readiness, so the UI never hard-codes a price or a model. */
  app.get('/admin/prompt-generation/settings', adminOnly, async () => ({
    model: DEFAULT_MODEL,
    outputsPerPrompt: OUTPUTS_PER_PROMPT,
    params: DEFAULT_PARAMS,
    aspectRatios: ASPECT_RATIOS,
    pricePerImageUsd: pricePerImage(DEFAULT_PARAMS),
    xaiLive: opts.readiness.xaiLive,
    driveLive: opts.readiness.driveLive,
    driveFolderId: opts.readiness.driveFolderId,
    /**
     * Sent so the operator sees the same wording the code carries: the web
     * app's "Quality" control and the API's `quality` parameter are not
     * documented as the same thing, and nothing here claims they are.
     */
    qualityNote:
      "The API's quality parameter accepts low or medium. It is not documented as equivalent to the Grok web app's Quality control; 2K + medium is the highest-fidelity combination the API exposes.",
  }));

  app.get('/admin/prompt-generation/batches', adminOnly, async () => ({
    batches: await listBatches(opts.db),
  }));

  app.post<{
    Body: { name?: string; params?: Partial<GenerationParams>; outputsPerPrompt?: number };
  }>('/admin/prompt-generation/batches', adminOnly, async (request, reply) => {
    const body = request.body ?? {};
    const params = body.params ?? {};
    if (params.aspectRatio && !ASPECT_RATIOS.includes(params.aspectRatio as AspectRatio)) {
      return reply
        .code(400)
        .send({ error: 'invalid_params', message: 'That aspect ratio is not supported.' });
    }
    if (params.resolution && !['1k', '2k'].includes(params.resolution as Resolution)) {
      return reply
        .code(400)
        .send({ error: 'invalid_params', message: 'Resolution must be 1k or 2k.' });
    }
    if (params.quality && !['low', 'medium'].includes(params.quality as Quality)) {
      return reply
        .code(400)
        .send({ error: 'invalid_params', message: 'Quality must be low or medium.' });
    }
    const batch = await createBatch(opts.db, {
      name: body.name ?? '',
      params,
      outputsPerPrompt: body.outputsPerPrompt,
      // The destination is server configuration, never a browser-supplied
      // folder id: a client that could name the folder could redirect an
      // operator's images anywhere in their Drive.
      driveFolderId: opts.readiness.driveFolderId,
      createdBy: request.currentUser?.id,
    });
    return reply.code(201).send({ batch: await getBatchDetail(opts.db, batch.id) });
  });

  /**
   * Multi-file .txt upload. Partial success is reported per file.
   *
   * Uploading COSTS NOTHING AND STARTS NOTHING. The batch stays in `draft`
   * until Start is pressed, which is what makes the cost estimate meaningful.
   */
  app.post<{ Params: { batchId: string } }>(
    '/admin/prompt-generation/batches/:batchId/files',
    adminOnly,
    async (request, reply) => {
      const { batchId } = request.params;
      if (!UUID_RE.test(batchId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Batch not found.' });
      }
      const detail = await getBatchDetail(opts.db, batchId);
      if (!detail) {
        return reply.code(404).send({ error: 'not_found', message: 'Batch not found.' });
      }
      if (detail.status !== 'draft' && detail.status !== 'paused') {
        return reply.code(409).send({
          error: 'batch_running',
          message: 'Pause the batch before adding more prompt files to it.',
        });
      }

      const files: PromptFileInput[] = [];
      const oversize: string[] = [];
      try {
        for await (const part of request.parts()) {
          if (part.type !== 'file') continue;
          const bytes = await part.toBuffer();
          if (part.file.truncated) {
            oversize.push(part.filename);
            continue;
          }
          files.push({ filename: part.filename, bytes });
        }
      } catch {
        return reply
          .code(400)
          .send({ error: 'invalid_upload', message: 'That upload could not be read.' });
      }

      const outcomes = await addPromptFiles(opts.db, batchId, files);
      for (const filename of oversize) {
        outcomes.push({
          filename,
          accepted: false,
          reason: 'too_large',
          message: 'That file is far larger than a prompt and was not added.',
        });
      }
      return {
        outcomes,
        added: outcomes.filter((o) => o.accepted).length,
        refused: outcomes.filter((o) => !o.accepted).length,
        batch: await getBatchDetail(opts.db, batchId),
      };
    },
  );

  /**
   * The queue. A GET, and ONLY a read — nothing here starts, resumes or
   * schedules work, which is what makes refreshing the Admin page unable to
   * restart a job.
   */
  app.get<{ Params: { batchId: string } }>(
    '/admin/prompt-generation/batches/:batchId',
    adminOnly,
    async (request, reply) => {
      if (!UUID_RE.test(request.params.batchId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Batch not found.' });
      }
      const batch = await getBatchDetail(opts.db, request.params.batchId);
      if (!batch) return reply.code(404).send({ error: 'not_found', message: 'Batch not found.' });
      return { batch };
    },
  );

  /** What this batch is expected to cost, before anyone can start it. */
  app.get<{ Params: { batchId: string } }>(
    '/admin/prompt-generation/batches/:batchId/estimate',
    adminOnly,
    async (request, reply) => {
      const batch = await getBatchDetail(opts.db, request.params.batchId);
      if (!batch) return reply.code(404).send({ error: 'not_found', message: 'Batch not found.' });
      return {
        estimate: estimateCost(batch.totals.prompts, batch.outputsPerPrompt, batch.params),
        live: opts.readiness.xaiLive,
      };
    },
  );

  app.post<{ Params: { batchId: string } }>(
    '/admin/prompt-generation/batches/:batchId/start',
    adminOnly,
    async (request, reply) => {
      const detail = await getBatchDetail(opts.db, request.params.batchId);
      if (!detail) return reply.code(404).send({ error: 'not_found', message: 'Batch not found.' });
      if (detail.totals.prompts === 0) {
        return reply
          .code(400)
          .send({ error: 'empty_batch', message: 'Upload prompt files before starting.' });
      }
      const outcome = await startBatch(opts.db, opts.runner, request.params.batchId);
      // 202: accepted and running in the background. The browser never waits
      // for a single image.
      return reply.code(202).send({
        started: outcome.started,
        reason: outcome.reason ?? null,
        batch: await getBatchDetail(opts.db, request.params.batchId),
      });
    },
  );

  app.post<{ Params: { batchId: string } }>(
    '/admin/prompt-generation/batches/:batchId/pause',
    adminOnly,
    async (request, reply) => {
      const paused = await pauseBatch(opts.db, request.params.batchId);
      const batch = await getBatchDetail(opts.db, request.params.batchId);
      if (!batch) return reply.code(404).send({ error: 'not_found', message: 'Batch not found.' });
      return { paused, batch };
    },
  );

  app.post<{ Params: { batchId: string } }>(
    '/admin/prompt-generation/batches/:batchId/retry-failed',
    adminOnly,
    async (request, reply) => {
      const batch = await getBatchDetail(opts.db, request.params.batchId);
      if (!batch) return reply.code(404).send({ error: 'not_found', message: 'Batch not found.' });
      const { retried } = await retryFailedInBatch(opts.db, opts.runner, request.params.batchId);
      return reply.code(202).send({
        retried,
        batch: await getBatchDetail(opts.db, request.params.batchId),
      });
    },
  );

  app.post<{ Params: { jobId: string } }>(
    '/admin/prompt-generation/jobs/:jobId/retry',
    adminOnly,
    async (request, reply) => {
      if (!UUID_RE.test(request.params.jobId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Job not found.' });
      }
      const outcome = await retryJob(opts.db, opts.runner, request.params.jobId);
      if (!outcome.ok) {
        const code = outcome.reason === 'not_found' ? 404 : 400;
        return reply.code(code).send({ error: outcome.reason, message: outcome.message });
      }
      return reply.code(202).send({ retried: true });
    },
  );

  /**
   * Retry ONE image. The route that makes a half-failed job recoverable
   * without touching the half that worked, and without paying xAI again when
   * the image already exists in the spool.
   */
  app.post<{ Params: { outputId: string } }>(
    '/admin/prompt-generation/outputs/:outputId/retry',
    adminOnly,
    async (request, reply) => {
      if (!UUID_RE.test(request.params.outputId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Output not found.' });
      }
      const outcome = await retryOutput(opts.db, opts.runner, request.params.outputId);
      if (!outcome.ok) {
        const code = outcome.reason === 'not_found' ? 404 : 400;
        return reply.code(code).send({ error: outcome.reason, message: outcome.message });
      }
      return reply.code(202).send({ retried: true });
    },
  );

  app.delete<{ Params: { batchId: string } }>(
    '/admin/prompt-generation/batches/:batchId',
    adminOnly,
    async (request, reply) => {
      const deleted = await deleteDraftBatch(opts.db, request.params.batchId);
      if (!deleted) {
        return reply.code(409).send({
          error: 'not_draft',
          message: 'Only a batch that has never been started can be deleted.',
        });
      }
      return { deleted: true };
    },
  );
}
