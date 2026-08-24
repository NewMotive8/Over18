/**
 * HTTP byte-range and conditional-request logic for media responses.
 *
 * WHY THIS EXISTS. The media route streamed files with `reply.send(createReadStream(path))`
 * and nothing else. That produced `Transfer-Encoding: chunked` with no
 * `Content-Length`, no `Accept-Ranges`, no `ETag` — and it ignored `Range`
 * entirely, answering a request for the first kilobyte with the whole file.
 *
 * Measured consequences, from a real production session: one user's Home load
 * issued 14 media requests for 4 distinct files — 71% duplicates — and one file
 * was re-fetched SEVEN times in six seconds, roughly once per second. That is
 * the signature of a looping <video> on a non-seekable stream: with no length
 * and no range support the element cannot rewind, so every loop re-opens the
 * request and re-downloads the file. `preload="metadata"` had the same problem
 * in reverse — the browser asked for a few bytes to read the header and was
 * handed the entire asset.
 *
 * PURE FUNCTIONS ON PURPOSE. Everything here takes plain values and returns a
 * decision. No filesystem, no Fastify, no database — so the parsing rules can
 * be tested exhaustively without a server, and the route stays a thin caller.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it makes no authorization decision of any
 * kind. The caller has already proven the asset is approved and publicly
 * reachable before any of this runs; a range header can never widen what is
 * served, only narrow it to a slice of a file the caller already resolved.
 */

/** A byte interval, inclusive at both ends, as HTTP defines it. */
export interface ByteRange {
  start: number;
  end: number;
}

export type RangeOutcome =
  /** No Range header, or one this server chooses not to honour: send the whole file. */
  | { kind: 'full' }
  /** A satisfiable range: send 206 with these bytes. */
  | { kind: 'partial'; range: ByteRange }
  /** Syntactically valid but outside the file: send 416. */
  | { kind: 'unsatisfiable' };

/**
 * Interprets a `Range` header against a known file size.
 *
 * ONLY `bytes` UNITS, AND ONLY ONE RANGE. A multi-range request is answered
 * with the whole file rather than a `multipart/byteranges` body: browsers do
 * not send multi-range for media playback, and a half-correct multipart
 * implementation is worse than an honest 200. Anything unparseable is treated
 * the same way — RFC 9110 says an unsatisfiable-looking header MAY be ignored,
 * and ignoring it degrades to exactly today's behaviour rather than an error.
 *
 * SUFFIX RANGES (`bytes=-500`, meaning "the last 500 bytes") are supported
 * because seeking near the end of a clip produces them.
 */
export function parseRange(header: string | undefined, size: number): RangeOutcome {
  if (!header) return { kind: 'full' };

  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return { kind: 'full' };

  const spec = match[1]!.trim();
  // Multiple ranges — honest 200 rather than a partial multipart implementation.
  if (spec.includes(',')) return { kind: 'full' };

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return { kind: 'full' };

  const startText = parts[1]!;
  const endText = parts[2]!;

  // An empty file cannot satisfy any range.
  if (size === 0) return { kind: 'unsatisfiable' };

  if (startText === '' && endText === '') return { kind: 'full' };

  if (startText === '') {
    // Suffix form: the LAST n bytes. n larger than the file means the whole file.
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffix)) return { kind: 'full' };
    if (suffix === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffix);
    return { kind: 'partial', range: { start, end: size - 1 } };
  }

  const start = Number.parseInt(startText, 10);
  if (!Number.isFinite(start)) return { kind: 'full' };
  // A start at or past EOF is unsatisfiable; the client must be told so.
  if (start >= size) return { kind: 'unsatisfiable' };

  // An absent or over-long end is clamped to the last byte — this is the
  // `bytes=0-` form every browser opens a video with.
  const end = endText === '' ? size - 1 : Math.min(Number.parseInt(endText, 10), size - 1);
  if (!Number.isFinite(end) || end < start) return { kind: 'unsatisfiable' };

  return { kind: 'partial', range: { start, end } };
}

/** How many bytes an interval covers. Inclusive at both ends. */
export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}

/** The `Content-Range` value for a 206, or for the 416 that reports the true size. */
export function contentRangeHeader(range: ByteRange | null, size: number): string {
  return range ? `bytes ${range.start}-${range.end}/${size}` : `bytes */${size}`;
}

/**
 * A strong validator for one stored file.
 *
 * SIZE AND MTIME ARE ENOUGH HERE, and hashing the bytes would not be: an asset
 * id addresses one file that is written once by the upload path and never
 * rewritten, so the pair changes only if the file is replaced. Quoted and
 * strong (not `W/`), because it identifies the exact bytes — which is what
 * makes it usable to validate a RANGE, where a weak validator may not be.
 */
export function etagFor(stat: { size: number; mtimeMs: number }): string {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/**
 * Whether the client's cached copy is still good.
 *
 * `If-None-Match` WINS OVER `If-Modified-Since` when both are present, as
 * RFC 9110 requires: the entity tag is exact, the date is a second-resolution
 * approximation. `*` matches any existing representation.
 *
 * The date comparison floors both sides to whole seconds because
 * `Last-Modified` has no sub-second precision — without that, a file written at
 * x.6s looks newer than the `Last-Modified` value the server itself sent, and
 * the client re-downloads forever.
 */
export function isNotModified(
  headers: { ifNoneMatch?: string; ifModifiedSince?: string },
  current: { etag: string; mtimeMs: number },
): boolean {
  const inm = headers.ifNoneMatch?.trim();
  if (inm) {
    if (inm === '*') return true;
    return inm
      .split(',')
      .map((tag) => tag.trim())
      // A weak comparison is correct for cache validation: W/"x" matches "x".
      .some((tag) => tag === current.etag || tag.replace(/^W\//, '') === current.etag);
  }

  const ims = headers.ifModifiedSince?.trim();
  if (ims) {
    const since = Date.parse(ims);
    if (Number.isFinite(since)) {
      return Math.floor(current.mtimeMs / 1000) <= Math.floor(since / 1000);
    }
  }
  return false;
}

/**
 * How long a client may reuse media bytes before asking again.
 *
 * DELIBERATELY NOT `immutable`, AND DELIBERATELY NOT A YEAR. The BYTES behind an
 * asset id never change, which is the usual argument for a long immutable
 * cache — but VISIBILITY does change. An operator can unapprove an asset,
 * retire its character, or pull it from every surface, and the media route
 * answers 404 the moment they do. A year-long immutable cache would let a
 * browser keep serving a withdrawn clip from disk long after the product
 * stopped publishing it, which would weaken a rule the route otherwise
 * enforces on every request.
 *
 * So the revocation window stays exactly what it was before this change — five
 * minutes — and `must-revalidate` forbids serving stale bytes past it. The
 * performance win does not come from caching longer; it comes from `ETag`,
 * which turns the request after expiry into a ~200-byte 304 instead of a full
 * re-download, and from range support, which stops loops re-fetching at all.
 */
export const MEDIA_MAX_AGE_SECONDS = 300;
export const MEDIA_CACHE_CONTROL = `public, max-age=${MEDIA_MAX_AGE_SECONDS}, must-revalidate`;
