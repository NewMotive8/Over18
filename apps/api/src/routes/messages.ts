import type { FastifyInstance } from 'fastify';
import { MESSAGE_MAX_LENGTH } from '@over18/shared';
import type { Db } from '../db/client.js';
import { LlmError } from '../llm/types.js';
import type { ReplyProvider } from '../services/character-reply.js';
import type { MemoryExtractor } from '../services/memory-extractor.js';
import { listMessages, sendMessage } from '../services/message-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sendBodySchema = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: {
    content: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_LENGTH },
  },
} as const;

/**
 * Message routes (US-07). Auth required; ownership enforced in the service
 * (foreign/unknown conversations read as 404). Handlers stay thin.
 */
export default async function messageRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    replyProvider: ReplyProvider;
    /** US-12 memory hook (extractor + storage cap). */
    memoryExtractor: MemoryExtractor;
    memoryMaxStored: number;
  },
) {
  app.get<{ Params: { conversationId: string } }>(
    '/api/conversations/:conversationId/messages',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { conversationId } = request.params;
      if (!UUID_RE.test(conversationId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }
      const history = await listMessages(opts.db, request.currentUser!.id, conversationId);
      if (history === null) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }
      return history;
    },
  );

  app.post<{ Params: { conversationId: string }; Body: { content: string } }>(
    '/api/conversations/:conversationId/messages',
    { preHandler: app.requireAuth, schema: { body: sendBodySchema } },
    async (request, reply) => {
      const { conversationId } = request.params;
      if (!UUID_RE.test(conversationId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }
      const content = request.body.content.trim();
      if (content.length === 0) {
        return reply
          .code(400)
          .send({ error: 'empty_message', message: 'Message cannot be empty.' });
      }
      let result;
      try {
        result = await sendMessage(
          opts.db,
          request.currentUser!.id,
          conversationId,
          content,
          opts.replyProvider,
          {
            extractor: opts.memoryExtractor,
            maxStored: opts.memoryMaxStored,
            // Memory failures never fail the request; log kind/status only —
            // never message content, facts, prompts, or provider bodies.
            onError: (error) => {
              request.log.warn(
                {
                  memoryErrorKind: error instanceof LlmError ? error.kind : 'unexpected',
                  memoryErrorStatus: error instanceof LlmError ? error.status : undefined,
                },
                'memory extraction failed (chat exchange unaffected)',
              );
            },
          },
        );
      } catch (err) {
        if (err instanceof LlmError) {
          // The transaction already rolled back — nothing was persisted.
          // Log kind/status only; never prompts, keys, or provider bodies.
          request.log.warn({ llmErrorKind: err.kind, llmStatus: err.status }, 'AI generation failed');
          if (err.kind === 'not_configured') {
            return reply.code(503).send({
              error: 'ai_not_configured',
              message: 'AI is not configured for this environment yet. Please try again later.',
            });
          }
          return reply.code(502).send({
            error: 'ai_unavailable',
            message: "The character couldn't respond right now. Please try again.",
          });
        }
        throw err;
      }
      if (result === null) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }
      return reply.code(201).send(result);
    },
  );
}
