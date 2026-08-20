import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import {
  ContentRequirementInUseError,
  ContentRequirementKeyTakenError,
  ContentRequirementValidationError,
  countAssetsForRequirementKey,
  createContentRequirement,
  deleteContentRequirement,
  getContentRequirement,
  listContentRequirements,
  updateContentRequirement,
  type ContentRequirement,
} from '../services/content-requirements-service.js';
import { summariseRequirementProgress } from '../services/requirement-status-service.js';

/**
 * Admin → Settings → Content Requirements.
 *
 * The configuration surface for the ONE definition of what a character needs.
 * Every route is `requireAuth` + `requireAdmin`, like the rest of the admin API.
 *
 * These routes only ever touch `content_requirements`. Editing a requirement
 * cannot, by construction, read or write a single asset row — which is what
 * makes "changing the configuration never deletes or regenerates content" a
 * property of the code rather than a promise in a comment.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function adminSettingsRoutes(app: FastifyInstance, opts: { db: Db }) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'not_found', message: 'Requirement not found.' });

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ContentRequirementValidationError) {
      return reply
        .code(400)
        .send({ error: 'invalid_requirement', field: error.field, message: error.message });
    }
    if (error instanceof ContentRequirementKeyTakenError) {
      return reply.code(409).send({ error: 'key_taken', message: error.message });
    }
    throw error;
  };

  /**
   * The whole configuration, plus how many items are already filed under each
   * key. The count is what lets Settings say "disable, don't delete" honestly
   * instead of offering a destructive action and failing afterwards.
   */
  app.get('/admin/settings/content-requirements', adminOnly, async () => {
    const requirements = await listContentRequirements(opts.db);
    const withUsage = await Promise.all(
      requirements.map(async (requirement) => ({
        ...requirement,
        assignedAssetCount: await countAssetsForRequirementKey(opts.db, requirement.key),
      })),
    );
    // The board totals every character is measured against, computed from the
    // same rows — so Settings can state the consequence of an edit.
    const enabled = requirements.filter((r) => r.enabled);
    return {
      requirements: withUsage,
      totals: {
        items: enabled.reduce((n, r) => n + r.requiredQuantity, 0),
        images: sumFor(enabled, 'image'),
        videos: sumFor(enabled, 'video'),
      },
    };
  });

  /**
   * What the current configuration means for every character, right now.
   *
   * Settings shows this so an operator can see the effect of a change on real
   * characters before and after saving, rather than discovering it in Review.
   */
  app.get('/admin/settings/content-requirements/impact', adminOnly, async () => {
    return { characters: await summariseRequirementProgress(opts.db) };
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/admin/settings/content-requirements',
    adminOnly,
    async (request, reply) => {
      try {
        const created = await createContentRequirement(opts.db, request.body as never);
        return reply.code(201).send(created);
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.patch<{ Params: { requirementId: string }; Body: Record<string, unknown> }>(
    '/admin/settings/content-requirements/:requirementId',
    adminOnly,
    async (request, reply) => {
      const { requirementId } = request.params;
      if (!UUID_RE.test(requirementId)) return notFound(reply);
      // `key` is the value already written onto assets: renaming it would
      // orphan content, so it is refused rather than silently ignored.
      if ('key' in (request.body ?? {})) {
        return reply.code(400).send({
          error: 'immutable_field',
          message:
            'A requirement key cannot change — content is already filed under it. Rename the label instead.',
        });
      }
      try {
        const updated = await updateContentRequirement(opts.db, requirementId, request.body as never);
        return updated ?? notFound(reply);
      } catch (error) {
        if (error instanceof ContentRequirementInUseError) {
          return reply.code(409).send({
            error: 'requirement_in_use',
            message: error.message,
            assignedAssetCount: error.assetCount,
          });
        }
        return failed(reply, error);
      }
    },
  );

  /**
   * Deletes a requirement NOTHING is filed under. Anything else is refused with
   * the count and a pointer to disabling, which retires it without touching a
   * single asset.
   */
  app.delete<{ Params: { requirementId: string } }>(
    '/admin/settings/content-requirements/:requirementId',
    adminOnly,
    async (request, reply) => {
      const { requirementId } = request.params;
      if (!UUID_RE.test(requirementId)) return notFound(reply);
      if (!(await getContentRequirement(opts.db, requirementId))) return notFound(reply);
      try {
        await deleteContentRequirement(opts.db, requirementId);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof ContentRequirementInUseError) {
          return reply.code(409).send({
            error: 'requirement_in_use',
            message: error.message,
            assignedAssetCount: error.assetCount,
          });
        }
        throw error;
      }
    },
  );
}

function sumFor(requirements: readonly ContentRequirement[], mediaType: 'image' | 'video'): number {
  return requirements
    .filter((r) => r.mediaType === mediaType)
    .reduce((n, r) => n + r.requiredQuantity, 0);
}
