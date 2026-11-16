import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  MY_AI_REFERENCE_PHOTO_ID,
  myAiDraftProblems,
  myAiMessageProblem,
  myAiPhotoProblems,
  type MyAiDraft,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import type { MyAiEnv } from '../env.js';
import type { ReplyProvider } from '../services/character-reply.js';
import { isInsideStorageRoot } from '../services/message-media-service.js';
import {
  listMessages,
  sendMessage,
  toMessageWire,
} from '../services/my-ai/my-ai-chat.js';
import {
  countGenerating,
  createPhoto,
  deletePhoto,
  getPhoto,
  listPhotos,
  referencePhoto,
  runPhotoGeneration,
  toPhotoWire,
} from '../services/my-ai/my-ai-photos.js';
import {
  createCompanion,
  deleteCompanion,
  deletePortrait,
  getCompanion,
  listCompanions,
  runGeneration,
  toWire,
} from '../services/my-ai/my-ai-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * My AI — the companions a user builds for themselves.
 *
 * ── EVERY ROUTE IS AUTHENTICATED AND EVERY ROUTE IS OWNER-SCOPED ────────────
 *
 * There is no public read here and no `userId` parameter anywhere. The owner
 * is `request.currentUser`, resolved by the auth plugin, which is the only
 * place it ever comes from — so no path, body or query can address another
 * account's companion. Asking for one that is not yours and asking for one
 * that does not exist both answer 404, because distinguishing them would
 * confirm the existence of someone else's.
 *
 * This is a separate plugin from `public-home.ts` for the same reason
 * Favourites is: that file is the deliberately account-free public surface,
 * and keeping these apart means no later edit can make a companion readable
 * by leaving a condition out.
 */
