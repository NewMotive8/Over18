import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MessageMedia, { MESSAGE_MEDIA_CLASS } from './MessageMedia';

/**
 * Media inside a character's chat bubble. Uses the repo's existing node
 * static-rendering setup — no jsdom, no testing-library.
 */

const render = (type: 'image' | 'video', url = '/api/conversations/c1/messages/m1/media') =>
  renderToStaticMarkup(<MessageMedia media={{ type, url }} characterName="Luna" />);

describe('MessageMedia', () => {
  it('renders an image', () => {
    const html = render('image');
    expect(html).toContain('<img');
    expect(html).not.toContain('<video');
    expect(html).toContain('/api/conversations/c1/messages/m1/media');
    expect(html).toContain('alt="Sent by Luna"');
    expect(html).toContain('loading="lazy"');
  });

  it('renders a video with controls', () => {
    const html = render('video');
    expect(html).toContain('<video');
    expect(html).not.toContain('<img');
    expect(html).toContain('controls');
    // React lowercases this attribute in the emitted HTML.
    expect(html).toContain('playsinline');
    expect(html).toContain('preload="metadata"');
  });

  it('preserves aspect ratio: contains, never covers', () => {
    for (const type of ['image', 'video'] as const) {
      const html = render(type);
      expect(html).toContain('object-contain');
      // The regression guarded elsewhere in the app too — media a character
      // deliberately sent must be shown whole, not cropped to a frame.
      expect(html).not.toContain('object-cover');
    }
  });

  it('caps its size so a tall asset cannot take over the conversation', () => {
    expect(MESSAGE_MEDIA_CLASS).toContain('max-h-80');
    expect(MESSAGE_MEDIA_CLASS).toContain('max-w-full');
  });

  it('never forces a fixed width or height that would distort the asset', () => {
    for (const type of ['image', 'video'] as const) {
      const html = render(type);
      expect(html).not.toMatch(/<(img|video)[^>]*\swidth="/);
      expect(html).not.toMatch(/<(img|video)[^>]*\sheight="/);
    }
    // No forced w-full/h-full either: the intrinsic ratio decides the box.
    // Token-wise, not substring-wise — "max-w-full" legitimately contains
    // "w-full" and an earlier version of this test failed on exactly that.
    const tokens = MESSAGE_MEDIA_CLASS.split(/\s+/);
    expect(tokens).not.toContain('w-full');
    expect(tokens).not.toContain('h-full');
  });

  it('uses one fitting rule for both media types', () => {
    expect(render('image')).toContain(MESSAGE_MEDIA_CLASS);
    expect(render('video')).toContain(MESSAGE_MEDIA_CLASS);
  });

  it('renders only the opaque message-scoped url — no asset id or storage hints', () => {
    const html = render('image');
    expect(html).not.toContain('/admin/');
    expect(html).not.toContain('storage');
    expect(html).not.toContain('uploads');
  });
});
