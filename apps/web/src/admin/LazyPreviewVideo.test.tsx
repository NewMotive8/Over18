import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LazyPreviewVideo from './LazyPreviewVideo';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('a video tile on a screen that lists many clips', () => {
  it('fetches nothing until it has been on screen, and never starts by itself', () => {
    const html = renderToStaticMarkup(<LazyPreviewVideo src="https://api/clip" className="h-full" />);
    expect(html).not.toContain('src=');
    expect(html).not.toMatch(/autoplay/i);
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('muted');
    expect(html).toContain('playsInline'.toLowerCase());
  });

  it('shows a still once seen, and plays only while pointed at', () => {
    const source = read('./LazyPreviewVideo.tsx');
    expect(source).toContain('src={seen ? `${src}#t=0.1` : undefined}');
    expect(source).toContain('new IntersectionObserver(');
    expect(source).toContain('onMouseEnter=');
    expect(source).toContain('onMouseLeave={(event) => event.currentTarget.pause()}');
  });

  it('the category page draws its library with it, not with autoplaying videos', () => {
    const page = read('../pages/admin/CategoryMerchandisingPage.tsx');
    expect(page).toContain('<LazyPreviewVideo ');
    expect(page).not.toContain('{...TILE_VIDEO_PLAYBACK}');
    expect(page).not.toMatch(/<video\b/);
  });
});
