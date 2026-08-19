import { describe, it, expect } from 'vitest';
import {
  deriveMediaContext,
  detectMediaRequest,
  FOLLOW_UP_WINDOW_MESSAGES,
  type MediaContextMessage,
  type MediaRequestContext,
} from '@over18/shared';

/**
 * Explicit media-request detection and conversational follow-up (POC).
 *
 * Lives in the web suite because that is where the detector is wired, but the
 * functions are pure and framework-free (packages/shared), so these are plain
 * input→output assertions with no DOM and no network.
 *
 * The bar for a "yes" is deliberately high. A detector that fires on
 * "I like your profile picture" would make the character send pictures at
 * random, which is worse than not triggering at all — so most of what follows
 * is about the NOs.
 */

/** A recent image exchange, one message back. */
const AFTER_IMAGE: MediaRequestContext = { lastMediaType: 'image', messagesSince: 1 };
/** A recent video exchange, one message back. */
const AFTER_VIDEO: MediaRequestContext = { lastMediaType: 'video', messagesSince: 1 };
/** Nothing to refer back to. */
const NO_CONTEXT: MediaRequestContext = { lastMediaType: null };

/* ------------------------------------------------------------------ *
 * 1. Direct requests — no context needed
 * ------------------------------------------------------------------ */

describe('direct image requests', () => {
  it.each([
    'send me a picture',
    'can you send a photo?',
    'send me an image',
    'Can you send me a picture of you?',
    'show me a pic',
    'please send a selfie',
    'could you share a photo with me',
    'show me a different photo',
    'send pics',
    'SEND ME A PICTURE',
  ])('detects image: %s', (text) => {
    expect(detectMediaRequest(text)).toBe('image');
    // A direct request does not depend on context in any way.
    expect(detectMediaRequest(text, NO_CONTEXT)).toBe('image');
    expect(detectMediaRequest(text, AFTER_VIDEO)).toBe('image');
  });
});

describe('direct video requests', () => {
  it.each([
    'can you send me a video?',
    'send me a video',
    'show me a video of you',
    'could you send a clip?',
    'send a vid',
  ])('detects video: %s', (text) => {
    expect(detectMediaRequest(text)).toBe('video');
    expect(detectMediaRequest(text, AFTER_IMAGE)).toBe('video');
  });
});

/* ------------------------------------------------------------------ *
 * 2. Follow-ups — only after a recent media exchange
 * ------------------------------------------------------------------ */

describe('follow-ups that name the kind', () => {
  it('"what about a video?" switches to video', () => {
    expect(detectMediaRequest('what about a video?', AFTER_IMAGE)).toBe('video');
  });

  it('"how about a picture?" switches to image', () => {
    expect(detectMediaRequest('how about a picture?', AFTER_VIDEO)).toBe('image');
  });

  it('"another picture?" stays on image', () => {
    expect(detectMediaRequest('another picture?', AFTER_IMAGE)).toBe('image');
  });

  it('"another video?" after images switches to video', () => {
    expect(detectMediaRequest('another video?', AFTER_IMAGE)).toBe('video');
  });

  it('the named noun always beats the context', () => {
    // This is what makes image↔video switching work at all.
    expect(detectMediaRequest('what about a video?', AFTER_IMAGE)).toBe('video');
    expect(detectMediaRequest('what about a photo?', AFTER_VIDEO)).toBe('image');
  });
});

describe('follow-ups with no noun — type inherited from context', () => {
  it('"send me another one" inherits the last kind', () => {
    expect(detectMediaRequest('send me another one', AFTER_IMAGE)).toBe('image');
    expect(detectMediaRequest('send me another one', AFTER_VIDEO)).toBe('video');
  });

  it.each(['another one?', 'another?', 'one more?', 'any more?', 'send another'])(
    'resolves: %s',
    (text) => {
      expect(detectMediaRequest(text, AFTER_IMAGE)).toBe('image');
    },
  );

  it('needs a request cue or a question mark, so passing mentions stay silent', () => {
    // "another" appears, but this is plainly not a request.
    expect(detectMediaRequest("that's another thing entirely", AFTER_IMAGE)).toBeNull();
    expect(detectMediaRequest('another day another problem', AFTER_IMAGE)).toBeNull();
  });
});

