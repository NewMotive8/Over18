import { describe, it, expect } from 'vitest';
import { detectMediaRequest } from '@over18/shared';

/**
 * Explicit media-request detection (POC).
 *
 * Lives in the web suite because that is where the detector is wired, but the
 * function itself is pure and framework-free (packages/shared), so these are
 * plain input→output assertions with no DOM and no network.
 *
 * The bar is deliberately high for a "yes": a request cue AND a media noun.
 * Most of these tests are about the NOs — a detector that fires on
 * "I like your profile picture" would make the character send pictures at
 * random, which is worse than not triggering at all.
 */

describe('detectMediaRequest — explicit image requests', () => {
  it.each([
    'send me a picture',
    'can you send a photo?',
    'send me an image',
    'Can you send me a picture of you?',
    'show me a pic',
    'please send a selfie',
    'could you share a photo with me',
    'send pics',
    'SEND ME A PICTURE',
  ])('detects image: %s', (text) => {
    expect(detectMediaRequest(text)).toBe('image');
  });
});

describe('detectMediaRequest — explicit video requests', () => {
  it.each([
    'can you send me a video?',
    'send me a video',
    'show me a video of you',
    'could you send a clip?',
    'send a vid',
  ])('detects video: %s', (text) => {
    expect(detectMediaRequest(text)).toBe('video');
  });
});

describe('detectMediaRequest — ordinary messages never trigger', () => {
  it.each([
    'hello',
    'how are you tonight?',
    'tell me about the stars',
    "what's your favourite film?",
    'I had a long day at work',
    '',
  ])('does not trigger: %s', (text) => {
    expect(detectMediaRequest(text)).toBeNull();
  });

  it('a media noun with no request cue does not trigger', () => {
    // The most likely false positive in real conversation.
    expect(detectMediaRequest('I like your profile picture')).toBeNull();
    expect(detectMediaRequest('that photo of the lake was beautiful')).toBeNull();
    expect(detectMediaRequest('the video game was fun')).toBeNull();
  });

  it('a request cue with no media noun does not trigger', () => {
    expect(detectMediaRequest('did you watch the show?')).toBeNull();
    expect(detectMediaRequest('send me your thoughts')).toBeNull();
    expect(detectMediaRequest('show me what you mean')).toBeNull();
  });

  it('past tense is not a request', () => {
    // "sent" must not match the \bsend\b cue.
    expect(detectMediaRequest('I already sent you a picture')).toBeNull();
  });

  it('a negated request does not trigger', () => {
    expect(detectMediaRequest("don't send me pictures")).toBeNull();
    expect(detectMediaRequest('do not send photos please')).toBeNull();
    expect(detectMediaRequest('never send me a video')).toBeNull();
  });
});

describe('detectMediaRequest — determinism and precedence', () => {
  it('is deterministic: repeated calls agree', () => {
    for (let i = 0; i < 5; i++) {
      expect(detectMediaRequest('send me a picture')).toBe('image');
      expect(detectMediaRequest('send me a video')).toBe('video');
      expect(detectMediaRequest('hello there')).toBeNull();
    }
  });

  it('when both kinds are named, the first one wins', () => {
    expect(detectMediaRequest('send me a picture or a video')).toBe('image');
    expect(detectMediaRequest('send me a video or a picture')).toBe('video');
  });

  it('narrow negation does not swallow a genuine request', () => {
    // "not" appears, but it does not negate the request itself.
    expect(detectMediaRequest('send me a picture, not a video')).toBe('image');
  });
});
