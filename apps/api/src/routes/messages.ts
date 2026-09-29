import type { FastifyInstance } from 'fastify';
import { MESSAGE_MAX_LENGTH } from '@over18/shared';
import type { Db } from '../db/client.js';
import { LlmError } from '../llm/types.js';
import type { ReplyProvider } from '../services/character-reply.js';
import type { MemoryExtractor } from '../services/memory-extractor.js';
import type { MediaSelector } from '../services/message-media-service.js';
import { listMessages, sendMessage } from '../services/message-service.js';
import {
  OpeningMessageError,
  ensureOpeningMessage,
} from '../services/conversation-opening-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `requestMedia` is the EXPLICIT, deliberate trigger for Character Media
 * Messages — the whole reason it is an API field and not a text heuristic.
 *
 * The server never guesses. It does not parse "send me a picture" out of the
 * message body, and the model is never asked whether to send media, so ordinary
 * conversation can never start attaching pictures on its own. A caller has to
 * ask, in the request, for exactly one of 'image' or 'video'.
 *
 * Omitted (the normal case, and every existing client) → text-only, unchanged.
 * The enum plus additionalProperties:false means anything else is a 400 before
 * a handler runs.
 */
const sendBodySchema = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: {
    content: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_LENGTH },
    requestMedia: { type: 'string', enum: ['image', 'video'] },
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
    /**
     * Character Media Messages selector, or null when the feature is disabled.
     * Null is the structural kill switch — see app.ts.
     */
    mediaSelector: MediaSelector | null;
    /**
     * Generates her opening line. It differs from `replyProvider` only in the
     * prompt it builds -- same client, same model, same limits.
     */
    openingProvider: ReplyProvider;
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

  /**
   * SHE OPENS THE CONVERSATION.
   *
   * POST because it writes, and idempotent by construction rather than by
   * header: the service greets only a conversation that has no messages, decided
   * under a per-conversation advisory lock. Calling it twice, from two tabs, or
   * again after a response was lost in transit all end at the same single
   * message.
   *
   * IT FAILS QUIETLY. A greeting is a courtesy, not what the visitor came for,
   * so a provider outage answers 200 with `created: false` and leaves the chat
   * completely usable -- unlike the send path, which must tell him his own
   * message did not get through. The client shows nothing and may try again.
   *
   * The one thing that is NOT quiet is somebody else's conversation: that is a
   * 404, exactly like every other read of one.
   */
  app.post<{ Params: { conversationId: string } }>(
    '/api/conversations/:conversationId/opening',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { conversationId } = request.params;
      if (!UUID_RE.test(conversationId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }
      let outcome;
      try {
        outcome = await ensureOpeningMessage(
          opts.db,
          request.currentUser!.id,
          conversationId,
          opts.openingProvider,
        );
      } catch (error) {
        /**
         * QUIET FOR THE EXPECTED FAILURE, LOUD FOR A BUG.
         *
         * `OpeningMessageError` means generation failed -- a timeout, an outage,
         * an empty completion. That is a missing courtesy, so it is swallowed.
         *
         * Anything else is rethrown, because a swallowed database error would
         * report success while writing nothing and leave no trace. It costs the
         * visitor nothing either way (the client shows no greeting in both
         * cases), so there is no reason to hide it.
         */
        if (!(error instanceof OpeningMessageError)) throw error;
        // Kind and status only -- never a provider body, prompt, or key, the
        // same discipline the send path below follows.
        const cause = error.cause;
        request.log.warn(
          {
            openingErrorKind: cause instanceof LlmError ? cause.kind : 'unexpected',
            openingErrorStatus: cause instanceof LlmError ? cause.status : undefined,
          },
          'opening message generation failed (chat unaffected)',
        );
        return { created: false, message: null };
      }
      if (outcome === null) {
        return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      }
      return {
        created: outcome.status === 'created',
        message: outcome.status === 'created' ? outcome.message : null,
      };
    },
  );

  app.post<{
    Params: { conversationId: string };
    Body: { content: string; requestMedia?: 'image' | 'video' };
  }>(
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
          {
            // Null when CHAT_MEDIA_ENABLED is off: no selector exists, so no
            // eligibility query runs and media_asset_id is never written.
            selector: opts.mediaSelector,
            requested: request.body.requestMedia ?? null,
            // Media must never break a chat exchange. Log the kind only —
            // never asset ids, storage keys, provenance or paths.
            onError: (error) => {
              request.log.warn(
                { mediaErrorKind: error instanceof Error ? error.name : 'unexpected' },
                'media selection failed (reply sent as text only)',
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
          // US-14: a timeout gets its own understandable message; every other
          // provider failure shares the generic one. Same 502 envelope either
          // way — the atomic rollback already guaranteed nothing persisted.
          return reply.code(502).send({
            error: 'ai_unavailable',
            message:
              err.kind === 'timeout'
                ? 'The character took too long to respond. Please try again.'
                : "The character couldn't respond right now. Please try again.",
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
