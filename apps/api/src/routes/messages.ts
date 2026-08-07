import type { FastifyInstance } from 'fastify';
import { MESSAGE_MAX_LENGTH } from '@over18/shared';
import type { Db } from '../db/client.js';
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
export default async function messageRoutes(app: FastifyInstance, opts: { db: Db }) {
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
      const result = await sendMessage(opts.db, request.currentUser!.id, conversationId, content);
      if (result === null) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }
      return reply.code(201).send(result);
    },
  );
}
