import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import {
  getAuthorisedMessageMedia,
  resolveMediaFile,
} from '../services/message-media-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Character Media Messages — the serving route (commit 1).
 *
 * GET /api/conversations/:conversationId/messages/:messageId/media
 *
 * The FIRST user-facing media route in the app. Everything that serves bytes
 * today is either admin-gated (/admin/content/uploads/:assetId/file) or behind
 * the internal shared secret (/internal/media/assets/:assetId); neither is
 * reachable by an ordinary chat user, and widening either one would have
 * exposed the whole Library by asset id.
 *
 * So this route takes NO asset id. It is addressed by a message the caller
 * already knows about, and the asset is reached only THROUGH that message:
 *
 *   caller owns conversation  AND  message is in that conversation
 *                             AND  message references an asset
 *
 * all enforced in a single query (getAuthorisedMessageMedia). That is also what
 * satisfies the explicit-content rule without a rating check here: an
 * `explicit` asset is unreachable unless it was genuinely attached to one of
 * the caller's own messages, because there is no other way to name it.
 *
 * Every failure — unauthenticated aside — is the SAME 404. Wrong owner,
 * unknown conversation, message belonging to a different conversation, message
 * with no media, asset row present but file gone: all indistinguishable from
 * the outside, matching getConversationForUser's no-existence-leaks rule.
 *
 * INERT IN THIS COMMIT: nothing writes messages.media_asset_id yet, so in
 * production today this route can only ever return 404.
 */
export default async function conversationMediaRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    /** MEDIA_STORAGE_DIR. Every resolved path must live inside it. */
    storageDir: string;
  },
) {
  app.get<{ Params: { conversationId: string; messageId: string } }>(
    '/api/conversations/:conversationId/messages/:messageId/media',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const notFound = () =>
        reply.code(404).send({ error: 'not_found', message: 'Media not found.' });

      const { conversationId, messageId } = request.params;
      if (!UUID_RE.test(conversationId) || !UUID_RE.test(messageId)) {
        return notFound();
      }

      const asset = await getAuthorisedMessageMedia(
        opts.db,
        request.currentUser!.id,
        conversationId,
        messageId,
      );
      if (!asset) return notFound();

      const resolved = resolveMediaFile(asset, opts.storageDir);
      if ('failure' in resolved) {
        // A path outside MEDIA_STORAGE_DIR is a data-integrity problem, not a
        // client error: log the KIND only (never the path, key or provenance)
        // and answer with the same opaque 404 as everything else.
        if (resolved.failure === 'outside_storage_root') {
          request.log.warn(
            { mediaResolution: resolved.failure },
            'refused to serve message media resolving outside MEDIA_STORAGE_DIR',
          );
        }
        return notFound();
      }

      // Existence is checked before opening the stream so a row orphaned by an
      // ephemeral-disk redeploy is a clean 404 rather than a stream that errors
      // mid-flight after the headers have gone out (which would be a 500).
      const exists = await stat(resolved.path).then(
        (s) => s.isFile(),
        () => false,
      );
      if (!exists) return notFound();

      reply.header('content-type', resolved.contentType);
      // Private: this is one user's chat content, never shared or CDN-cached.
      reply.header('cache-control', 'private, max-age=60');
      return reply.send(createReadStream(resolved.path));
    },
  );
}
