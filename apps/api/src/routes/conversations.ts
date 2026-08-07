import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { getConversationForUser, startConversation } from '../services/conversation-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const startBodySchema = {
  type: 'object',
  required: ['characterId'],
  additionalProperties: false,
  properties: {
    characterId: { type: 'string', minLength: 36, maxLength: 36 },
  },
} as const;

/**
 * Conversation routes (US-06). All require authentication; all data is
 * scoped to the authenticated user. Business logic lives in the service.
 */
export default async function conversationRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.post<{ Body: { characterId: string } }>(
    '/api/conversations',
    { preHandler: app.requireAuth, schema: { body: startBodySchema } },
    async (request, reply) => {
      const { characterId } = request.body;
      if (!UUID_RE.test(characterId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      const result = await startConversation(opts.db, request.currentUser!.id, characterId);
      if (!result.ok) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      // 201 when newly created, 200 when reopening the existing conversation.
      return reply.code(result.created ? 201 : 200).send(result.conversation);
    },
  );

  app.get<{ Params: { conversationId: string } }>(
    '/api/conversations/:conversationId',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { conversationId } = request.params;
      if (!UUID_RE.test(conversationId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }
      const conversation = await getConversationForUser(
        opts.db,
        request.currentUser!.id,
        conversationId,
      );
      if (!conversation) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }
      return conversation;
    },
  );
}
