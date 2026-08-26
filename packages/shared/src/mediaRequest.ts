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
 *  1. DIRECT — a media NOUN plus something that makes the message an ASK, and
 *     no context needed:
 *       "send me a picture", "show me a different photo"   (a request CUE)
 *       "can I see a pic?", "got any videos?"              (an asking FRAME)
 *       "pics?"                                            (the noun IS the ask)
 *     Conjunctive on purpose, because either half alone is the common false
 *     positive: "I like your profile picture" (noun, no ask) and "did you watch
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
 *
 * WHY `want|need` ARE HERE. Observed in production: a user wrote "I need to see
 * a picture from you", the detector returned null, no `requestMedia` reached
 * the API, and the character — given no media guidance at all — wrote her own
 * flat refusal. The cue list was built around imperatives (send me, show me)
 * and simply had no verb for the way people more often ask: stating a want
 * rather than issuing an order.
 *
 * TWO VERBS THAT WERE CONSIDERED AND REJECTED, both for the same reason — they
 * describe looking at or possessing media rather than asking for it:
 *
 *   `see` — "did you see that picture?" carries a media noun and would become
 *           a request, which it plainly is not.
 *   `got` — it would catch "have you got a picture?", but English uses `got`
 *           mostly in the past tense, so "I got a picture from my friend" — a
 *           statement of fact — would become a request for one.
 *
 * `want` and `need` do not have that problem: wanting is inherently
 * forward-looking, so there is no past-tense reading to collide with.
 *
 * `wanna` and `gimme` are here for the same reason, and only for that reason:
 * they are spoken contractions of `want to` and `give me`, verbs this list has
 * already accepted. They are not new meanings — leaving them out only meant
 * recognising "give me a pic" and missing "gimme a pic", which is a spelling
 * rule, not an intent rule. Neither has a past-tense reading either.
 *
 * `see` and `got` are still NOT here, for the reasons above. What they get
 * instead is a FRAME (see ASKS_TO_SEE / ASKS_IF_SHE_HAS): the same verbs,
 * admitted only in the grammatical shapes that can only be an ask.
 *
 * THE NOUN REQUIREMENT IS WHAT KEEPS THIS SAFE. A cue alone is never enough —
 * `detectMediaRequest` needs a cue AND a media noun — so "I need coffee",
 * "I want to talk" and "I've got to go" cannot reach the media path.
 */
const REQUEST_CUE = /\b(send|show|share|give|post|want|wanna|need|gimme)\b/i;

/**
 * A negated request. Scoped tightly to negation IMMEDIATELY before the cue, so
 * "send me a picture, not a video" still counts as a request — a loose `not`
 * check would swallow it. Applies to follow-ups too.
 *
 * KEPT IN STEP WITH `REQUEST_CUE`. Every verb that can open a request has to be
 * negatable, or widening the cue list quietly turns "I don't need a picture"
 * into one. The two lists are the same set and must stay that way.
 */
