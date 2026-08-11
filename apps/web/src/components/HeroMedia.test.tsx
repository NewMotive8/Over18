import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import HeroMedia from './HeroMedia';

describe('HeroMedia', () => {
  it('renders a video-first hero: inline, looping, autoplaying, with a poster', () => {
    const html = renderToStaticMarkup(
      <HeroMedia
        media={{ kind: 'video', src: 'https://cdn.example/luna.mp4', poster: 'https://img/p.png' }}
        alt="Luna"
      />,
    );
    expect(html).toContain('<video');
    expect(html).toContain('src="https://cdn.example/luna.mp4"');
    expect(html).toContain('poster="https://img/p.png"');
    expect(html).toContain('autoplay');
    expect(html).toContain('loop');
    expect(html).toContain('playsinline');
    expect(html).not.toContain('<img');
  });

  it('renders an image hero when the media is an image', () => {
    const html = renderToStaticMarkup(
      <HeroMedia media={{ kind: 'image', src: 'https://img/luna.png' }} alt="Luna" />,
    );
    expect(html).toContain('<img');
    expect(html).toContain('src="https://img/luna.png"');
    expect(html).toContain('alt="Luna"');
    expect(html).not.toContain('<video');
  });

  it('renders an initial-letter placeholder when there is no media', () => {
    const html = renderToStaticMarkup(
      <HeroMedia media={{ kind: 'placeholder', initial: 'L' }} alt="Luna" />,
    );
    expect(html).toContain('>L<');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<video');
  });
});
