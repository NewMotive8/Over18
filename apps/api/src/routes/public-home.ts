import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { composeHome } from '../services/home-composition-service.js';
import {
  listDiscoveryClips,
  listPublicDiscoveryCategories,
  DISCOVERY_CLIPS_MAX_LIMIT,
} from '../services/discovery-service.js';
import { getPublicAsset, resolvePublicMedia } from '../services/public-media-service.js';
import {
  getPubliclyVisibleBannerCreative,
  resolveBannerCreative,
} from '../services/banner-creative-service.js';

/**
 * The PUBLIC app surface (US-102.4): Home, Discovery, and public media.
 *
 * Public by design, exactly like the character routes: browsing requires no
 * account. That is precisely why every projection in here is narrow and every
 * read is approval-gated — there is no session to fall back on.
 *
 * WHAT IS NOT HERE. No admin route, no composition write, no keyword write. The
 * services this file calls are the public halves of their modules; their admin
 * counterparts live in separate functions in separate route files so a public
 * caller cannot reach an admin shape by omitting a parameter.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Set on first visit so a returning viewer can be recognised. */
const RETURNING_COOKIE = 'o18_seen';

export default async function publicHomeRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    mediaStorageDir?: string | null;
    cookie?: { secure: boolean; sameSite: 'lax' | 'strict' | 'none' };
  },
) {
  const storageDir = opts.mediaStorageDir ?? null;
  // The SAME policy the session cookie uses. Hard-coding lax/insecure here
  // would silently break the audience model in the cross-origin deployments
  // this app actually runs in: the browser would never send the cookie back,
  // so every anonymous visitor would look new forever.
  const cookiePolicy = opts.cookie ?? { secure: false, sameSite: 'lax' as const };

  /**
   * Home.
   *
   * `now` is resolved once and threaded through composition, so one response
   * cannot straddle a schedule boundary and report one banner as live and its
   * neighbour as expired from two different clock reads.
   *
   * THE AUDIENCE MODEL IS THE MVP ONE (US-102.3): Everyone / New users /
   * Returning users, and the only viewer fact consulted is `isReturning`. A
   * signed-in caller is returning by definition; an anonymous one is recognised
   * by a first-party cookie set on first visit. No profile, no demographics, no
   * geography, no device fingerprint — targeting beyond this is US-102.5.
   */
  app.get('/api/home', async (request, reply) => {
    const seen = request.cookies?.[RETURNING_COOKIE] === '1';
    const isReturning = Boolean(request.currentUser) || seen;

    if (!seen) {
      reply.setCookie(RETURNING_COOKIE, '1', {
        path: '/',
        httpOnly: true,
        secure: cookiePolicy.secure,
        sameSite: cookiePolicy.sameSite,
        maxAge: 60 * 60 * 24 * 365,
      });
    }

    const home = await composeHome(
      opts.db,
      { storageDir: storageDir ?? '' },
      { now: new Date(), viewer: { isReturning } },
    );
    // A per-viewer payload must never be shared by a cache.
    reply.header('cache-control', 'private, no-store');
    return reply.send(home);
  });

  /** The lower-page discovery strip, in order. Position 0 is the default pill. */
  app.get('/api/discovery/categories', async () => ({
    categories: await listPublicDiscoveryCategories(opts.db),
  }));

  /**
   * Discovery results. `category` and `q` are INDEPENDENT filters — selecting a
   * category never clears a search and vice versa.
   */
  app.get<{
    Querystring: { category?: string; q?: string; limit?: string; offset?: string };
  }>('/api/discovery/clips', async (request) => {
    const { category, q, limit, offset } = request.query;
    const result = await listDiscoveryClips(opts.db, {
      categorySlug: category ?? null,
      query: q ?? null,
      limit: limit ? Number.parseInt(limit, 10) || undefined : undefined,
      offset: offset ? Number.parseInt(offset, 10) || undefined : undefined,
    });
    return { ...result, maxLimit: DISCOVERY_CLIPS_MAX_LIMIT };
  });

  /**
   * A live banner's creative.
   *
   * Public because Home is public, but NOT unconditionally: the creative is
   * served only while some banner that uses it is currently eligible — the same
   * question US-102.3's listEligibleHomeBanners answers for the payload. An
   * uploaded creative attached to a draft, an expired banner, or nothing at all
   * is a 404 here, so uploading artwork never publishes it.
   */
  app.get<{ Params: { creativeId: string } }>(
    '/api/home/banner-creatives/:creativeId/file',
    async (request, reply) => {
      const { creativeId } = request.params;
      const notFound = () =>
        reply.code(404).send({ error: 'not_found', message: 'Media not found.' });

      if (!UUID_RE.test(creativeId)) return notFound();
      if (!storageDir) return notFound();

      const row = await getPubliclyVisibleBannerCreative(opts.db, creativeId, new Date());
      if (!row) return notFound();

      const resolved = resolveBannerCreative(row, { storageDir });
      if (!resolved.ok) return notFound();

      reply.header('content-type', resolved.contentType);
      reply.header('cache-control', 'public, max-age=300');
      reply.header('x-content-type-options', 'nosniff');
      return reply.send(createReadStream(resolved.path));
    },
  );

  /**
   * Public media.
   *
   * The ONLY locator a browser is ever given for content bytes, and the
   * replacement for the raw `storageKey` the public visual-identity endpoint
   * used to emit. Two conditions, both enforced in SQL by getPublicAsset:
   * the asset is approved, AND it is reachable from a public surface. An
   * approved asset nobody has published is a 404 here — otherwise this route
   * would quietly expose the whole approved Library to anyone who could guess
   * an id.
   *
   * Unknown, unapproved, unpublished and unreadable all return the SAME 404, so
   * the route leaks no existence information.
   */
  app.get<{ Params: { assetId: string } }>(
    '/api/media/assets/:assetId/file',
    async (request, reply) => {
      const { assetId } = request.params;
      const notFound = () =>
        reply.code(404).send({ error: 'not_found', message: 'Media not found.' });

      if (!UUID_RE.test(assetId)) return notFound();
      if (!storageDir) return notFound();

      const asset = await getPublicAsset(opts.db, assetId);
      if (!asset) return notFound();

      const resolved = resolvePublicMedia(asset, { storageDir: storageDir ?? '' });
      if ('failure' in resolved) return notFound();
      if (!existsSync(resolved.path)) return notFound();

      reply.header('content-type', resolved.contentType);
      // Public bytes, but short-lived: unpublishing must take effect quickly.
      reply.header('cache-control', 'public, max-age=300');
      reply.header('x-content-type-options', 'nosniff');
      return reply.send(createReadStream(resolved.path));
    },
  );
}
