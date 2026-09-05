import { createReadStream, existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import {
  browsePublicCharacters,
  browsePublicClips,
  composeHome,
  listPlayWithMe,
  listPublicCategoryPills,
} from '../services/home-composition-service.js';
import {
  listDiscoveryClips,
  listPublicDiscoveryCategories,
  DISCOVERY_CLIPS_MAX_LIMIT,
} from '../services/discovery-service.js';
import { getPublicAsset, resolvePublicMedia } from '../services/public-media-service.js';
import {
  contentRangeHeader,
  etagFor,
  isNotModified,
  MEDIA_CACHE_CONTROL,
  parseRange,
  rangeLength,
} from '../services/media-range.js';
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
    /** MEDIA_OPTIMISED_ENABLED. Default false — originals. */
    optimisedMedia?: boolean;
    cookie?: { secure: boolean; sameSite: 'lax' | 'strict' | 'none' };
  },
) {
  const storageDir = opts.mediaStorageDir ?? null;
  const preferOptimised = opts.optimisedMedia === true;
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

  /**
   * THE PLAY WITH ME POPULATION, on its own.
   *
   * The SAME `listPlayWithMe` that produces `home.playWithMe` — not a similar
   * query, not a second definition, the same function called a second way. That
   * is the entire reason this route exists: Swipe must contain exactly the
   * characters Home's rail contains, and the only way to guarantee that is for
   * both to read one source. Swipe used to populate itself from
   * `/api/characters`, which is every active character regardless of whether
   * she has published anything, so the deck showed characters the rail had
   * already dropped and dressed them in whatever fallback media the client
   * could find.
   *
   * WHY NOT JUST CALL `/api/home`? Because Swipe would then also compose
   * banners, hero clips, every published category rail and the search grid —
   * work it discards. The composition is shared where it matters (the rule) and
   * not where it does not (the payload).
   *
   * PUBLIC, LIKE HOME. Browsing needs no account, and this carries the same
   * narrow projection: a display name, an age band, category chips and one real
   * clip. Saving one of these characters DOES need an account, and that lives
   * in its own authenticated plugin.
   *
   * Every card here is eligible by construction — `listPlayWithMe` drops a
   * character with no publicly reachable video rather than returning her with a
   * null clip — so the deck needs no filtering rule of its own and could not
   * apply a laxer one if it had.
   */
  app.get('/api/play-with-me', async () => ({
    characters: await listPlayWithMe(opts.db),
  }));

  /** The lower-page discovery strip, in order. Position 0 is the default pill. */
  app.get('/api/discovery/categories', async () => ({
    categories: await listPublicDiscoveryCategories(opts.db),
  }));

  /**
   * The lobby's category pills — App Categories, in the operator's CMS order.
   *
   * These are the SAME categories an operator merchandises in Admin. Discovery
   * categories are not exposed as pills: one editorial system, one place to
   * manage it.
   */
  app.get('/api/categories', async () => ({
    categories: await listPublicCategoryPills(opts.db),
  }));

  /**
   * The lobby's character grid. Both filters are optional and independent;
   * omitting `category` is the unfiltered "All" state, which is what makes
   * search work before any category has been configured.
   *
   * RETAINED BUT NO LONGER THE SEARCH GRID. The lobby's results are clips now
   * (see `/api/browse/clips`); this stays because it is a public, approval-
   * gated character listing with its own tests and no known second caller to
   * break. It is NOT a fallback for the clip grid — nothing falls back to it.
   */
  app.get<{ Querystring: { category?: string; q?: string } }>(
    '/api/browse/characters',
    async (request) => ({
      characters: await browsePublicCharacters(opts.db, {
        categorySlug: request.query.category ?? null,
        query: request.query.q ?? null,
      }),
    }),
  );

  /**
   * The lobby's SEARCH GRID: content clips, never characters.
   *
   * Every item is a real `character_visual_assets` content row — an asset id,
   * one owning character, and bytes served by `/api/media/assets/:id/file`.
   * Reference/identity images are excluded by kind, and there is no fallback
   * branch of any sort: no profile image, no canonical image, no manifest, no
   * placeholder. Nothing matching means an empty array.
   *
   * `category` and `q` are INDEPENDENT filters, exactly as the character grid
   * treats them — selecting a pill never clears the search box.
   */
  app.get<{ Querystring: { category?: string; q?: string } }>(
    '/api/browse/clips',
    async (request) => ({
      clips: await browsePublicClips(opts.db, {
        categorySlug: request.query.category ?? null,
        query: request.query.q ?? null,
      }),
    }),
  );

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

      const resolved = resolvePublicMedia(asset, { storageDir: storageDir ?? '', preferOptimised });
      if ('failure' in resolved) return notFound();
      if (!existsSync(resolved.path)) return notFound();

      /* ------------------------------------------------------------------ *
       * Everything above this line is the authorization path and is
       * UNCHANGED: a uuid check, `getPublicAsset` (approved AND publicly
       * reachable, enforced in SQL), a storage-root check, and an existence
       * check. Nothing below can widen what is served — a Range header only
       * ever narrows the response to a slice of a file the caller has already
       * been cleared for, and a conditional request only ever replaces a body
       * with a 304. A withdrawn asset still 404s here on the very next
       * request, exactly as before.
       * ------------------------------------------------------------------ */

      let stat;
      try {
        stat = statSync(resolved.path);
      } catch {
        // Raced with a delete between existsSync and here.
        return notFound();
      }

      const etag = etagFor(stat);
      const lastModified = new Date(stat.mtimeMs).toUTCString();

      // Headers every response carries, including 304 and 416, so a cached
      // client keeps a complete picture of the representation.
      reply.header('content-type', resolved.contentType);
      reply.header('cache-control', MEDIA_CACHE_CONTROL);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('accept-ranges', 'bytes');
      reply.header('etag', etag);
      reply.header('last-modified', lastModified);

      // A still-fresh copy: answer with no body at all.
      if (
        isNotModified(
          {
            ifNoneMatch: request.headers['if-none-match'],
            ifModifiedSince: request.headers['if-modified-since'],
          },
          { etag, mtimeMs: stat.mtimeMs },
        )
      ) {
        return reply.code(304).send();
      }

      const outcome = parseRange(request.headers.range, stat.size);

      if (outcome.kind === 'unsatisfiable') {
        reply.header('content-range', contentRangeHeader(null, stat.size));
        // The media content-type is already set above; a JSON body under it
        // would make Fastify refuse to serialise. 416 carries no body anyway —
        // `Content-Range: bytes *​/size` is the entire answer.
        reply.header('content-type', 'application/json; charset=utf-8');
        return reply.code(416).send(JSON.stringify({ error: 'range_not_satisfiable' }));
      }

      if (outcome.kind === 'partial') {
        const { range } = outcome;
        reply.code(206);
        reply.header('content-range', contentRangeHeader(range, stat.size));
        reply.header('content-length', rangeLength(range));
        return reply.send(createReadStream(resolved.path, { start: range.start, end: range.end }));
      }

      // Whole file — but now with a length, so the element is seekable and a
      // loop rewinds instead of re-downloading.
      reply.header('content-length', stat.size);
      return reply.send(createReadStream(resolved.path));
    },
  );
}
