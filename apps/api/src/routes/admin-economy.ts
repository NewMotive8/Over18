import type { PackDraftInput, PlanDraftInput, RulesetDraftInput } from '@over18/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import {
  EconomyAdminError,
  cancelScheduledVersion,
  discardPackDraft,
  discardPlanDraft,
  discardRulesetDraft,
  publishDrafts,
  readEconomyConfiguration,
  reviewPublish,
  savePackDraft,
  savePlanDraft,
  saveRulesetDraft,
  type EconomyChangeContext,
  type EconomyKind,
} from '../services/economy-admin-service.js';
import { parsePreviewInputs, previewEconomy } from '../services/economy-preview.js';

/**
 * Admin -> Economy (PRD v1.2 §31): the preview (P1.3) and the configuration
 * workflow (P1) -- drafts, review, publish, cancel.
 *
 * EVERY ROUTE REQUIRES `economy.manage`, the one economy permission: viewing,
 * editing, previewing and publishing alike. While permission enforcement is
 * off, `requirePermission` falls back to "is an admin", exactly as every other
 * admin route does.
 *
 * WRITES AUDIT THEMSELVES. The service records actor, before, after and reason
 * inside the change's own transaction, so these routes are `auditHandled` and
 * the generic hook does not log them a second time.
 *
 * NOTHING HERE IS CUSTOMER-FACING, AND NOTHING SWITCHES THE ECONOMY ON. A
 * published configuration is what the resolver serves; whether any customer
 * sees it is ECONOMY_ENABLED, which nothing here touches.
 */

const reason = { type: ['string', 'null'], maxLength: 500 } as const;

const planDraftSchema = {
  body: {
    type: 'object',
    required: ['displayName', 'billingPeriodMonths', 'priceMinor', 'currency', 'monthlyIncludedCredits', 'features', 'isPurchasable'],
    additionalProperties: false,
    properties: {
      displayName: { type: 'string', maxLength: 120 },
      billingPeriodMonths: { type: 'integer' },
      priceMinor: { type: 'integer' },
      currency: { type: 'string', maxLength: 3 },
      monthlyIncludedCredits: { type: 'integer' },
      features: { type: 'object', maxProperties: 50, additionalProperties: { type: 'boolean' } },
      isPurchasable: { type: 'boolean' },
      reason,
    },
  },
} as const;

const packDraftSchema = {
  body: {
    type: 'object',
    required: ['displayName', 'credits', 'priceMinor', 'currency', 'sortOrder', 'isBestValue', 'isPurchasable'],
    additionalProperties: false,
    properties: {
      displayName: { type: 'string', maxLength: 120 },
      credits: { type: 'integer' },
      priceMinor: { type: 'integer' },
      currency: { type: 'string', maxLength: 3 },
      sortOrder: { type: 'integer' },
      isBestValue: { type: 'boolean' },
      isPurchasable: { type: 'boolean' },
      reason,
    },
  },
} as const;

const rulesetDraftSchema = {
  body: {
    type: 'object',
    required: ['actionCosts', 'allowances', 'rewards'],
    additionalProperties: false,
    properties: {
      actionCosts: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          required: ['actionType', 'qualityTier', 'maxDurationSeconds', 'unit', 'creditCost', 'enabled'],
          additionalProperties: false,
          properties: {
            actionType: { type: 'string', maxLength: 64 },
            qualityTier: { type: 'string', maxLength: 64 },
            maxDurationSeconds: { type: ['integer', 'null'] },
            unit: { type: 'string', enum: ['per_action', 'per_minute'] },
            creditCost: { type: 'integer' },
            enabled: { type: 'boolean' },
          },
        },
      },
      allowances: { type: 'object', maxProperties: 50, additionalProperties: { type: 'integer' } },
      rewards: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          required: ['rewardKey', 'credits', 'perUserCap', 'enabled'],
          additionalProperties: false,
          properties: {
            rewardKey: { type: 'string', maxLength: 64 },
            credits: { type: 'integer' },
            perUserCap: { type: ['integer', 'null'] },
            enabled: { type: 'boolean' },
          },
        },
      },
      reason,
    },
  },
} as const;

const publishSchema = {
  body: {
    type: 'object',
    required: ['reason', 'draftSetToken'],
    additionalProperties: false,
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 500 },
      effectiveFrom: { type: ['string', 'null'], maxLength: 64 },
      draftSetToken: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    },
  },
} as const;

const cancelSchema = {
  body: {
    type: 'object',
    required: ['reason'],
    additionalProperties: false,
    properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
  },
} as const;

const KINDS: readonly EconomyKind[] = ['plan', 'pack', 'ruleset'];

