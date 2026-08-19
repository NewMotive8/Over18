/**
 * Explicit media-request detection, with conversational follow-up (POC).
 *
 * SCOPE, DELIBERATELY NARROW. This is not the keyword/semantic ranking system
 * planned in the later media-selection phase — it never scores or chooses an
 * ASSET. It answers one question: did the person ask to be sent a picture or a
 * video, either outright or as a follow-up to one they just asked for?
 *
 * It decides only the media TYPE. The server still selects the asset from its
 * own eligibility rules, so the worst a wrong detection can do is ask for a
 * kind that is not eligible, which degrades to an ordinary text reply.
 *
 * TWO WAYS TO ASK
 *
 *  1. DIRECT — a request CUE and a media NOUN, both present, no context needed:
 *       "send me a picture", "show me a different photo"
 *     Conjunctive on purpose, because either half alone is the common false
 *     positive: "I like your profile picture" (noun, no cue) and "did you watch
 *     the show?" (cue, no noun) must both stay silent.
 *
 *  2. FOLLOW-UP — only meaningful just after a media exchange, and only inside
 *     a short window of recent messages:
 *       "what about a video?"      cue + noun, type from the noun
 *       "another picture?"         cue + noun, type from the noun
 *       "send me another one"      no noun at all, type INHERITED from context
 *       "another one?"             no noun at all, type INHERITED from context
 *
 * The window matters. Without it, "another one?" forty messages after a photo
 * would silently send a picture. With it, a follow-up only resolves while the
 * subject is plausibly still the media.
 */

export type MediaRequestType = 'image' | 'video';

/**
 * What the conversation was recently doing, so a follow-up has something to
 * refer to. Derived from the message list by deriveMediaContext — there is no
 * hidden session state to get out of sync, and it survives a page reload.
 */
export interface MediaRequestContext {
  /** The media type of the most recent media exchange, if any. */
  lastMediaType?: MediaRequestType | null;
  /** How many messages back that was. 0 = the immediately previous message. */
  messagesSince?: number;
}

/**
 * How many messages a follow-up may reach back. Six is roughly three
 * exchanges — long enough for "what about a video?" after a reply or two,
 * short enough that the subject has plausibly not moved on.
 */
export const FOLLOW_UP_WINDOW_MESSAGES = 6;

/**
 * Asking to be given something. `\bsend\b` deliberately does not match "sent",
 * so "I already sent you a picture" is not a request.
 */
const REQUEST_CUE = /\b(send|show|share|give|post)\b/i;

/**
 * A negated request. Scoped tightly to negation IMMEDIATELY before the cue, so
 * "send me a picture, not a video" still counts as a request — a loose `not`
 * check would swallow it. Applies to follow-ups too.
 */
const NEGATED_REQUEST =
  /\b(?:don'?t|do not|never|stop|quit|no)\s+(?:send|show|share|give|post|more)\b/i;

const IMAGE_NOUN = /\b(pic|pics|picture|pictures|photo|photos|selfie|selfies|image|images)\b/i;
const VIDEO_NOUN = /\b(video|videos|vid|vids|clip|clips)\b/i;

/**
 * "More of that" phrasing. Used ONLY when a media noun is also present, so
 * "what about dinner?" cannot reach the media path.
 */
const FOLLOW_UP_CUE =
  /\b(another|one more|any more|some more|different|what about|how about|instead)\b/i;

/**
 * Stands in for the noun itself — "another one", with no picture/video said.
 * Narrower than FOLLOW_UP_CUE because there is no noun to disambiguate: this
 * is the only path where the type comes from context rather than the words.
 */
const ANAPHORIC_CUE = /\b(another one|another|one more|any more|some more)\b/i;

/** First-mentioned noun wins when a message names both kinds. */
function nounType(normalized: string): MediaRequestType | null {
  const image = normalized.search(IMAGE_NOUN);
  const video = normalized.search(VIDEO_NOUN);
  if (image === -1 && video === -1) return null;
  if (image === -1) return 'video';
  if (video === -1) return 'image';
  return image < video ? 'image' : 'video';
}

/** True while a recent media exchange is close enough to refer back to. */
function withinFollowUpWindow(context?: MediaRequestContext): boolean {
  if (!context?.lastMediaType) return false;
  const since = context.messagesSince ?? 0;
  return since >= 0 && since < FOLLOW_UP_WINDOW_MESSAGES;
}

/**
 * The media type explicitly requested, or null.
 *
 * Deterministic: same input and same context always give the same answer, with
 * no clock, no randomness and no network.
 */
export function detectMediaRequest(
  text: string,
  context?: MediaRequestContext,
): MediaRequestType | null {
  if (!text) return null;
  const normalized = text.toLowerCase();

  if (NEGATED_REQUEST.test(normalized)) return null;

  const noun = nounType(normalized);

  // 1. Direct request — stands on its own, no conversational context needed.
  if (REQUEST_CUE.test(normalized) && noun) return noun;

  // Everything below is follow-up territory and needs a recent media exchange.
  if (!withinFollowUpWindow(context)) return null;

  // 2. Follow-up naming the kind: "what about a video?", "another picture?".
  //    The noun wins over the context, which is what makes switching work.
  if (noun && (FOLLOW_UP_CUE.test(normalized) || REQUEST_CUE.test(normalized))) {
    return noun;
  }

  // 3. Follow-up with no noun: "send me another one", "another one?".
  //    Requires a request cue or a question mark, so a passing "another" in
  //    ordinary conversation ("that's another thing") cannot reach here.
  if (ANAPHORIC_CUE.test(normalized)) {
    const asks = REQUEST_CUE.test(normalized) || text.trim().endsWith('?');
    if (asks) return context!.lastMediaType!;
  }

  return null;
}

/**
 * Minimal structural shape of a chat message — declared here rather than
 * imported so this module stays dependency-free and cannot create an import
 * cycle with the package index. `ChatMessage[]` satisfies it.
 */
export interface MediaContextMessage {
  sender: 'user' | 'character';
  content: string;
  media?: { type: MediaRequestType } | undefined;
}

/**
 * Reads recent conversation and reports what a follow-up would refer to.
 *
 * Two things count as "the conversation was just doing media", newest first:
 *   - a character message that actually CARRIES media, and
 *   - a user message that was itself a direct media request.
 *
 * The second matters because a request whose asset was not eligible attaches
 * nothing — and "another one?" after that should still make sense.
 *
 * Pure and derived from the message list, so there is no session state to fall
 * out of sync and it behaves identically after a page reload.
 */
export function deriveMediaContext(
  messages: readonly MediaContextMessage[],
): MediaRequestContext {
  const limit = Math.min(messages.length, FOLLOW_UP_WINDOW_MESSAGES);
  for (let i = 0; i < limit; i++) {
    const message = messages[messages.length - 1 - i]!;

    if (message.media?.type) {
      return { lastMediaType: message.media.type, messagesSince: i };
    }
    if (message.sender === 'user') {
      // Context-free detection only: never let one inferred follow-up seed the
      // next, or a single request could chain indefinitely down the history.
      const requested = detectMediaRequest(message.content);
      if (requested) return { lastMediaType: requested, messagesSince: i };
    }
  }
  return { lastMediaType: null };
}
