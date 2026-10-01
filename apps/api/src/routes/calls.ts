import type { FastifyInstance } from 'fastify';
import { recoverCallMemories } from '../services/call-memory-service.js';
import { getConversationForUser } from '../services/conversation-service.js';
import { DEFAULT_MEMORY_MAX_STORED } from '../services/memory-service.js';
import { noopMemoryExtractor, type MemoryExtractor } from '../services/memory-extractor.js';
import type { Db } from '../db/client.js';
import {
  endCall,
  getCallSessionForUser,
  startCall,
  toPublicCallSession,
} from '../services/call-session-service.js';
import type { VoiceSessionProvider } from '../voice/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Live voice calls -- Phase 1.
 *
 * ── WHAT THESE ROUTES DELIBERATELY DO NOT RETURN ─────────────────────────────
 *
 * The provider WebSocket URL, the client secret, the compiled persona, and the
 * API key. Phase 0 established that a client connected directly to SpicyAPI
 * receives the persona back in `session.updated`, so the browser must never
 * hold the credentials that would let it connect. Phase 2's relay consumes them
 * in-process; they are never serialised.
 *
 * ── THE REQUEST BODY IS EMPTY, ON PURPOSE ────────────────────────────────────
 *
 * Character, persona, voice, model, duration, provider and user reference are
 * all resolved server-side from the conversation. There is no field a caller
 * could send that would change any of them, so none is accepted.
 *
 * ── AND NONE OF IT IS REACHABLE YET ──────────────────────────────────────────
 *
 * `VOICE_CALLS_ENABLED` is off unless set to exactly "true". Until billing and
 * the relay exist, starting a call answers 503. The gate is server-side and
 * fails closed: an unset variable is a disabled feature.
 */
export default async function callRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    provider: VoiceSessionProvider;
    /** env.voiceCalls.enabled && a provider is configured. */
    enabled: boolean;
    maxSeconds: number;
    /** Same extractor as the relay and the text path. Defaults to extracting nothing. */
    memoryExtractor?: MemoryExtractor;
    memoryMaxStored?: number;
  },
) {
  /** Start a call for a conversation the caller owns. */
  app.post<{ Params: { conversationId: string } }>(
    '/api/conversations/:conversationId/call',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { conversationId } = request.params;
      if (!UUID_RE.test(conversationId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }

      const result = await startCall(opts.db, request.currentUser!.id, conversationId, {
        provider: opts.provider,
        enabled: opts.enabled,
        maxSeconds: opts.maxSeconds,
      });

      if (result.ok) {
        /**
         * RECOVERY, RIDING ON A TRIGGER THAT ALREADY EXISTS.
         *
         * Extraction normally happens when a call ends. It can fail, or the
         * process can be restarted mid-flight, and nothing revisits those calls
         * -- so a handful of this person's own unprocessed calls are retried
         * here, at the one moment we know they are about to talk to this
         * character again. No scheduler, no queue, no new moving part.
         *
         * NOT AWAITED, and that is load-bearing: this is up to three LLM round
         * trips and the caller is waiting to connect a call. The response goes
         * out first and the retries happen behind it. The `.catch` is belt to
         * `recoverCallMemories`'s own braces -- it does not throw, and this does
         * not rely on that staying true.
         *
         * Bounded to RECOVERY_BATCH_LIMIT rows, scoped to this (user, character),
         * and it cannot touch the call just started: only settled rows are
         * eligible, and this one is `pending`.
         */
        void (async () => {
          // The character is resolved in here rather than above, so the extra
          // read costs the waiting caller nothing. `PublicCallSession` does not
          // carry a character id, and widening the wire shape for this would be
          // the wrong trade.
          const conversation = await getConversationForUser(
            opts.db,
            request.currentUser!.id,
            conversationId,
          );
          if (!conversation) return;
          await recoverCallMemories(
            opts.db,
            request.currentUser!.id,
            conversation.character.id,
            {
              extractor: opts.memoryExtractor ?? noopMemoryExtractor,
              maxStored: opts.memoryMaxStored ?? DEFAULT_MEMORY_MAX_STORED,
            },
            request.log,
          );
        })().catch(() => {
          /* already logged inside; the caller has a call to make */
        });

        // `result.credentials` is deliberately NOT spread into this response.
        return reply.code(201).send({ callSession: result.session });
      }

      switch (result.reason) {
        case 'not_found':
          return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });

        case 'unavailable':
          return reply.code(503).send({
            error: 'voice_unavailable',
            message: 'Voice calls are not available yet.',
          });

        case 'user_busy':
          /**
           * Already on a call somewhere else. 409 like the per-conversation
           * case, but a distinct code, because the remedy differs: the caller
           * must finish the other call, not resume this one. No id is returned
           * -- it belongs to a different conversation, and naming it here would
           * say more about the account than this endpoint needs to.
           */
          return reply.code(409).send({
            error: 'user_call_already_active',
            message: 'You are already on a call. End it before starting another.',
          });

        case 'already_active':
          // 409, and the id, so a client that lost its response can resume
          // rather than being told to start something it already has.
          return reply.code(409).send({
            error: 'call_already_active',
            message: 'A call is already in progress for this conversation.',
            callSessionId: result.callSessionId,
          });

        case 'provider_error':
          // Kind only. Never a provider body -- the request carried the persona.
          request.log.warn({ voiceErrorKind: result.kind }, 'voice session creation failed');
          return reply.code(502).send({
            error: 'voice_unavailable',
            message: "The call couldn't be started right now. Please try again.",
          });
      }
    },
  );

  /** One of the caller's own call sessions. */
  app.get<{ Params: { callSessionId: string } }>(
    '/api/calls/:callSessionId',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { callSessionId } = request.params;
      if (!UUID_RE.test(callSessionId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Call session not found.' });
      }
      const row = await getCallSessionForUser(opts.db, request.currentUser!.id, callSessionId);
      if (!row) {
        // Another user's session reads exactly like one that does not exist.
        return reply.code(404).send({ error: 'not_found', message: 'Call session not found.' });
      }
      return { callSession: toPublicCallSession(row) };
    },
  );

  /**
   * End one of the caller's own call sessions.
   *
   * Idempotent: an already-ended session answers 200 with the settled record,
   * because a retry after a lost response must not look like a failure.
   */
  app.post<{ Params: { callSessionId: string } }>(
    '/api/calls/:callSessionId/end',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { callSessionId } = request.params;
      if (!UUID_RE.test(callSessionId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Call session not found.' });
      }
      const outcome = await endCall(opts.db, request.currentUser!.id, callSessionId);
      if (outcome.status === 'not_found') {
        return reply.code(404).send({ error: 'not_found', message: 'Call session not found.' });
      }
      return { callSession: outcome.session, alreadyEnded: outcome.status === 'already_ended' };
    },
  );
}
