import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { SESSION_COOKIE } from '../plugins/auth.js';
import {
  createSession,
  deleteSessionByToken,
  registerUser,
  verifyCredentials,
} from '../services/auth-service.js';

const credentialsBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 254 },
    password: { type: 'string', minLength: 8, maxLength: 72 },
  },
} as const;

interface CredentialsBody {
  email: string;
  password: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function authRoutes(app: FastifyInstance, opts: { db: Db; env: Env }) {
  const { db, env } = opts;

  function setSessionCookie(reply: FastifyReply, rawToken: string, expiresAt: Date) {
    reply.setCookie(SESSION_COOKIE, rawToken, {
      httpOnly: true,
      secure: env.cookieSecure,
      sameSite: env.cookieSameSite,
      path: '/',
      expires: expiresAt,
      maxAge: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    });
  }

  function clearSessionCookie(reply: FastifyReply) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  app.post<{ Body: CredentialsBody }>(
    '/api/auth/register',
    { schema: { body: credentialsBodySchema } },
    async (request, reply) => {
      const { email, password } = request.body;
      if (!EMAIL_RE.test(email.trim())) {
        return reply.code(400).send({ error: 'invalid_email', message: 'Please enter a valid email address.' });
      }
      const result = await registerUser(db, email, password);
      if (!result.ok) {
        return reply
          .code(409)
          .send({ error: 'email_taken', message: 'An account with this email already exists.' });
      }
      const { rawToken, expiresAt } = await createSession(db, result.user.id, env.sessionTtlDays);
      setSessionCookie(reply, rawToken, expiresAt);
      return reply.code(201).send(result.user);
    },
  );

  app.post<{ Body: CredentialsBody }>(
    '/api/auth/login',
    { schema: { body: credentialsBodySchema } },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = await verifyCredentials(db, email, password);
      if (!user) {
        // Deliberately generic: does not reveal whether the email exists.
        return reply
          .code(401)
          .send({ error: 'invalid_credentials', message: 'Invalid email or password.' });
      }
      const { rawToken, expiresAt } = await createSession(db, user.id, env.sessionTtlDays);
      setSessionCookie(reply, rawToken, expiresAt);
      return reply.send(user);
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const rawToken = request.cookies[SESSION_COOKIE];
    if (rawToken) {
      await deleteSessionByToken(db, rawToken);
    }
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Authentication required.' });
    }
    return reply.send(request.currentUser);
  });
}
