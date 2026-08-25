/**
 * The gate a derivative must pass before it may be served in place of an
 * operator's original.
 *
 * ONE RULE ABOVE ALL OTHERS: a derivative is adopted only when every check
 * passes. There is no "mostly fine", no warning level and no override. A single
 * failure means the key is never written, which means `resolveMediaFile` never
 * finds it, which means the original keeps serving. Every failure mode in this
 * system converges on that same outcome by construction rather than by a
 * handler remembering to fall back.
 *
 * WHAT EACH CHECK EXISTS TO PREVENT, because a checklist nobody can motivate
 * gets relaxed the first time it is inconvenient:
 *
 *   codec       — a derivative a browser cannot decode is worse than a big one.
 *   resolution  — a silently rescaled clip changes the product's framing.
 *   duration    — a truncated encode loses content the operator published.
 *   frames      — the strongest single proof the encode ran to completion; a
 *                 crashed or interrupted ffmpeg leaves a short file that still
 *                 parses, and duration alone can round past it.
 *   audio       — THE explicit product requirement. Audio must survive
 *                 optimisation, and this is what makes that a guarantee rather
 *                 than an intention: the counts must match, so a derivative
 *                 that lost a track is refused. Today every production clip has
 *                 zero audio streams and the check passes trivially; the day one
 *                 has sound, it protects it without anyone remembering to.
 *   video track — exactly one, matching the original's count, so a derivative
 *                 with a stray extra track is not adopted.
 *   faststart   — the point of the exercise on the serving side.
 *   size        — a derivative that is not meaningfully smaller has no reason
 *                 to exist, and one that is LARGER is a regression wearing an
 *                 optimisation's name.
 *
 * WHAT THIS DOES NOT PROVE. It does not decode. A container can be perfectly
 * formed and still fail in a real decoder, and proving otherwise needs a
 * decoder this image does not ship. Adoption is therefore a deliberate,
 * per-asset operator action with a human looking at the result — not something
 * that happens on its own.
 */

import { inspectMp4, type Mp4Facts } from './mp4-inspect.js';

/** How much smaller a derivative must be to be worth adopting at all. */
export const MAX_DERIVATIVE_SIZE_RATIO = 0.95;

/** Codecs a derivative may use. Deliberately narrower than what uploads accept. */
const DERIVATIVE_CODEC = 'h264';

export interface DerivativeCheck {
  name: string;
  pass: boolean;
  original: string;
  derivative: string;
}

export interface DerivativeVerdict {
  ok: boolean;
  checks: DerivativeCheck[];
  /** Names of the checks that failed, for a log line and an operator message. */
  failed: string[];
  originalFacts: Mp4Facts | null;
  derivativeFacts: Mp4Facts | null;
}

function check(
  name: string,
  pass: boolean,
  original: unknown,
  derivative: unknown,
): DerivativeCheck {
  return { name, pass, original: String(original), derivative: String(derivative) };
}

/** A refusal with no facts — used when either file cannot be read at all. */
function unreadable(
  originalFacts: Mp4Facts | null,
  derivativeFacts: Mp4Facts | null,
): DerivativeVerdict {
  const checks = [
    check('readable', false, originalFacts ? 'ok' : 'unreadable', derivativeFacts ? 'ok' : 'unreadable'),
  ];
  return { ok: false, checks, failed: ['readable'], originalFacts, derivativeFacts };
}

/**
 * Compares a candidate derivative against the original it would replace.
 *
 * Takes PATHS, not bytes: the files being compared must be the ones on disk, so
 * that what is verified is what will later be served. Verifying an in-memory
 * buffer and then writing it separately leaves a gap where the two could differ.
 */
export function verifyDerivative(
  originalPath: string,
  derivativePath: string,
): DerivativeVerdict {
  const original = inspectMp4(originalPath);
  const derivative = inspectMp4(derivativePath);
  if (!original || !derivative) return unreadable(original, derivative);

  // One frame of slack, computed from the original's own frame rate. An encoder
  // may land a fraction of a frame either side; half a second is a truncation.
  const frameSeconds =
    original.frameCount && original.durationSeconds && original.frameCount > 0
      ? original.durationSeconds / original.frameCount
      : 0.05;
  const durationDelta = Math.abs(
    (derivative.durationSeconds ?? -1) - (original.durationSeconds ?? -2),
  );

  const checks: DerivativeCheck[] = [
    check('readable', true, 'ok', 'ok'),
    check('codec', derivative.videoCodec === DERIVATIVE_CODEC, original.videoCodec, derivative.videoCodec),
    check(
      'resolution',
      derivative.width === original.width && derivative.height === original.height,
      `${original.width}x${original.height}`,
      `${derivative.width}x${derivative.height}`,
    ),
    check(
      'duration',
      original.durationSeconds !== null &&
        derivative.durationSeconds !== null &&
        durationDelta <= frameSeconds,
      original.durationSeconds?.toFixed(3),
      derivative.durationSeconds?.toFixed(3),
    ),
    check(
      'frameCount',
      original.frameCount !== null && derivative.frameCount === original.frameCount,
      original.frameCount,
      derivative.frameCount,
    ),
    check(
      'audioStreams',
      derivative.audioStreams === original.audioStreams,
      original.audioStreams,
      derivative.audioStreams,
    ),
    check(
      'videoStreams',
      derivative.videoStreams === 1 && original.videoStreams === derivative.videoStreams,
      original.videoStreams,
      derivative.videoStreams,
    ),
    check('faststart', derivative.faststart, original.faststart, derivative.faststart),
    check(
      'smaller',
      derivative.bytes < original.bytes * MAX_DERIVATIVE_SIZE_RATIO,
      original.bytes,
      derivative.bytes,
    ),
  ];

  const failed = checks.filter((c) => !c.pass).map((c) => c.name);
  return {
    ok: failed.length === 0,
    checks,
    failed,
    originalFacts: original,
    derivativeFacts: derivative,
  };
}
