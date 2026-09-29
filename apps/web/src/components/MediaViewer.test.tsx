import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MediaViewer from './MediaViewer';
import type { CharacterMediaItem } from '../lib/media';

const free: CharacterMediaItem[] = [
  { id: 'a', media: { kind: 'image', src: 'https://img/a.png' }, premium: false },
  { id: 'b', media: { kind: 'image', src: 'https://img/b.png' }, premium: false },
];

describe('MediaViewer', () => {
  it('renders a modal showing the start item with paging controls', () => {
    const html = renderToStaticMarkup(
      <MediaViewer items={free} startIndex={0} label="Luna" onClose={() => {}} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('src="https://img/a.png"');
    expect(html).toContain('aria-label="Close media viewer"');
    expect(html).toContain('aria-label="Next"');
    expect(html).toContain('1 / 2');
  });

  /* ---------------------------------------------------------------- *
   * videoFit: her clips open whole, her images do not move
   * ---------------------------------------------------------------- */

  const video = (id = 'v'): CharacterMediaItem => ({
    id,
    media: { kind: 'video', src: `https://vid/${id}.mp4` },
    premium: false,
  });

  /**
   * THE CONTAINER AND THE MEDIA HAVE TO AGREE.
   *
   * The two fits are different BOXES, not just different `object-fit` values:
   * `cover` is a fixed `aspect-[4/5]` with `overflow-hidden`. Contained media
   * inside that box is still cropped, so every test here asserts the box as well
   * as the fit -- checking only `object-contain` would pass while the video was
   * still being cut off.
   */
  const CONTAIN_BOX = 'h-[85vh] w-full max-w-3xl';
  const COVER_BOX = 'aspect-[4/5] w-full max-w-md overflow-hidden rounded-2xl';

  it('opens a VIDEO whole, in the contain box, when videoFit says so', () => {
    const html = renderToStaticMarkup(
      <MediaViewer items={[video()]} startIndex={0} label="Luna" onClose={() => {}} videoFit="contain" />,
    );
    expect(html).toContain('<video');
    expect(html).toContain('object-contain');
    expect(html, 'the box must drop the fixed 4/5 crop too').toContain(CONTAIN_BOX);
    expect(html).not.toContain(COVER_BOX);
  });

  it('leaves an IMAGE in its 4/5 frame in the same viewer', () => {
    const html = renderToStaticMarkup(
      <MediaViewer items={free} startIndex={0} label="Luna" onClose={() => {}} videoFit="contain" />,
    );
    expect(html).toContain('<img');
    expect(html).toContain('object-cover');
    expect(html, 'images keep the frame they have always had').toContain(COVER_BOX);
    expect(html).not.toContain('object-contain');
  });

  /** Paging between the two kinds re-decides per item, not per session. */
  it('applies the fit per ITEM, not once for the whole gallery', () => {
    const mixed = [free[0]!, video('v2')];
    const onImage = renderToStaticMarkup(
      <MediaViewer items={mixed} startIndex={0} label="Luna" onClose={() => {}} videoFit="contain" />,
    );
    const onVideo = renderToStaticMarkup(
      <MediaViewer items={mixed} startIndex={1} label="Luna" onClose={() => {}} videoFit="contain" />,
    );
    expect(onImage).toContain(COVER_BOX);
    expect(onImage).toContain('object-cover');
    expect(onVideo).toContain(CONTAIN_BOX);
    expect(onVideo).toContain('object-contain');
  });

  /**
   * EVERY EXISTING CALLER MUST BE BYTE-IDENTICAL. `videoFit` is undefined for
   * all of them, so a video still follows `fit` exactly as it did before.
   */
  it('changes nothing when videoFit is not supplied', () => {
    const without = renderToStaticMarkup(
      <MediaViewer items={[video()]} startIndex={0} label="Luna" onClose={() => {}} />,
    );
    expect(without).toContain(COVER_BOX);
    expect(without).toContain('object-cover');
    expect(without).not.toContain('object-contain');
  });

  /** Chat's explicit fit="contain" is not overridden by the new prop's absence. */
  it("respects a caller's explicit fit=contain for video", () => {
    const html = renderToStaticMarkup(
      <MediaViewer items={[video()]} startIndex={0} label="Luna" onClose={() => {}} fit="contain" />,
    );
    expect(html).toContain(CONTAIN_BOX);
    expect(html).toContain('object-contain');
  });

  it('renders nothing when there are no items', () => {
    const html = renderToStaticMarkup(
      <MediaViewer items={[]} startIndex={0} label="Luna" onClose={() => {}} />,
    );
    expect(html).toBe('');
  });
});