export default async function myAiRoutes(
  app: FastifyInstance,
  opts: { db: Db; myAi: MyAiEnv | null; storageDir: string; replyProvider: ReplyProvider },
) {
  const { db, storageDir } = opts;

  /** Everything this user has made, newest first. */
  app.get('/api/my-ai', { preHandler: app.requireAuth }, async (request) => {
    const rows = await listCompanions(db, request.currentUser!.id);
    return { companions: rows.map(toWire) };
  });

  /**
   * Create one.
   *
   * Returns as soon as the row exists, with `status: 'generating'` — rendering
   * takes the provider the better part of a minute and holding an HTTP request
   * open that long is how you collect gateway timeouts. The client polls.
   */
  app.post<{ Body: Partial<MyAiDraft> }>(
    '/api/my-ai',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      /*
       * THE SAME VALIDATOR THE WIZARD'S BUTTON USES. One implementation in
       * @over18/shared means the enabled Create button and the accepted
       * request cannot disagree about what a complete companion is — and a
       * hand-rolled POST gets exactly the same treatment as the UI.
       *
       * BEFORE the availability check on purpose: a malformed request is
       * malformed whether or not this environment has a provider, so the
       * route's contract does not change with deployment state — and the
       * validation stays testable where no provider is configured, which is
       * every test environment.
       */
      const problems = myAiDraftProblems(request.body ?? {});
      if (problems.length > 0) {
        return reply.code(400).send({
          error: 'invalid_draft',
          message: 'Some of her details are missing or not recognised.',
          fields: problems,
        });
      }

      if (!opts.myAi) {
        /*
         * No provider key in this environment. A plain, honest answer rather
         * than a 500: the feature is not available here, which is the literal
         * truth and is actionable by whoever deploys it.
         */
        return reply.code(503).send({
          error: 'my_ai_unavailable',
          message: 'Creating a companion is not available here yet.',
        });
      }

      /*
       * ONE AT A TIME. Each generation costs real money at the provider, and
       * without this a user can hold the button and run up a bill as fast as
       * the network allows. It is not a pricing decision — that is still open
       * — it is the floor under one.
       */
      const existing = await listCompanions(db, request.currentUser!.id);
      if (existing.some((row) => row.status === 'generating')) {
        return reply.code(409).send({
          error: 'already_generating',
          message: 'One of your companions is still being created. Give her a moment.',
        });
      }

      const draft = request.body as MyAiDraft;
      const row = await createCompanion(db, request.currentUser!.id, draft);

      /*
       * DELIBERATELY NOT AWAITED. The response goes back now; the rendering
       * continues behind it. `runGeneration` never throws — it always lands
       * the row in a terminal state — so there is no rejection to lose here,
       * and the `catch` is belt and braces against a bug in that promise.
       */
      void runGeneration(
        { db, env: opts.myAi, storageDir, log: request.log },
        row.id,
      ).catch((cause) => request.log.error({ cause: String(cause) }, 'my-ai generation escaped its handler'));

      return reply.code(202).send({ companion: toWire(row) });
    },
  );

  /** One of hers, for polling while she is being made. */
  app.get<{ Params: { id: string } }>(
    '/api/my-ai/:id',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }
      const row = await getCompanion(db, request.currentUser!.id, id);
      if (!row) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }
      return { companion: toWire(row) };
    },
  );

  /* ---------------------------------------------------------------- *
   * Further photographs of a companion she already has
   * ---------------------------------------------------------------- */

  /**
   * Her gallery: the original portrait first, then everything asked for
   * since, newest first.
   *
   * The portrait is not a row in the photographs table — the provider drew it
   * from her attributes and every other picture is generated from it — so it
   * arrives carrying the reserved id `reference`. One list for the client,
   * two things in the schema, and the distinction kept where it matters.
   */
  app.get<{ Params: { id: string } }>(
    '/api/my-ai/:id/photos',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }
      const companion = await getCompanion(db, request.currentUser!.id, id);
      if (!companion) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }

      const rows = await listPhotos(db, id);
      const original = referencePhoto(companion);
      return { photos: [...(original ? [original] : []), ...rows.map(toPhotoWire)] };
    },
  );

  /**
   * Ask for another photograph of her.
   *
   * THIS COSTS REAL MONEY, once per request. Pricing and deduction are not
   * built yet and are deliberately not pretended at here; the only brake is
   * the same one-at-a-time guard that creating a companion has, which is the
   * floor under a pricing decision rather than the decision itself.
   */
  app.post<{ Params: { id: string }; Body: { prompt?: unknown; style?: unknown } }>(
    '/api/my-ai/:id/photos',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }

      // Validation BEFORE the availability check, exactly as on create: a
      // malformed request is malformed whether or not this environment can
      // render anything, so the contract does not change with deployment.
      const problems = myAiPhotoProblems(request.body ?? {});
      if (problems.length > 0) {
        return reply.code(400).send({
          error: 'invalid_photo_request',
          message: 'Describe the photo you want.',
          fields: problems,
        });
      }

      if (!opts.myAi) {
        return reply.code(503).send({
          error: 'my_ai_unavailable',
          message: 'New photos are not available here yet.',
        });
      }

      const companion = await getCompanion(db, request.currentUser!.id, id);
      if (!companion) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }

      /*
       * No provider id means she was never saved at the provider, so there is
       * nobody there to photograph. Said plainly rather than as a failed
       * generation the user waits a minute for.
       */
      if (companion.providerCharacterId === null) {
        return reply.code(409).send({
          error: 'companion_not_ready',
          message: 'She is not ready for new photos yet.',
        });
      }

      if ((await countGenerating(db, request.currentUser!.id)) > 0) {
        return reply.code(409).send({
          error: 'already_generating',
          message: 'One photo is still being made. Give it a moment.',
        });
      }

      const body = request.body as { prompt: string; style: string };
      const photo = await createPhoto(db, id, { prompt: body.prompt, style: body.style });

      // Not awaited: the response goes back now and the work continues behind
      // it. `runPhotoGeneration` never throws.
      void runPhotoGeneration(
        { db, env: opts.myAi, storageDir, log: request.log },
        photo.id,
      ).catch((cause) =>
        request.log.error({ cause: String(cause) }, 'my-ai photo generation escaped its handler'),
      );

      return reply.code(202).send({ photo: toPhotoWire(photo) });
    },
  );

  /** One photograph's bytes — owner-checked exactly like her portrait. */
  app.get<{ Params: { id: string; photoId: string } }>(
    '/api/my-ai/:id/photos/:photoId/image',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const notFound = () =>
        reply.code(404).send({ error: 'not_found', message: 'Image not found.' });

      const { id, photoId } = request.params;
      if (!UUID_RE.test(id) || !UUID_RE.test(photoId)) return notFound();

      const photo = await getPhoto(db, request.currentUser!.id, id, photoId);
      if (!photo?.imagePath) return notFound();

      if (!isInsideStorageRoot(storageDir, photo.imagePath)) {
        request.log.warn({ photoId }, 'refused a photo resolving outside MEDIA_STORAGE_DIR');
        return notFound();
      }
      if (!existsSync(photo.imagePath)) return notFound();

      reply.header('Cache-Control', 'private, max-age=3600');
      reply.type('image/jpeg');
      return reply.send(createReadStream(photo.imagePath));
    },
  );

  /**
   * Delete one photograph.
   *
   * `reference` deletes her ORIGINAL portrait, which is a different row and a
   * different file — her own. She survives it: the provider keeps its copy of
   * her reference, so further photographs still work, and the gallery falls
   * back to whatever else she has.
   */
  app.delete<{ Params: { id: string; photoId: string } }>(
    '/api/my-ai/:id/photos/:photoId',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const notFound = () =>
        reply.code(404).send({ error: 'not_found', message: 'Photo not found.' });

      const { id, photoId } = request.params;
      if (!UUID_RE.test(id)) return notFound();

      if (photoId === MY_AI_REFERENCE_PHOTO_ID) {
        const removed = await deletePortrait(db, request.currentUser!.id, id, storageDir);
        return removed ? reply.code(204).send() : notFound();
      }

      if (!UUID_RE.test(photoId)) return notFound();
      const removed = await deletePhoto(db, request.currentUser!.id, id, photoId, storageDir);
      return removed ? reply.code(204).send() : notFound();
    },
  );

  /* ---------------------------------------------------------------- *
   * Talking to her
   * ---------------------------------------------------------------- */

  /**
   * Her conversation, oldest first.
   *
   * There is no conversation id anywhere in these routes: a companion belongs
   * to exactly one account, so SHE is the thread. Ownership is the same check
   * as every other route here, and there is no second place to get it wrong.
   */
  app.get<{ Params: { id: string } }>(
    '/api/my-ai/:id/messages',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }
      const companion = await getCompanion(db, request.currentUser!.id, id);
      if (!companion) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }
      const rows = await listMessages(db, id);
      return { messages: rows.map(toMessageWire) };
    },
  );

  /**
   * Say something to her.
   *
   * SYNCHRONOUS, unlike making a picture: a reply arrives in a second or two,
   * and a chat that returned 202 and asked the client to poll for an answer
   * would be a worse version of waiting. Both messages are stored only after
   * the provider answers — a user message with no reply would replay as
   * history next turn and she would appear to have ignored it.
   *
   * NOT CHARGED. Catalogue chat deducts credits per message; companion chat
   * does not, because pricing for My AI is a decision that has not been made.
   * This is a deliberate gap, not an oversight, and it is the same gap the
   * photographs have.
   */
  app.post<{ Params: { id: string }; Body: { body?: unknown } }>(
    '/api/my-ai/:id/messages',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }

      const problem = myAiMessageProblem(request.body?.body);
      if (problem) {
        return reply
          .code(400)
          .send({ error: 'invalid_message', message: 'Say something to her first.' });
      }

      const companion = await getCompanion(db, request.currentUser!.id, id);
      if (!companion) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }

      /*
       * A companion still being drawn has nothing to talk with yet — her
       * attributes exist, but answering as somebody half-made is worse than
       * saying so. A FAILED one is a different matter: she may still have
       * enough of herself to hold a conversation, and refusing would strand
       * the user with nothing at all.
       */
      if (companion.status === 'generating') {
        return reply
          .code(409)
          .send({ error: 'companion_not_ready', message: 'She is still being made.' });
      }

      try {
        const { user, reply: answer } = await sendMessage(
          db,
          opts.replyProvider,
          companion,
          request.body!.body as string,
        );
        return { messages: [toMessageWire(user), toMessageWire(answer)] };
      } catch (cause) {
        request.log.error({ companionId: id, cause: String(cause) }, 'my-ai reply failed');
        return reply
          .code(502)
          .send({ error: 'reply_failed', message: 'She could not answer just now.' });
      }
    },
  );

  /**
   * Delete one of hers, and her picture with her.
   *
   * Permanent and immediate — there is no archive and no trash, because a
   * companion nobody can see is not something to keep a copy of. The client
   * asks for confirmation; this route does not second-guess it.
   *
   * A companion still being drawn can be deleted too. The generation running
   * behind her finds nothing to update, discards the portrait it downloaded
   * and stops, so a deletion mid-flight leaves no orphan on the volume.
   */
  app.delete<{ Params: { id: string } }>(
    '/api/my-ai/:id',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }

      const removed = await deleteCompanion(db, request.currentUser!.id, id, storageDir);
      if (!removed) {
        // Same answer for "not yours" as for "never existed".
        return reply.code(404).send({ error: 'not_found', message: 'Companion not found.' });
      }
      return reply.code(204).send();
    },
  );

  /**
   * Her portrait — THE ROUTE THAT MAKES "only the creator can see her" true.
   *
   * The app already has a media route, `/api/media/assets/:id/file`, and it is
   * public with no authentication at all. That is right for the lobby, where
   * every byte is published content, and completely wrong here: it would mean
   * a companion's picture is readable by anyone holding the link. So this is
   * its own route, behind the same session check and the same ownership query
   * as everything else above.
   */
  app.get<{ Params: { id: string } }>(
    '/api/my-ai/:id/image',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const notFound = () =>
        reply.code(404).send({ error: 'not_found', message: 'Image not found.' });

      const { id } = request.params;
      if (!UUID_RE.test(id)) return notFound();

      const row = await getCompanion(db, request.currentUser!.id, id);
      if (!row?.imagePath) return notFound();

      /*
       * A stored path that resolves outside MEDIA_STORAGE_DIR is a data
       * problem, not a client one. Log the KIND only — never the path — and
       * answer with the same opaque 404 as everything else, which is how the
       * message-media route handles it too.
       */
      if (!isInsideStorageRoot(storageDir, row.imagePath)) {
        request.log.warn({ companionId: id }, 'refused a companion image resolving outside MEDIA_STORAGE_DIR');
        return notFound();
      }
      if (!existsSync(row.imagePath)) return notFound();

      // Private by definition: never let a shared cache hold one of these.
      reply.header('Cache-Control', 'private, max-age=3600');
      reply.type('image/jpeg');
      return reply.send(createReadStream(row.imagePath));
    },
  );
}
