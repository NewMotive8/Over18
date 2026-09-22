import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tile } from './ContentLibraryPage';
import { TILE_MEDIA_CLASS, tileFrameClass } from '../../lib/mediaTile';
import type { LibraryAssetView } from '../../lib/api';

/**
 * Media-tile fitting on the two admin content screens (Library and Review).
 *
 * Uses the repo's existing node-environment static rendering — no jsdom, no
 * testing-library. Real layout cannot be measured without a browser, so these
 * assert the CSS CONTRACT that produces it: one fixed frame per tile, and
 * media fitted with object-contain so nothing is cropped or stretched.
 *
 * The regression is real and was shipped: both grids used object-cover, which
 * silently cropped portrait assets — on the Review queue that meant approving
 * or rejecting an asset by looking at a crop of it.
 */

const asset = (over: Partial<LibraryAssetView> = {}): LibraryAssetView => ({
  assetId: 'asset-1',
  characterId: 'char-1',
  characterName: 'luna',
  mediaType: 'image',
  status: 'approved',
  role: 'content',
  origin: 'manual',
  workflow: 'approved',
  actions: ['publish', 'archive'],
  contentRating: 'sfw',
  requirementKey: null,
  isPrimary: false,
  previewUrl: '/admin/content/assets/asset-1/file',
  createdAt: '2026-08-18T10:00:00.000Z',
  approvedAt: '2026-08-18T10:05:00.000Z',
  publishedAt: null,
  archivedAt: null,
  recencyBasis: 'approved',
  recentAt: '2026-08-18T10:05:00.000Z',
  provenance: { jobId: null, provider: null, model: null, generatedAt: null },
  ...over,
});

const render = (a: LibraryAssetView, dense?: boolean) =>
  renderToStaticMarkup(<Tile a={a} onOpen={() => {}} dense={dense} />);

const sourceOf = (file: string): string =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

/* ------------------------------------------------------------------ *
 * The shared rule
 * ------------------------------------------------------------------ */

describe('shared tile-media rule', () => {
  it('fits by containing, never by covering', () => {
    expect(TILE_MEDIA_CLASS).toContain('object-contain');
    expect(TILE_MEDIA_CLASS).not.toContain('object-cover');
  });

  it('fills the frame in both axes, so contain has a frame to fit inside', () => {
    expect(TILE_MEDIA_CLASS).toContain('h-full');
    expect(TILE_MEDIA_CLASS).toContain('w-full');
  });

  it('gives one fixed frame per density, with a letterbox backdrop', () => {
    expect(tileFrameClass()).toContain('aspect-[3/4]');
    expect(tileFrameClass(true)).toContain('aspect-square');
    // The backdrop is what the letterboxed margins show, so it must exist.
    expect(tileFrameClass()).toContain('bg-zinc-900');
    expect(tileFrameClass(true)).toContain('bg-zinc-900');
  });
});

/* ------------------------------------------------------------------ *
 * Content Library tiles (rendered)
 * ------------------------------------------------------------------ */

