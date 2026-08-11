import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MediaGallery from './MediaGallery';
import type { CharacterMediaItem } from '../lib/media';

const items: CharacterMediaItem[] = [
  { id: 'hero', media: { kind: 'image', src: 'https://img/hero.png' }, premium: false },
  { id: 'p1', media: { kind: 'image', src: 'https://img/x.png' }, premium: true, mock: true },
  { id: 'p2', media: { kind: 'image', src: 'https://img/x.png' }, premium: true, mock: true },
];

describe('MediaGallery', () => {
  it('renders a media grid with a premium count and lock affordances', () => {
    const html = renderToStaticMarkup(
      <MediaGallery items={items} onOpenFree={() => {}} onLocked={() => {}} />,
    );
    expect(html).toContain('Media');
    expect(html).toContain('2 premium');
    // free tile is a plain "View media" control; locked tiles are labelled + blurred
    expect(html).toContain('aria-label="View media"');
    expect(html).toContain('unlock with Premium');
    expect(html).toContain('blur-md');
    expect(html).toContain('no payments are enabled');
  });
});