describe('follow-ups require recent context', () => {
  it('the same phrases do NOTHING with no prior media', () => {
    for (const text of ['what about a video?', 'another one?', 'send me another one', 'another?']) {
      expect(detectMediaRequest(text)).toBeNull();
      expect(detectMediaRequest(text, NO_CONTEXT)).toBeNull();
    }
  });

  it('resolves at the edge of the window but not beyond it', () => {
    const atEdge = { lastMediaType: 'image' as const, messagesSince: FOLLOW_UP_WINDOW_MESSAGES - 1 };
    const beyond = { lastMediaType: 'image' as const, messagesSince: FOLLOW_UP_WINDOW_MESSAGES };
    expect(detectMediaRequest('another one?', atEdge)).toBe('image');
    expect(detectMediaRequest('another one?', beyond)).toBeNull();
  });

  it('a DIRECT request still works far outside the window', () => {
    const stale = { lastMediaType: 'image' as const, messagesSince: 999 };
    expect(detectMediaRequest('send me a picture', stale)).toBe('image');
  });
});

/* ------------------------------------------------------------------ *
 * 3. Ordinary conversation must never trigger
 * ------------------------------------------------------------------ */

describe('ordinary messages never trigger', () => {
  it.each([
    'hello',
    'how are you tonight?',
    'tell me about the stars',
    "what's your favourite film?",
    'I had a long day at work',
    '',
  ])('does not trigger: %s', (text) => {
    expect(detectMediaRequest(text)).toBeNull();
    // ...and still does not, even right after a media exchange.
    expect(detectMediaRequest(text, AFTER_IMAGE)).toBeNull();
  });

  it('a media noun with no request cue does not trigger', () => {
    expect(detectMediaRequest('I like your profile picture')).toBeNull();
    expect(detectMediaRequest('that photo of the lake was beautiful')).toBeNull();
    expect(detectMediaRequest('the video game was fun')).toBeNull();
  });

  it('a request cue with no media noun does not trigger', () => {
    expect(detectMediaRequest('did you watch the show?')).toBeNull();
    expect(detectMediaRequest('send me your thoughts')).toBeNull();
    expect(detectMediaRequest('show me what you mean')).toBeNull();
  });

  it('"tell me more" is not a follow-up, even right after media', () => {
    // The single most likely false positive of the anaphoric path.
    expect(detectMediaRequest('tell me more', AFTER_IMAGE)).toBeNull();
    expect(detectMediaRequest('tell me more about yourself', AFTER_IMAGE)).toBeNull();
  });

  it('"what about you?" is not a media follow-up', () => {
    expect(detectMediaRequest('what about you?', AFTER_IMAGE)).toBeNull();
    expect(detectMediaRequest('what about tomorrow?', AFTER_VIDEO)).toBeNull();
  });

  it('past tense is not a request', () => {
    expect(detectMediaRequest('I already sent you a picture')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 4. Negation
 * ------------------------------------------------------------------ */

describe('negation', () => {
  it.each(["don't send me pictures", 'do not send photos please', 'never send me a video'])(
    'suppresses direct request: %s',
    (text) => {
      expect(detectMediaRequest(text)).toBeNull();
      expect(detectMediaRequest(text, AFTER_IMAGE)).toBeNull();
    },
  );

  it('suppresses follow-ups too', () => {
    expect(detectMediaRequest("don't send another one", AFTER_IMAGE)).toBeNull();
    expect(detectMediaRequest('no more pics', AFTER_IMAGE)).toBeNull();
  });

  it('narrow scoping does not swallow a genuine request', () => {
    expect(detectMediaRequest('send me a picture, not a video')).toBe('image');
  });
});

/* ------------------------------------------------------------------ *
 * 5. Determinism and precedence
 * ------------------------------------------------------------------ */

describe('determinism and precedence', () => {
  it('repeated calls agree', () => {
    for (let i = 0; i < 5; i++) {
      expect(detectMediaRequest('send me a picture')).toBe('image');
      expect(detectMediaRequest('another one?', AFTER_VIDEO)).toBe('video');
      expect(detectMediaRequest('hello there')).toBeNull();
    }
  });

  it('when both kinds are named, the first one wins', () => {
    expect(detectMediaRequest('send me a picture or a video')).toBe('image');
    expect(detectMediaRequest('send me a video or a picture')).toBe('video');
  });

  it('repeated identical requests keep resolving (dedupe is the server\'s job)', () => {
    // Detection must not "use up" a request; not repeating an ASSET is handled
    // server-side, and a second ask should still be understood as an ask.
    expect(detectMediaRequest('send me a picture')).toBe('image');
    expect(detectMediaRequest('send me a picture', AFTER_IMAGE)).toBe('image');
    expect(detectMediaRequest('another one?', AFTER_IMAGE)).toBe('image');
  });
});

/* ------------------------------------------------------------------ *
 * 6. deriveMediaContext
 * ------------------------------------------------------------------ */

const user = (content: string): MediaContextMessage => ({ sender: 'user', content });
const bot = (content: string): MediaContextMessage => ({ sender: 'character', content });
const botWith = (type: 'image' | 'video'): MediaContextMessage => ({
  sender: 'character',
  content: 'here you go',
  media: { type },
});

describe('deriveMediaContext', () => {
  it('reports nothing for an empty or media-free conversation', () => {
    expect(deriveMediaContext([])).toEqual({ lastMediaType: null });
    expect(deriveMediaContext([user('hi'), bot('hello')])).toEqual({ lastMediaType: null });
  });

  it('finds media actually attached to a character message', () => {
    const context = deriveMediaContext([user('send me a picture'), botWith('image')]);
    expect(context).toEqual({ lastMediaType: 'image', messagesSince: 0 });
  });

  it("falls back to the user's own request when nothing was attached", () => {
    // The "asked but nothing eligible" case: a follow-up should still work.
    const context = deriveMediaContext([user('send me a picture'), bot('sorry, not right now')]);
    expect(context).toEqual({ lastMediaType: 'image', messagesSince: 1 });
  });

  it('prefers the most recent signal', () => {
    const context = deriveMediaContext([
      user('send me a picture'),
      botWith('image'),
      user('send me a video'),
      botWith('video'),
    ]);
    expect(context.lastMediaType).toBe('video');
    expect(context.messagesSince).toBe(0);
  });

  it('does not look further back than the window', () => {
    const old: MediaContextMessage[] = [botWith('image')];
    for (let i = 0; i < FOLLOW_UP_WINDOW_MESSAGES; i++) old.push(user('chat'), bot('chat'));
    expect(deriveMediaContext(old)).toEqual({ lastMediaType: null });
  });

  it('does not let an inferred follow-up seed the next one', () => {
    // "another one?" is NOT re-detected as a request when scanning history,
    // so a single original request cannot chain indefinitely.
    const context = deriveMediaContext([user('another one?'), bot('hm?')]);
    expect(context).toEqual({ lastMediaType: null });
  });

  it('drives a realistic follow-up end to end', () => {
    const history: MediaContextMessage[] = [
      user('hey'),
      bot('hi there'),
      user('send me a picture'),
      botWith('image'),
    ];
    expect(detectMediaRequest('what about a video?', deriveMediaContext(history))).toBe('video');
    expect(detectMediaRequest('another one?', deriveMediaContext(history))).toBe('image');
    expect(detectMediaRequest('how are you?', deriveMediaContext(history))).toBeNull();
  });
});
