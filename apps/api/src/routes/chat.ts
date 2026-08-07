import type { FastifyInstance } from 'fastify';

/**
 * Chat routes — protected area.
 *
 * US-02 only establishes that chat requires authentication. The endpoint is a
 * placeholder; conversations/messages are implemented in a later story.
 */
export default async function chatRoutes(app: FastifyInstance) {
  app.get<{ Params: { conversationId: string } }>(
    '/api/chat/:conversationId',
    { preHandler: app.requireAuth },
    async (request) => {
      return {
        conversationId: request.params.conversationId,
        user: request.currentUser,
        message: 'Chat placeholder — conversations arrive in a later story.',
      };
    },
  );
}