const NEGATED_REQUEST =
  /\b(?:don'?t|do not|never|stop|quit|no)\s+(?:send|show|share|give|post|want|wanna|need|gimme|more)\b/i;

/**
 * The nouns, as alternation SOURCE rather than finished regexes, because three
 * patterns below need the same list and a second copy of it would drift.
 */
const IMAGE_NOUNS = 'pic|pics|picture|pictures|photo|photos|selfie|selfies|image|images';
const VIDEO_NOUNS = 'video|videos|vid|vids|clip|clips';

const IMAGE_NOUN = new RegExp(`\\b(?:${IMAGE_NOUNS})\\b`, 'i');
const VIDEO_NOUN = new RegExp(`\\b(?:${VIDEO_NOUNS})\\b`, 'i');

/**
 * ASKING FRAMES — the same rejected verbs, admitted by GRAMMAR.
 *
 * The cue list is a vocabulary test, and `see` and `got` fail it because each
 * has an innocent reading that carries a media noun along with it. But the
 * innocent readings are not shaped like an ask, and that is the thing worth
 * matching. A frame is a cue verb plus the surrounding words that fix WHO is
 * doing it, to WHOM, and WHEN — which is exactly what the vocabulary test
 * throws away.
 *
 * ASKS_TO_SEE — the speaker asking to be shown, right now.
 *   yes: "can I see a pic?", "could we see a photo", "let me see a picture",
 *        "lemme see a vid"
 *   no:  "did you see that picture?"  — subject is `you`, and `did` is past
 *        "I saw your photo"           — `saw`, which this cannot match at all
 *        "can you see the picture?"   — asking about HER eyes, not her media
 *        "you should see the video"   — no modal+`I`, no let-me
 *
 * `wanna see` / `want to see` / `need to see` are deliberately NOT here: they
 * are already requests because of `wanna`/`want`/`need`, exactly as the cue
 * list's docblock says. Duplicating them here would put the same phrase behind
 * two rules and make the next edit ambiguous.
 */
const ASKS_TO_SEE =
  /\b(?:can|could|may|will|would)\s+(?:i|we)\s+(?:please\s+)?see\b|\b(?:let\s+me|lemme)\s+see\b/i;

/**
 * ASKS_IF_SHE_HAS, part one — "any" does the work, but only about HER.
 *
 * `got any` / `have any` is a question about AVAILABILITY, so it needs no
 * question mark to be safe. It does need a subject, though: the same words
 * with a first-person subject are a denial rather than a request, and
 * "I don't have any pictures" must not send one. So the phrase has to either
 * OPEN the message — the elided "[have you] got any pics?" — or name her.
 *   yes: "got any pics?", "do you have any videos", "have you got any photos",
 *        "u got any vids?"
 *   no:  "I don't have any pictures", "she doesn't have any photos",
 *        "I got a picture from my friend", "she got some photos developed"
 */
const ASKS_IF_SHE_HAS_ANY = /^\s*(?:got|have)\s+any\b|\b(?:u|you)\s+(?:got|have)\s+any\b/i;

/**
 * ASKS_IF_SHE_HAS, part two — second person, and only as a QUESTION.
 *
 * "you got a pic" and "you got a nice picture there" are the same words with
 * opposite intent, so this half is admitted only when the message is actually
 * asking something. The question mark is the disambiguator, and it is the
 * user's own punctuation rather than an inference about them.
 *   yes: "you got a selfie?", "u got any vids?", "have you got a photo?",
 *        "do you have a video?"
 *   no:  "you got a nice picture there"  — a compliment, and not a question
 *        "I got your video message"      — first person
 *        "did you get my picture?"       — `get`, not `got`
 *        "did you have fun with that video?" — `did`, past, and not about her
 *                                              having one now
 */
const ASKS_IF_SHE_HAS_ONE = /\bdo\s+you\s+have\b|\bhave\s+you\s+got\b|\b(?:u|you)\s+got\b/i;

/**
 * THE NOUN IS THE WHOLE MESSAGE — "pics?", "any video?".
 *
 * Anchored end to end on purpose. A bare noun is only unambiguous when there
 * is nothing else in the message to give it another job: "pics?" can only be
 * an ask, while "that's a nice picture" and "did you see that picture?" both
 * contain a noun and a great deal else. The question mark is required, so a
 * one-word remark ("pics") stays silent.
 */
const BARE_NOUN_ASK = new RegExp(
  `^(?:any|some|a|an|the)?\\s*(?:${IMAGE_NOUNS}|${VIDEO_NOUNS})\\s*\\?+$`,
  'i',
);

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

/**
 * True when the message is shaped like an ask without using a cue verb.
 *
 * Kept separate from REQUEST_CUE because the two answer different questions —
 * "is there an asking WORD here?" versus "is this sentence an asking SHAPE?" —
 * and only the second one can safely involve `see` or `got`.
 */
function asksWithoutACue(normalized: string): boolean {
  if (ASKS_TO_SEE.test(normalized)) return true;
  if (ASKS_IF_SHE_HAS_ANY.test(normalized)) return true;
  // Second-person `got` is a request only when it is a question. See above.
  if (ASKS_IF_SHE_HAS_ONE.test(normalized) && normalized.trimEnd().endsWith('?')) return true;
  return false;
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
  //    A cue verb OR an asking frame; the media noun is required either way.
  if (noun && (REQUEST_CUE.test(normalized) || asksWithoutACue(normalized))) return noun;

  // 1b. The message is nothing but the noun and a question mark: "pics?".
  //     Also direct, because there is no other reading of it.
  if (noun && BARE_NOUN_ASK.test(normalized.trim())) return noun;

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
