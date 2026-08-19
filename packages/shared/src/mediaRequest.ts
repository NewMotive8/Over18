/**
 * Explicit media-request detection (POC).
 *
 * SCOPE, DELIBERATELY NARROW. This is not the keyword/semantic ranking system
 * planned in the later media-selection phase. It answers one question with a
 * pure function and no model involvement: did the person plainly ask to be
 * SENT a picture or a video? Anything less than plain is a "no".
 *
 * It decides only the media TYPE the request asks for. It never chooses an
 * asset — the server still does that, from its own eligibility rules — so the
 * worst a wrong detection can do is ask for a kind of media that then isn't
 * eligible, which degrades to an ordinary text reply.
 *
 * The rule is conjunctive on purpose: a request CUE and a media NOUN must both
 * be present. Either alone is the common false positive —
 *   "I like your profile picture"  (noun, no cue)
 *   "did you watch the show?"      (cue word, no noun)
 * and both of those must stay silent.
 */

export type MediaRequestType = 'image' | 'video';

/**
 * Asking to be given something. `\bsend\b` deliberately does not match "sent",
 * so "I already sent you a picture" is not a request.
 */
const REQUEST_CUE = /\b(send|show|share|give|post)\b/i;

/**
 * A negated request. Scoped tightly to negation IMMEDIATELY before the cue, so
 * "send me a picture, not a video" still counts as a request — a loose `not`
 * check would swallow it.
 */
const NEGATED_REQUEST = /\b(?:don'?t|do not|never|stop|quit)\s+(?:send|show|share|give|post)\b/i;

const IMAGE_NOUN = /\b(pic|pics|picture|pictures|photo|photos|selfie|selfies|image|images)\b/i;
const VIDEO_NOUN = /\b(video|videos|vid|vids|clip|clips)\b/i;

/**
 * The media type explicitly requested, or null.
 *
 * Deterministic: same input always gives the same answer, with no clock, no
 * randomness and no network. When a message names both kinds, the one that
 * appears FIRST wins — an arbitrary rule, but a fixed and testable one.
 */
export function detectMediaRequest(text: string): MediaRequestType | null {
  if (!text) return null;
  const normalized = text.toLowerCase();

  if (NEGATED_REQUEST.test(normalized)) return null;
  if (!REQUEST_CUE.test(normalized)) return null;

  const image = normalized.search(IMAGE_NOUN);
  const video = normalized.search(VIDEO_NOUN);

  if (image === -1 && video === -1) return null;
  if (image === -1) return 'video';
  if (video === -1) return 'image';
  return image < video ? 'image' : 'video';
}
