import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MessageMedia, { MESSAGE_MEDIA_CLASS } from './MessageMedia';
import MediaViewer from './MediaViewer';

/**
 * Media inside a character's chat bubble. Uses the repo's existing node
 * static-rendering setup — no jsdom, no testing-library.
 *
 * WHAT THESE CAN AND CANNOT DO. Static rendering shows the markup of the
 * initial render, so they can prove the image is a real control that opens a
 * dialog, and that the viewer renders the whole image when it is open. They
 * cannot fire a click, so the state transition itself is asserted by rendering
 * the viewer directly with the props MessageMedia passes it.
 */

const render = (type: 'image' | 'video', url = '/api/conversations/c1/messages/m1/media') =>
  renderToStaticMarkup(<MessageMedia media={{ type, url }} characterName="Luna" />);

describe('MessageMedia — inline rendering', () => {
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
    expect(html).toContain('playsinline');
    expect(html).toContain('preload="metadata"');
  });

  it('preserves aspect ratio: contains, never covers', () => {
    for (const type of ['image', 'video'] as const) {
      const html = render(type);
      expect(html).toContain('object-contain');
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

/* ------------------------------------------------------------------ *
 * The reported bug: images were not interactive
 * ------------------------------------------------------------------ */

describe('MessageMedia — image is interactive', () => {
  it('wraps the image in a real button', () => {
    // The regression: the image used to render bare, so tapping it did
    // nothing while video had the browser's own full-screen control.
    const html = render('image');
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    // The button wraps the image, so the whole photo is the tap target.
    expect(html).toMatch(/<button[^>]*>\s*<img/);
  });

  it('announces itself as opening a full-screen dialog', () => {
    const html = render('image');
    expect(html).toContain('aria-label="View photo from Luna full screen"');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it('signals interactivity to a pointer', () => {
    expect(render('image')).toContain('cursor-zoom-in');
  });

  it('does not render the viewer until it is opened', () => {
    // Closed by default — the bubble must not ship a hidden full-screen layer.
    const html = render('image');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
  });

  it('leaves VIDEO exactly as it was — no button, no wrapper', () => {
    // Video already had a full-screen path via its native controls; routing it
    // through the viewer would have removed playback controls entirely.
    const html = render('video');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-haspopup');
    expect(html).toMatch(/^<video/); // still the root element, unwrapped
  });
});

/* ------------------------------------------------------------------ *
 * The viewer it opens — rendered with the props MessageMedia passes
 * ------------------------------------------------------------------ */

const chatViewer = (src = 'http://localhost:3001/api/conversations/c1/messages/m1/media') =>
  renderToStaticMarkup(
    <MediaViewer
      items={[{ id: 'm1', media: { kind: 'image', src }, premium: false }]}
      startIndex={0}
      label="Luna"
      onClose={() => {}}
      fit="contain"
    />,
  );

describe('the full-screen viewer opened from chat', () => {
  it('is the existing MediaViewer — a full-screen modal dialog', () => {
    const html = chatViewer();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('fixed inset-0');
    expect(html).toContain('Close media viewer');
  });

  it('shows the whole image, not a crop', () => {
    const html = chatViewer();
    expect(html).toContain('object-contain');
    expect(html).not.toContain('object-cover');
    // The gallery's fixed 4/5 frame and its clipping are both gone.
    expect(html).not.toContain('aspect-[4/5]');
    expect(html).not.toContain('overflow-hidden rounded-2xl');
  });

  it('renders the same message-scoped url the bubble used', () => {
    expect(chatViewer()).toContain('/api/conversations/c1/messages/m1/media');
  });

  it('shows no paging controls for a single item', () => {
    const html = chatViewer();
    expect(html).not.toContain('aria-label="Next"');
    expect(html).not.toContain('aria-label="Previous"');
  });
});

describe('the gallery viewer is unchanged', () => {
  const galleryViewer = () =>
    renderToStaticMarkup(
      <MediaViewer
        items={[{ id: 'g1', media: { kind: 'image', src: 'https://img/x.png' }, premium: false }]}
        startIndex={0}
        label="Luna"
        onClose={() => {}}
      />,
    );

  it('still crops to its fixed 4/5 frame by default', () => {
    // `fit` defaults to cover, so the character gallery is untouched by this fix.
    const html = galleryViewer();
    expect(html).toContain('aspect-[4/5]');
    expect(html).toContain('object-cover');
    expect(html).not.toContain('object-contain');
  });
});