describe('Content Library tile', () => {
  it('fits an image with object-contain, never object-cover', () => {
    const html = render(asset({ mediaType: 'image' }));
    expect(html).toContain('<img');
    expect(html).toContain('object-contain');
    expect(html).not.toContain('object-cover');
  });

  it('fits a video with object-contain, never object-cover', () => {
    const html = render(asset({ mediaType: 'video' }));
    expect(html).toContain('<video');
    expect(html).toContain('object-contain');
    expect(html).not.toContain('object-cover');
  });

  it('fits images and video IDENTICALLY — one rule, not two', () => {
    expect(render(asset({ mediaType: 'image' }))).toContain(TILE_MEDIA_CLASS);
    expect(render(asset({ mediaType: 'video' }))).toContain(TILE_MEDIA_CLASS);
  });

  it('never stretches: no media element sets an explicit size attribute', () => {
    for (const mediaType of ['image', 'video'] as const) {
      const html = render(asset({ mediaType }));
      // h-full/w-full only fill the FRAME; object-contain preserves the ratio
      // inside it. A width/height attribute pair would override that.
      expect(html).not.toMatch(/<(img|video)[^>]*\swidth="/);
      expect(html).not.toMatch(/<(img|video)[^>]*\sheight="/);
    }
  });

  it('gives every asset the same frame regardless of media type', () => {
    for (const mediaType of ['image', 'video'] as const) {
      expect(render(asset({ mediaType }), true)).toContain(tileFrameClass(true));
    }
  });

  it('still labels video and keeps the placeholder for a keyless asset', () => {
    expect(render(asset({ mediaType: 'video' }))).toContain('video');
    const keyless = render(asset({ previewUrl: null }));
    expect(keyless).not.toContain('<img');
    expect(keyless).not.toContain('<video');
  });
});

/* ------------------------------------------------------------------ *
 * Review queue tiles
 *
 * The Review tile is inline JSX inside a data-fetching page, so it cannot be
 * rendered in isolation without restructuring the page — which the brief
 * explicitly rules out. These assert against the page SOURCE instead, which
 * protects exactly what was asked: object-cover cannot come back, and the tile
 * uses the shared rule rather than a private copy of the classes.
 * ------------------------------------------------------------------ */

describe('Review queue tile', () => {
  const review = sourceOf('./ContentReviewPage.tsx');

  it('uses the shared tile-media rule', () => {
    expect(review).toContain("from '../../lib/mediaTile'");
    expect(review).toContain('TILE_MEDIA_CLASS');
    expect(review).toContain('tileFrameClass()');
  });

  it('never reintroduces object-cover', () => {
    expect(review).not.toContain('object-cover');
  });

  it('does not hand-roll its own fitting classes', () => {
    // The old private copy. If this reappears the two grids have drifted again.
    expect(review).not.toContain('h-full w-full object-');
  });
});

describe('both admin content grids', () => {
  it('are free of object-cover', () => {
    for (const file of ['./ContentLibraryPage.tsx', './ContentReviewPage.tsx']) {
      expect(sourceOf(file)).not.toContain('object-cover');
    }
  });
});

/* ------------------------------------------------------------------ *
 * The clip-access thumbnail
 *
 * Clip access became a media screen -- an operator classifies a clip they can
 * see -- and the one thing it must not do is grow a second way of drawing an
 * asset. These pin that the panel renders through the shared thumbnail, and
 * that the thumbnail is built from the same two constants as every tile above.
 * ------------------------------------------------------------------ */

describe('the clip-access thumbnail', () => {
  const thumb = sourceOf('../../admin/ClipThumb.tsx');
  const panel = sourceOf('./CharacterAccessPanel.tsx');

  it('is built from the shared tile rules', () => {
    expect(thumb).toContain("from '../lib/mediaTile'");
    expect(thumb).toContain('TILE_MEDIA_CLASS');
    expect(thumb).toContain('tileFrameClass(true)');
    expect(thumb).not.toContain('object-cover');
    expect(thumb).not.toContain('h-full w-full object-');
  });

  /**
   * A still, deliberately: a character's shelf is a dozen clips, and a dozen
   * autoplaying loops fetches a dozen whole files to answer "which clip is
   * this?" -- which one frame answers.
   */
  it('shows a frame rather than playing the video', () => {
    expect(thumb).toContain('preload="metadata"');
    expect(thumb).toContain('#t=0.1');
    // The autoplay/loop set is NAMED in its doc comment (to say why it is not
    // used here) but never spread, which is the thing that would start playback.
    expect(thumb).not.toContain('{...TILE_VIDEO_PLAYBACK}');
  });

  it('is the panel\'s only way of drawing an asset', () => {
    expect(panel).toContain("import ClipThumb from '../../admin/ClipThumb'");
    expect(panel).toContain('<ClipThumb');
    // No private copy: the panel itself renders no media element at all.
    expect(panel).not.toContain('<img');
    expect(panel).not.toContain('<video');
    expect(panel).not.toContain('TILE_MEDIA_CLASS');
  });
});
