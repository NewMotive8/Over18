import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { CostLedger } from '../media-pipeline/cost-ledger.js';
import type { MediaProviders } from '../media-pipeline/types.js';
import type { MediaStorageConfig } from '../services/media-generation-service.js';
import { modelIdForProviders } from '../services/media-providers.js';
import type { GenerationConfiguration } from '../generation/config.js';
import {
  enqueueGenerationJob,
  getGenerationJob,
  retryGenerationResult,
} from '../generation/jobs.js';
import { listResults } from '../generation/results.js';
import { getSequenceRun, runSequence } from '../generation/sequence-runner.js';

/**
 * US-103 — admin generation API. The HTTP surface US-104's Generation Studio
 * will consume.
 *
 * Authorization is enforced HERE, at the boundary: `requireAuth` then
 * `requireAdmin`, both from the existing session auth plugin. The generation
 * service below stays completely auth-unaware, so nothing about permissions
 * leaks into domain code.
 *
 * The contract is asynchronous by design: POST persists a queued job and
 * returns its id immediately (202), and GET reports progress. A ten-video job
 * must never hold an HTTP request open for its whole duration.
 */
export default async function generationRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    providers: MediaProviders;
    storage: MediaStorageConfig;
    ledgerPath: string;
    characterBudgetUsd?: number;
  },
) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };

  const deps = () => ({
    providers: opts.providers,
    ledger: new CostLedger(opts.ledgerPath),
    storage: opts.storage,
    characterBudgetUsd: opts.characterBudgetUsd,
  });

  const jobView = async (jobId: string) => {
    const job = await getGenerationJob(opts.db, jobId);
    if (!job) return null;
    const results = await listResults(opts.db, jobId);
    return {
      jobId: job.id,
      status: job.status,
      type: job.type,
      characterId: job.characterId,
      visualIdentityId: job.visualIdentityId,
      provider: job.provider,
      model: job.model,
      progress: {
        requested: job.requestedQuantity,
        succeeded: job.succeededCount,
        failed: job.failedCount,
      },
      estimatedCostUsd: job.estimatedCostUsd,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      // Each result is independently addressable — this is what US-104 renders
      // as a tile with its own retry action.
      results: results.map((r) => ({
        resultId: r.id,
        ordinal: r.ordinal,
        status: r.status,
        assetId: r.assetId,
        attempts: r.attempts,
        error: r.error,
      })),
    };
  };

  /** Create a generation job. Returns immediately; execution is in background. */
  app.post<{ Body: GenerationConfiguration & { idempotencyKey?: string } }>(
    '/admin/generation/jobs',
    adminOnly,
    async (request, reply) => {
      const { idempotencyKey, ...config } = request.body ?? ({} as never);
      const type = (config as GenerationConfiguration)?.type;
      if (type !== 'image' && type !== 'video') {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: 'type must be "image" or "video".' });
      }

      const enqueued = await enqueueGenerationJob(
        opts.db,
        deps(),
        config as GenerationConfiguration,
        {
          idempotencyKey,
          defaultModelId: modelIdForProviders(type, opts.providers),
        },
      );

      if (!enqueued.ok) {
        // Structured validation errors so the Studio can point at a field.
        return reply.code(400).send({ error: 'invalid_configuration', details: enqueued.errors });
      }
      return reply.code(202).send(await jobView(enqueued.value.id));
    },
  );

  /** Poll a job: status, progress and per-result state. */
  app.get<{ Params: { jobId: string } }>(
    '/admin/generation/jobs/:jobId',
    adminOnly,
    async (request, reply) => {
      const view = await jobView(request.params.jobId);
      if (!view) return reply.code(404).send({ error: 'not_found', message: 'Job not found.' });
      return reply.send(view);
    },
  );

  /** Retry ONE result. Successful results are never regenerated. */
  app.post<{ Params: { resultId: string } }>(
    '/admin/generation/results/:resultId/retry',
    adminOnly,
    async (request, reply) => {
      const retried = await retryGenerationResult(opts.db, deps(), request.params.resultId);
      if (!retried.ok) {
        return reply.code(400).send({ error: 'retry_refused', details: retried.errors });
      }
      return reply.send({
        resultId: retried.value.result.id,
        ordinal: retried.value.result.ordinal,
        status: retried.value.result.status,
        assetId: retried.value.result.assetId,
      });
    },
  );

  /** Run a saved sequence for a character. */
  app.post<{ Params: { sequenceId: string }; Body: { characterId: string } }>(
    '/admin/generation/sequences/:sequenceId/run',
    adminOnly,
    async (request, reply) => {
      const characterId = request.body?.characterId;
      if (!characterId) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: 'characterId is required.' });
      }
      const result = await runSequence(opts.db, deps(), {
        sequenceId: request.params.sequenceId,
        characterId,
      });
      if (!result.ok) {
        return reply.code(400).send({ error: 'invalid_sequence', details: result.errors });
      }
      return reply.code(202).send({
        runId: result.value.run.id,
        status: result.value.run.status,
        totalSteps: result.value.run.totalSteps,
        steps: result.value.steps.map((s) => ({
          ordinal: s.ordinal,
          status: s.status,
          reason: s.reason,
          jobIds: s.jobs.map((j) => j.id),
          assetCount: s.assets.length,
        })),
      });
    },
  );

  app.get<{ Params: { runId: string } }>(
    '/admin/generation/sequence-runs/:runId',
    adminOnly,
    async (request, reply) => {
      const run = await getSequenceRun(opts.db, request.params.runId);
      if (!run) return reply.code(404).send({ error: 'not_found', message: 'Run not found.' });
      return reply.send({
        runId: run.id,
        sequenceId: run.sequenceId,
        characterId: run.characterId,
        status: run.status,
        totalSteps: run.totalSteps,
        completedSteps: run.completedSteps,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      });
    },
  );
}
