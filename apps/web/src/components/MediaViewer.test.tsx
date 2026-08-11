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

  it('renders nothing when there are no items', () => {
    const html = renderToStaticMarkup(
      <MediaViewer items={[]} startIndex={0} label="Luna" onClose={() => {}} />,
    );
    expect(html).toBe('');
  });
});
