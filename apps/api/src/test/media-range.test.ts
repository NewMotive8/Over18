import { describe, expect, it } from 'vitest';
import {
  contentRangeHeader,
  etagFor,
  isNotModified,
  MEDIA_CACHE_CONTROL,
  MEDIA_MAX_AGE_SECONDS,
  parseRange,
  rangeLength,
  startsAView,
} from '../services/media-range.js';

/**
 * The range and conditional-request rules, tested as pure logic.
 *
 * WHY THIS MATTERS ENOUGH TO PIN EXHAUSTIVELY. Before this existed, the media
 * route ignored `Range` entirely: a request for the first kilobyte was answered
 * with the whole file, and a looping <video> — unable to seek on a length-less
 * chunked stream — re-downloaded itself once per loop. A real production
 * session showed one file fetched SEVEN times in six seconds and 71% of all
 * media traffic being duplicates. These cases are the contract that stops that
 * returning.
 */

const SIZE = 1000;

describe('parseRange understands what a media element actually sends', () => {
  it('treats a missing header as "send the whole file"', () => {
    expect(parseRange(undefined, SIZE)).toEqual({ kind: 'full' });
  });

  it('handles bytes=0- — the form every browser opens a video with', () => {
    expect(parseRange('bytes=0-', SIZE)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 999 },
    });
  });

  it('handles a metadata sniff, bytes=0-1023, without over-reading the file', () => {
    // Clamped to the last byte: asking beyond EOF is not an error.
    expect(parseRange('bytes=0-1023', SIZE)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 999 },
    });
  });

  it('handles a mid-file seek', () => {
    expect(parseRange('bytes=200-499', SIZE)).toEqual({
      kind: 'partial',
      range: { start: 200, end: 499 },
    });
  });

  it('handles a suffix range — the last N bytes, as an end-seek produces', () => {
    expect(parseRange('bytes=-100', SIZE)).toEqual({
      kind: 'partial',
      range: { start: 900, end: 999 },
    });
  });

  it('clamps a suffix longer than the file to the whole file', () => {
    expect(parseRange('bytes=-99999', SIZE)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 999 },
    });
  });

  it('reports a start past EOF as unsatisfiable, so the client is told the truth', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('treats a zero-length suffix as unsatisfiable', () => {
    expect(parseRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('rejects a backwards range', () => {
    expect(parseRange('bytes=500-200', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('falls back to the whole file for anything it does not understand', () => {
    // RFC 9110 permits ignoring an unparseable Range. Ignoring degrades to the
    // old behaviour rather than failing the request.
    for (const bad of ['', 'items=0-1', 'bytes=abc', 'bytes=', 'nonsense', 'bytes=1-2-3']) {
      expect(parseRange(bad, SIZE).kind).toBe('full');
    }
  });

  it('answers a multi-range request with the whole file rather than a half-done multipart', () => {
    expect(parseRange('bytes=0-100,200-300', SIZE)).toEqual({ kind: 'full' });
  });

  it('cannot satisfy any range against an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('is case-insensitive about the unit and tolerant of spacing', () => {
    expect(parseRange(' BYTES=0-99 ', SIZE)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 99 },
    });
  });
});

describe('range arithmetic is inclusive at both ends, as HTTP defines it', () => {
  it('counts a single byte as one byte', () => {
    expect(rangeLength({ start: 0, end: 0 })).toBe(1);
  });

  it('counts the whole file correctly', () => {
    expect(rangeLength({ start: 0, end: 999 })).toBe(1000);
  });

  it('formats Content-Range for a partial response', () => {
    expect(contentRangeHeader({ start: 0, end: 99 }, 1000)).toBe('bytes 0-99/1000');
  });

  it('formats Content-Range for a 416, which reports only the true size', () => {
    expect(contentRangeHeader(null, 1000)).toBe('bytes */1000');
  });
});

describe('the validator identifies the exact bytes', () => {
  it('changes when the size changes', () => {
    expect(etagFor({ size: 1, mtimeMs: 1000 })).not.toBe(etagFor({ size: 2, mtimeMs: 1000 }));
  });

  it('changes when the file is rewritten', () => {
    expect(etagFor({ size: 1, mtimeMs: 1000 })).not.toBe(etagFor({ size: 1, mtimeMs: 2000 }));
  });

  it('is stable for the same file', () => {
    expect(etagFor({ size: 9, mtimeMs: 5 })).toBe(etagFor({ size: 9, mtimeMs: 5 }));
  });

  it('is a STRONG, quoted tag — a weak one may not validate a range', () => {
    const tag = etagFor({ size: 16, mtimeMs: 32 });
    expect(tag.startsWith('"')).toBe(true);
    expect(tag.endsWith('"')).toBe(true);
    expect(tag.startsWith('W/')).toBe(false);
  });
});

describe('conditional requests let a client skip the download', () => {
  const current = { etag: '"abc"', mtimeMs: 1_700_000_000_000 };

  it('matches an identical ETag', () => {
    expect(isNotModified({ ifNoneMatch: '"abc"' }, current)).toBe(true);
  });

  it('matches within a list of tags', () => {
    expect(isNotModified({ ifNoneMatch: '"x", "abc", "y"' }, current)).toBe(true);
  });

  it('matches a weak form of the same tag, as cache validation requires', () => {
    expect(isNotModified({ ifNoneMatch: 'W/"abc"' }, current)).toBe(true);
  });

  it('matches the wildcard', () => {
    expect(isNotModified({ ifNoneMatch: '*' }, current)).toBe(true);
  });

  it('does NOT match a different tag — the client must re-download', () => {
    expect(isNotModified({ ifNoneMatch: '"different"' }, current)).toBe(false);
  });

  it('prefers the ETag over the date when both are present', () => {
    // The tag says stale; the date says fresh. The tag is exact, so it wins.
    expect(
      isNotModified(
        { ifNoneMatch: '"different"', ifModifiedSince: new Date(current.mtimeMs).toUTCString() },
        current,
      ),
    ).toBe(false);
  });

  it('honours If-Modified-Since when no ETag is offered', () => {
    expect(
      isNotModified({ ifModifiedSince: new Date(current.mtimeMs).toUTCString() }, current),
    ).toBe(true);
  });

  it('floors to whole seconds, so a sub-second mtime does not defeat the cache forever', () => {
    // Last-Modified has one-second resolution. Without flooring, a file written
    // at x.600s always looks newer than the header the server itself sent.
    const withMillis = { etag: '"e"', mtimeMs: current.mtimeMs + 600 };
    expect(
      isNotModified({ ifModifiedSince: new Date(current.mtimeMs).toUTCString() }, withMillis),
    ).toBe(true);
  });

  it('re-downloads when the file is genuinely newer', () => {
    const newer = { etag: '"e"', mtimeMs: current.mtimeMs + 60_000 };
    expect(
      isNotModified({ ifModifiedSince: new Date(current.mtimeMs).toUTCString() }, newer),
    ).toBe(false);
  });

  it('ignores an unparseable date rather than guessing', () => {
    expect(isNotModified({ ifModifiedSince: 'not a date' }, current)).toBe(false);
  });

  it('says nothing is fresh when the client offers no validator at all', () => {
    expect(isNotModified({}, current)).toBe(false);
  });
});

describe('the caching policy does not widen what is visible', () => {
  it('keeps the pre-existing five-minute revocation window', () => {
    // Unpublishing must still take effect quickly. The performance win comes
    // from ETag and ranges, NOT from caching bytes for longer.
    expect(MEDIA_MAX_AGE_SECONDS).toBe(300);
  });

  it('forbids serving stale bytes past that window', () => {
    expect(MEDIA_CACHE_CONTROL).toContain('must-revalidate');
    expect(MEDIA_CACHE_CONTROL).toContain('max-age=300');
  });

  it('is NOT immutable — visibility is revocable even though bytes are not', () => {
    expect(MEDIA_CACHE_CONTROL).not.toContain('immutable');
  });
});


/**
 * WHAT COUNTS AS SOMEONE WATCHING — the rule behind `content_viewed`.
 *
 * This is the arithmetic that decides whether an engagement number is worth
 * anything. The file above measured a single Home load issuing 14 requests for
 * 4 files; if each of those were a "view", the most-watched clip would simply
 * be the one that takes the most fetches to finish. These cases pin the
 * opposite: a view is a request that STARTS a watch, and everything that merely
 * continues one is silent.
 */
describe('startsAView counts watches, not requests', () => {
  it('counts a whole-file request — an image, or a video with no Range', () => {
    expect(startsAView(false, { kind: 'full' })).toBe(true);
  });

  it('counts the opening slice of a video, which begins at byte 0', () => {
    expect(startsAView(false, { kind: 'partial', range: { start: 0, end: 99 } })).toBe(true);
  });

  /** The same watch continuing. Counting it is how 1 view becomes 20. */
  it('does NOT count a slice from the middle', () => {
    expect(startsAView(false, { kind: 'partial', range: { start: 100, end: 199 } })).toBe(false);
  });

  it('does NOT count a one-byte probe taken from anywhere but the start', () => {
    expect(startsAView(false, { kind: 'partial', range: { start: 1, end: 1 } })).toBe(false);
  });

  /**
   * A re-watch of a cached clip. The bytes never move, so this is the ONLY
   * trace a second viewing leaves — and a second viewing is the strongest
   * signal of taste there is.
   */
  it('counts a not-modified response as a genuine re-watch', () => {
    expect(startsAView(true, null)).toBe(true);
  });

  /** Still a re-watch: the conditional answer is decided before any range is. */
  it('counts not-modified even when a Range header came with it', () => {
    expect(startsAView(true, { kind: 'partial', range: { start: 500, end: 600 } })).toBe(true);
  });

  it('does NOT count a range outside the file — nothing was served', () => {
    expect(startsAView(false, { kind: 'unsatisfiable' })).toBe(false);
  });

  it('does NOT count a request with no outcome at all', () => {
    expect(startsAView(false, null)).toBe(false);
  });

  /**
   * The documented bias, stated as a test so nobody "fixes" it later: a watch
   * resumed from the middle is missed on purpose. Over-counting would distort
   * every ranking built on this and leave no evidence that it had.
   */
  it('under-counts rather than over-counts, by design', () => {
    const resumedMidFile = startsAView(false, { kind: 'partial', range: { start: 2048, end: 4095 } });
    const suffixSeek = startsAView(false, { kind: 'partial', range: { start: 900, end: 999 } });
    expect([resumedMidFile, suffixSeek]).toEqual([false, false]);
  });
});
