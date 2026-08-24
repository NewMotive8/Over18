import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ClipGridCard from './ClipGridCard';
import type { PublicClip } from '../../lib/api';

/**
 * The search result tile.
 *
 * WHAT IT REPLACED, and what each of these forbids coming back: the grid
 * rendered `PersonaGridCard`, which resolved media through `resolveHeroMedia`
 * and so fell through to the character's canonical reference image, her
 * `profileImage`, or the hard-coded four-name manifest. A character with
 * nothing published still appeared, wearing her identity portrait, and the app
 * presented that portrait as content.
 */

const clip = (id: string, mediaType: 'image' | 'video' = 'video'): PublicClip => ({
  id,
  mediaType,
  url: `/api/media/assets/${id}/file`,
  characterId: `char-${id}`,
  characterName: `Nova ${id}`,
});

const render = (c: PublicClip) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ClipGridCard clip={c} />
    </MemoryRouter>,
  );

describe('a search result is a real CMS content asset', () => {
  it('renders the asset from its own id-keyed public media route', () => {
    const markup = render(clip('abc'));
    expect(markup).toContain('/api/media/assets/abc/file');
  });

  it('renders a VIDEO asset as a video with the shared playback behaviour', () => {
    const markup = render(clip('v', 'video'));
    expect(markup).toContain('<video');
    expect(markup).toContain('autoplay');
    expect(markup).toContain('muted');
    expect(markup).toContain('loop');
    expect(markup).toContain('playsinline');
  });

  it('REFUSES an image content asset — Search is video-only', () => {
    // An approved uploaded image is legitimate content elsewhere in the
    // product. It is not a search result, and this card cannot render one even
    // if a payload carries one.
    const markup = render(clip('i', 'image'));
    expect(markup).toBe('');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('/api/media/assets/i/file');
  });

  it('links to the owning character, so ownership is visible in the markup', () => {
    const markup = render(clip('own'));
    expect(markup).toContain('/characters/char-own');
    expect(markup).toContain('Nova own');
  });

  it('never emits a profile image, a manifest path or a placeholder', () => {
    const markup = render(clip('safe'));
    expect(markup).not.toContain('profileImage');
    expect(markup).not.toContain('img.example');
    expect(markup).not.toContain('/media/luna');
    expect(markup).not.toContain('placehold');
    expect(markup).not.toContain('src=""');
  });

  it('emits a <video> and never an <img>', () => {
    const markup = render(clip('v2', 'video'));
    expect(markup).toContain('<video');
    expect(markup).not.toContain('<img');
  });

  it('every src it emits is the public asset route and nothing else', () => {
    const markup = render(clip('only'));
    const srcs = [...markup.matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) expect(src).toContain('/api/media/assets/');
  });

  it('never reveals a storage key or filesystem path', () => {
    const markup = render(clip('k'));
    expect(markup).not.toContain('storageKey');
    expect(markup).not.toContain('/app/var/media');
  });

  it('keeps the approved grid-card frame, gradient and name treatment', () => {
    const markup = render(clip('p'));
    expect(markup).toContain(
      'group relative block aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900',
    );
    expect(markup).toContain('bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent');
    expect(markup).toContain('flex items-baseline gap-1.5 p-3');
  });

  it('carries NO fabricated NEW/HOT badge', () => {
    // PersonaGridCard derived one from `index % 4` — a decoration invented from
    // position. A clip has no such status, so none is rendered.
    const markup = render(clip('b'));
    expect(markup).not.toContain('Hot');
    expect(markup).not.toContain('New');
  });
});