export default async function adminEconomyRoutes(app: FastifyInstance, opts: { db: Db }) {
  const guard = app.requirePermission('economy.manage');
  const write = { preHandler: guard, config: { auditHandled: true } };

  /** A discard may carry an optional `{ reason }` body; anything else there is ignored. */
  const context = (request: FastifyRequest, body: unknown): EconomyChangeContext => {
    const given = body && typeof body === 'object' ? (body as { reason?: unknown }).reason : null;
    return {
      actor: { userId: request.currentUser!.id, email: request.currentUser!.email },
      reason: typeof given === 'string' ? given.slice(0, 500) : null,
      requestId: request.id,
    };
  };

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof EconomyAdminError) {
      const status =
        error.code === 'not_found' ? 404 : error.code === 'invalid_configuration' ? 400 : 409;
      return reply.code(status).send({ error: error.code, message: error.message, messages: error.messages });
    }
    throw error;
  };

  /**
   * P1.3 -- the preview. READ-ONLY: a POST only because its inputs (provider
   * costs, the margin floors) are structured data that does not belong in a
   * URL. It publishes, schedules and stores nothing. With ADMIN_AUDIT_ENABLED
   * on, the generic hook records the call -- who ran a preview, never a change.
   */
  app.post('/admin/economy/preview', { preHandler: guard }, async (request, reply) => {
    const parsed = parsePreviewInputs(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'invalid_preview_input', messages: parsed.errors });
    }
    return previewEconomy(opts.db, parsed.value);
  });

  /** Every plan, pack and ruleset version with its state, and the key catalogue. */
  app.get('/admin/economy/configuration', { preHandler: guard }, async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return readEconomyConfiguration(opts.db);
  });

  /* ---------------- drafts ---------------- */

  app.put<{ Params: { code: string }; Body: PlanDraftInput & { reason?: string | null } }>(
    '/admin/economy/plans/:code/draft',
    { ...write, schema: planDraftSchema },
    async (request, reply) => {
      const { reason: _reason, ...input } = request.body;
      try {
        return await savePlanDraft(opts.db, request.params.code, input, context(request, request.body));
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.delete<{ Params: { code: string } }>(
    '/admin/economy/plans/:code/draft',
    write,
    async (request, reply) => {
      try {
        await discardPlanDraft(opts.db, request.params.code, context(request, request.body));
        return reply.code(204).send();
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.put<{ Params: { code: string }; Body: PackDraftInput & { reason?: string | null } }>(
    '/admin/economy/packs/:code/draft',
    { ...write, schema: packDraftSchema },
    async (request, reply) => {
      const { reason: _reason, ...input } = request.body;
      try {
        return await savePackDraft(opts.db, request.params.code, input, context(request, request.body));
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.delete<{ Params: { code: string } }>(
    '/admin/economy/packs/:code/draft',
    write,
    async (request, reply) => {
      try {
        await discardPackDraft(opts.db, request.params.code, context(request, request.body));
        return reply.code(204).send();
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.put<{ Body: RulesetDraftInput & { reason?: string | null } }>(
    '/admin/economy/ruleset/draft',
    { ...write, schema: rulesetDraftSchema },
    async (request, reply) => {
      const { reason: _reason, ...input } = request.body;
      try {
        return await saveRulesetDraft(opts.db, input, context(request, request.body));
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  app.delete('/admin/economy/ruleset/draft', write, async (request, reply) => {
    try {
      await discardRulesetDraft(opts.db, context(request, request.body));
      return reply.code(204).send();
    } catch (error) {
      return failed(reply, error);
    }
  });

  /* ---------------- review, publish, cancel ---------------- */

  /** The old -> new diff of every open draft, with blocking errors and warnings. Read-only. */
  app.get('/admin/economy/publish/review', { preHandler: guard }, async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return reviewPublish(opts.db);
  });

  /** Publishes every open draft together -- only the drafts that review described. */
  app.post<{ Body: { reason: string; effectiveFrom?: string | null; draftSetToken: string } }>(
    '/admin/economy/publish',
    { ...write, schema: publishSchema },
    async (request, reply) => {
      try {
        return await publishDrafts(
          opts.db,
          { reason: request.body.reason, effectiveFrom: request.body.effectiveFrom ?? null, draftSetToken: request.body.draftSetToken },
          context(request, request.body),
        );
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /** Cancels a published version that has not yet taken effect. */
  app.post<{ Params: { kind: string; versionId: string }; Body: { reason: string } }>(
    '/admin/economy/versions/:kind/:versionId/cancel',
    { ...write, schema: cancelSchema },
    async (request, reply) => {
      if (!(KINDS as readonly string[]).includes(request.params.kind)) {
        return reply.code(404).send({ error: 'not_found', message: 'Unknown configuration kind.' });
      }
      try {
        await cancelScheduledVersion(opts.db, request.params.kind as EconomyKind, request.params.versionId, request.body, context(request, request.body));
        return reply.code(204).send();
      } catch (error) {
        return failed(reply, error);
      }
    },
  );
}
