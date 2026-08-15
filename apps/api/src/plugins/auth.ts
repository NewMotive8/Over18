import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Db } from '../db/client.js';
import { getUserForToken, type SafeUser } from '../services/auth-service.js';

export const SESSION_COOKIE = 'over18_session';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth plugin when a valid session cookie is present. */
    currentUser: SafeUser | null;
  }
  interface FastifyInstance {
    /** preHandler that rejects unauthenticated requests with 401. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * preHandler that rejects non-admins with 403. Runs AFTER requireAuth and
     * reuses the same session — it is not a second authentication system, only
     * an authorization check on the user the session already resolved.
     */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Reusable authentication plugin.
 *
 * - Every request gets `request.currentUser` resolved once from the session
 *   cookie (null when absent/invalid/expired).
 * - Protected routes opt in with `{ preHandler: app.requireAuth }` and then
 *   read the user from `request.currentUser` — no auth logic is duplicated
 *   in route handlers.
 *
 * Cookie parsing is the only browser-specific part and lives here in the HTTP
 * layer; the underlying token validation (auth-service) is transport-agnostic
 * so a future React Native client can present the same token differently.
 */
export default fp(async function authPlugin(app, opts: { db: Db }) {
  app.decorateRequest('currentUser', null);

  app.addHook('preHandler', async (request) => {
    const rawToken = request.cookies[SESSION_COOKIE];
    if (rawToken) {
      request.currentUser = await getUserForToken(opts.db, rawToken);
    }
  });

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.currentUser) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Authentication required.' });
    }
  });

  app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.currentUser) {
      await reply.code(401).send({ error: 'unauthorized', message: 'Authentication required.' });
      return;
    }
    if (request.currentUser.role !== 'admin') {
      // 403, not 404: the caller is authenticated, just not permitted. Money
      // can be spent through these routes, so ordinary users are refused here
      // rather than deeper in the stack.
      await reply
        .code(403)
        .send({ error: 'forbidden', message: 'Administrator access required.' });
    }
  });
});
