import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PostsTab from './PostsTab';
import type { PublicClip } from '../../lib/api';

/**
 * The Posts tab is the character's REAL content collection.
 *
 * WHAT IT USED TO BE, and what each of these tests forbids coming back: a
 * hard-coded four-name manifest, `slice(0, 2)` accessible tiles,
 * `Array.from({ length: 6 })` fabricated locked tiles recycling whatever poster
 * was to hand, and `character.profileImage` as the fallback. The tab claimed
 * "8" because 2 + 6 = 8, and not one tile corresponded to a record.
 */

const clip = (id: string, mediaType: 'image' | 'video' = 'video'): PublicClip => ({
  id,
  mediaType,
  url: `/api/media/assets/${id}/file`,
  characterId: 'char-1',
  characterName: 'Nova',
});

const render = (clips: PublicClip[]) =>
  renderToStaticMarkup(<PostsTab clips={clips} onOpenClip={() => {}} />);

describe('the Posts tab renders the real collection', () => {
  it('renders one tile per returned asset — twelve means twelve', () => {
    const clips = Array.from({ length: 12 }, (_, i) => clip(`a${i}`));
    const markup = render(clips);
    // Every asset id appears exactly once, in its own media element.
    for (const c of clips) expect(markup).toContain(`/api/media/assets/${c.id}/file`);
    expect(markup.match(/aspect-\[3\/4\]/g)).toHaveLength(12);
  });

  it('applies no limit of 8', () => {
    expect(render(Array.from({ length: 12 }, (_, i) => clip(`b${i}`))).match(/aspect-\[3\/4\]/g))
      .toHaveLength(12);
    // And the old slice(0, 2) is gone too.
    expect(render([clip('x'), clip('y'), clip('z')]).match(/aspect-\[3\/4\]/g)).toHaveLength(3);
  });

  it('fabricates NO locked tiles', () => {
    const markup = render([clip('only')]);
    expect(markup.match(/aspect-\[3\/4\]/g)).toHaveLength(1);
    // The old paywall zone's fingerprints.
    expect(markup).not.toContain('blur-2xl');
    expect(markup).not.toContain('Go Premium');
    expect(markup).not.toContain('exclusive photos');
  });

  it('NEVER falls back to a profile or reference image', () => {
    // Nothing but the asset routes may appear as media.
    const markup = render([clip('real')]);
    const srcs = [...markup.matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) expect(src).toContain('/api/media/assets/');
    expect(markup).not.toContain('profileImage');
    expect(markup).not.toContain('/media/luna');
    expect(markup).not.toContain('placehold.co');
  });

  it('renders no empty src when there is nothing to show', () => {
    // The old tab produced <img src=""> for a character with no manifest entry.
    const markup = render([]);
    expect(markup).not.toContain('src=""');
    expect(markup).toContain('No posts yet');
  });

  it('uses the shared clip playback for video: autoplay, muted, loop, playsInline', () => {
    const markup = render([clip('vid', 'video')]);
    expect(markup).toContain('<video');
    expect(markup).toContain('autoplay');
    expect(markup).toContain('muted');
    expect(markup).toContain('loop');
    expect(markup).toContain('playsinline');
  });

  it('renders an image CONTENT asset as an image, from its own asset route', () => {
    const markup = render([clip('pic', 'image')]);
    expect(markup).toContain('<img');
    expect(markup).toContain('/api/media/assets/pic/file');
  });

  it('keeps the approved tile presentation', () => {
    // Same grid, same frame, same gradient as the approved design.
    const markup = render([clip('a'), clip('b')]);
    expect(markup).toContain('grid grid-cols-2 gap-3');
    expect(markup).toContain(
      'group relative block aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900',
    );
    expect(markup).toContain('bg-gradient-to-t from-black/70 to-transparent');
  });
});

/**
 * The bottom-left heart.
 *
 * It is approved presentation and must stay, in the same corner with the same
 * styling. What must NOT come back is the number that used to sit beside it:
 * `240 + index * 57` — the tile's position dressed up as engagement. There is
 * no likes column and no reactions table, so any number here is fabricated.
 */
describe('the Posts tile keeps the approved heart mark and no fake count', () => {
  // The badge span, from `<span aria-hidden` through its closing tag. The inner
  // <svg> closes with </svg>, so a non-greedy match to </span> is exact.
  const BADGE = /<span aria-hidden="true" class="([^"]*)">(.*?)<\/span>/g;
  const badges = (markup: string) => [...markup.matchAll(BADGE)];

  it('renders the heart on every tile, in the approved position and styling', () => {
    const markup = render([clip('a'), clip('b'), clip('c')]);
    const found = badges(markup);
    expect(found).toHaveLength(3);
    for (const [, className] of found) {
      // Byte-identical to the approved baseline's badge container.
      expect(className).toBe(
        'absolute bottom-2 left-2 flex items-center gap-1 text-[11px] font-semibold text-white',
      );
    }
    // The filled-heart path from LikeIcon, three times — one per tile.
    expect(markup.match(/M12 20\.3S3\.5 15/g)).toHaveLength(3);
    expect(markup).toContain('h-3.5 w-3.5 text-rose-400');
  });

  it('renders NO number beside the heart', () => {
    const markup = render(Array.from({ length: 5 }, (_, i) => clip(`n${i}`)));
    for (const [, , inner] of badges(markup)) {
      // Strip the <svg> and its children; whatever text remains is a claim
      // about engagement, and there is no data to back one.
      expect(inner.replace(/<[^>]*>/g, '').trim()).toBe('');
    }
    // The exact fabricated series `240 + i * 57`, which must never return.
    for (const fake of ['240', '297', '354', '411', '468']) {
      expect(markup).not.toContain(`>${fake}<`);
      expect(markup).not.toContain(` ${fake}<`);
    }
  });

  it('shows no heart when there are no posts', () => {
    // No tiles means no marks — the empty state stays a plain sentence.
    const markup = render([]);
    expect(badges(markup)).toHaveLength(0);
    expect(markup).not.toContain('text-rose-400');
  });

  it('never reveals a storage key or filesystem path', () => {
    const markup = render([clip('safe')]);
    expect(markup).not.toContain('storageKey');
    expect(markup).not.toContain('/app/var/media');
  });
});
