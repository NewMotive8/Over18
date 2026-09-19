import type { EconomyUnavailableResponse } from '@over18/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import type { CommerceEnv } from '../env.js';
import {
  AdminWalletError,
  adjustUserWallet,
  readUserWallets,
  readUserWalletHistory,
  type SupportActor,
} from '../services/admin-wallet-service.js';
import { WalletError } from '../services/wallet-service.js';

const ADJUSTMENTS_UNAVAILABLE: EconomyUnavailableResponse = {
  error: 'economy_unavailable',
  reason: 'economy_disabled',
  message: 'Wallet adjustments are unavailable while the economy is switched off.',
};

/**
 * Admin wallet support (P2.4) -- a thin HTTP boundary over
 * `services/admin-wallet-service.ts`.
 *
 * STAFF ONLY, BY PERMISSION (§34.1): viewing needs `users.commercial.read`,
 * adjusting needs `users.credits.adjust`. `requirePermission` is always at
 * least `requireAdmin` (401 / 403), and checks the named permission once
 * enforcement is switched on -- the existing architecture, unchanged.
 *
 * READING NEVER DEPENDS ON THE ECONOMY SWITCH; ADJUSTING DOES. While
 * ECONOMY_ENABLED is off every adjustment answers 503 `economy_unavailable`
 * before anything is read or written.
 *
 * AUDITED BY THE SERVICE: the adjustment route writes its own audit record,
 * inside the adjustment's transaction, so the generic hook stands aside.
 */
export default async function adminWalletRoutes(app: FastifyInstance, opts: { db: Db; commerce: Pick<CommerceEnv, 'enabled'> }) {
  const read = { preHandler: app.requirePermission('users.commercial.read') };
  const adjust = { preHandler: app.requirePermission('users.credits.adjust'), config: { auditHandled: true } };
  const operator = (request: FastifyRequest): SupportActor => ({ userId: request.currentUser!.id, email: request.currentUser!.email });

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AdminWalletError) {
      return reply.code(error.code === 'user_not_found' ? 404 : 400).send({ error: error.code, message: error.message });
    }
    if (error instanceof WalletError) {
      return reply.code(error.code === 'invalid_request' ? 400 : 409).send({ error: error.code, message: error.message });
    }
    throw error;
  };

  /** The account, every wallet, and the operator's own adjustment limits. */
  app.get<{ Params: { userId: string } }>('/admin/users/:userId/wallets', read, async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    try {
      return await readUserWallets(opts.db, request.params.userId, operator(request), opts.commerce.enabled);
    } catch (error) {
      return failed(reply, error);
    }
  });

  /** One wallet's transactions, newest first, a page at a time. */
  app.get<{ Params: { userId: string; currency: string }; Querystring: { before?: string; limit?: string } }>(
    '/admin/users/:userId/wallets/:currency/transactions',
    read,
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      try {
        return await readUserWalletHistory(opts.db, request.params.userId, request.params.currency, request.query);
      } catch (error) {
        return failed(reply, error);
      }
    },
  );

  /** A Credit or a Debit: one new ledger transaction and its audit record, together. */
  app.post<{ Params: { userId: string; currency: string } }>(
    '/admin/users/:userId/wallets/:currency/adjustments',
    adjust,
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (!opts.commerce.enabled) return reply.code(503).send(ADJUSTMENTS_UNAVAILABLE);
      try {
        return await adjustUserWallet(opts.db, request.params.userId, request.params.currency, request.body, {
          actor: operator(request),
          requestId: request.id,
        });
      } catch (error) {
        return failed(reply, error);
      }
    },
  );
}
