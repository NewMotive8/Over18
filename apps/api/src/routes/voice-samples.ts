import type { FastifyInstance } from 'fastify';
import { isKnownGrokVoice, isKnownVoice } from '@over18/shared';
import {
  VOICE_SAMPLE_CONTENT_TYPE,
  readVoiceSample,
} from '../voice/grok-voice-samples.js';
import { resolveGrokVoice } from '../voice/grok.js';

/**
 * Hearing a voice before choosing it.
 *
 * ── WHY THIS IS PUBLIC, WHEN THE ADMIN ONE IS NOT ───────────────────────────
 *
 * There is already `GET /admin/voice/samples/:voice`, behind `adminOnly`,
 * for casting characters. This is the same 28 cached files for a different
 * audience: somebody building their own companion in My AI, who may not be
 * signed in yet — the wizard is deliberately playable signed-out, and a
 * preview that demanded an account would be the one step that is not.
 *
 * Nothing here is anybody's data. A sample is one fixed sentence, rendered
 * once per voice, identical for every visitor; it reveals no character, no
 * account and no companion. The risk of serving it openly is bandwidth, which
 * the immutable cache header handles.
 *
 * ── IT TAKES EITHER NAME, AND THAT IS THE POINT ─────────────────────────────
 *
 * My AI offers SpicyAPI's names (Serena, Tina, Chloe…) because that is the
 * catalogue the rest of the product casts from. The cached samples are xAI's
 * voices (eve, ara, iris…), because Grok renders them. `resolveGrokVoice` is
 * the SAME function the call path uses to turn one into the other — so what a
 * visitor hears here is the voice a call would actually use, not an
 * approximation of it. Using any other mapping would be a promise the product
 * does not keep.
 */
export default async function voiceSampleRoutes(
  app: FastifyInstance,
  opts: { storageDir: string },
) {
  app.get<{ Params: { voice: string } }>('/api/voice-samples/:voice', async (request, reply) => {
    const notFound = () =>
      reply.code(404).send({ error: 'not_found', message: 'No sample for that voice.' });

    const asked = request.params.voice;
    // Length-capped before anything touches the filesystem: this is a path
    // component in the end, and `resolveGrokVoice` is the only thing that
    // decides what it becomes.
    if (typeof asked !== 'string' || asked.length === 0 || asked.length > 40) return notFound();

    /*
     * MEMBERSHIP IS CHECKED BEFORE RESOLUTION, on purpose.
     *
     * `resolveGrokVoice` answers the DEFAULT voice for anything it does not
     * recognise. That is right when placing a call — somebody has to speak —
     * and wrong here, where it would quietly play `eve` to a visitor who
     * asked about a voice that does not exist, and they would believe they
     * had heard it. An unknown name is a 404.
     */
    if (!isKnownGrokVoice(asked) && !isKnownVoice(asked)) return notFound();
    const resolved = resolveGrokVoice(asked);

    const bytes = await readVoiceSample({ mediaDir: opts.storageDir }, resolved);
    if (!bytes) return notFound();

    return reply
      .header('content-type', VOICE_SAMPLE_CONTENT_TYPE)
      // A sample never changes without a deliberate regeneration, and it is
      // the same bytes for everyone — so a shared cache may hold it.
      .header('cache-control', 'public, max-age=86400, immutable')
      .send(bytes);
  });
}
