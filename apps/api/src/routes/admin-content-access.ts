import type { EconomyUnavailableResponse } from '@over18/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import {
  AdminContentAccessError,
  allocateFreeClips,
  clearContentAccess,
  readCharacterContentAccess,
  setClipAccess,
} from '../services/admin-content-access-service.js';
import { CommercialBoundaryError } from '../services/commercial-boundary.js';

const ACCESS_CHANGES_UNAVAILABLE: EconomyUnavailableResponse = {
  error: 'economy_unavailable',
  reason: 'economy_disabled',
  message: 'Content access cannot be changed while the economy is switched off.',
};

/**
 * Admin -> a character's Free/Premium clips (P4.D2) -- a thin HTTP boundary
 * over `services/admin-content-access-service.ts`.
 *
 * STAFF ONLY, BY PERMISSION: `access.manage` (§32: per-asset access states and
 * Credit prices), through the existing `requirePermission`.
 *
 * READING IS ALWAYS AVAILABLE; CHANGING IS NOT. Like every other commercial
 * write, a change answers 503 while the economy is off, before anything is
 * read or written. Nothing here uploads, approves, releases or deletes
 * content: the content workflow is untouched.
 */
export default async function adminContentAccessRoutes(
  app: FastifyInstance,
  opts: { db: Db; commerce: Pick<CommerceEnv, 'enabled'> },
) {
  const read = { preHandler: app.requirePermission('access.manage') };
  // The service writes the audit record itself, inside the change's transaction.
  const change = { preHandler: app.requirePermission('access.manage'), config: { auditHandled: true } };

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AdminContentAccessError) {
      return reply.code(error.code === 'invalid_request' ? 400 : 404).send({ error: error.code, message: error.message });
    }
    if (error instanceof CommercialBoundaryError) {
      const status = error.kind === 'economy_disabled' ? 503 : error.kind === 'asset_not_found' ? 404 : 400;
      return reply.code(status).send({ error: error.kind, message: error.message });
    }
    throw error;
  };

  /** Her clips, the access each one has, and the allocation behind it. */
  app.get<{ Params: { characterId: string } }>('/admin/characters/:characterId/content-access', read, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    try {
      return await readCharacterContentAccess(opts.db, request.params.characterId, { economyEnabled: opts.commerce.enabled });
    } catch (error) {
      return failed(reply, error);
    }
  });

  /** "N of her clips should be Free": opts her in, and picks N at random. */
  app.put<{ Params: { characterId: string }; Body: { freeClipCount?: unknown; reason?: unknown } }>(
    '/admin/characters/:characterId/content-access/allocation',
    change,
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (!opts.commerce.enabled) return reply.code(503).send(ACCESS_CHANGES_UNAVAILABLE);
      try {
        return await allocateFreeClips(
          opts.db,
          opts.commerce,
          { characterId: request.params.characterId, freeClipCount: request.body?.freeClipCount, reason: request.body?.reason },
          { actor: { userId: request.currentUser!.id, email: request.currentUser!.email }, requestId: request.id },
        );
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /** One clip: Free, or Premium. */
  app.put<{ Params: { characterId: string; assetId: string }; Body: { state?: unknown; reason?: unknown } }>(
    '/admin/characters/:characterId/content-access/clips/:assetId',
    change,
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (!opts.commerce.enabled) return reply.code(503).send(ACCESS_CHANGES_UNAVAILABLE);
      try {
        return await setClipAccess(
          opts.db,
          opts.commerce,
          {
            characterId: request.params.characterId,
            assetId: request.params.assetId,
            state: request.body?.state,
            reason: request.body?.reason,
          },
          { actor: { userId: request.currentUser!.id, email: request.currentUser!.email }, requestId: request.id },
        );
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /** Take her back out: her clips read as they did before -- Free. */
  app.post<{ Params: { characterId: string }; Body: { reason?: unknown } }>(
    '/admin/characters/:characterId/content-access/clear',
    change,
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (!opts.commerce.enabled) return reply.code(503).send(ACCESS_CHANGES_UNAVAILABLE);
      try {
        return await clearContentAccess(
          opts.db,
          opts.commerce,
          { characterId: request.params.characterId, reason: request.body?.reason },
          { actor: { userId: request.currentUser!.id, email: request.currentUser!.email }, requestId: request.id },
        );
      } catch (error) {
        return failed(reply, error);
      }
    },
  );
}
