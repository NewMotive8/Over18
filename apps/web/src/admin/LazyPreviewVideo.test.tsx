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

  /**
   * THE SAME LIBRARY, ON THE SAME ADMIN, MISSED THE FIRST TIME. The Home
   * composer's "Add clips" picker lists every approved clip — 230 on Staging,
   * all of them video — and drew each as an autoplaying, looping <video>.
   *
   * The Hero panel beside it holds a handful, where motion is what tells a
   * video from a photograph, so that one keeps autoplaying on purpose. The
   * distinction is the SIZE OF THE LIST, not the screen.
   */
  it('the Home composer draws its picker with it, and keeps the Hero rail autoplaying', () => {
    const page = read('../pages/admin/HomeComposerPage.tsx');
    expect(page).toContain('<LazyPreviewVideo');
    // Exactly one autoplaying tile is left, and it is the Hero rail.
    expect(page.match(/\{\.\.\.TILE_VIDEO_PLAYBACK\}/g) ?? []).toHaveLength(1);
    expect(page.match(/<video\b/g) ?? []).toHaveLength(1);
  });
});

/**
 * WHY ONE CLICK USED TO FLASH THE WHOLE GRID. Every picker tile was
 * `disabled={busy || candidate.inHero}` with `disabled:opacity-40`, and `busy`
 * is true for ALL tiles while any single add or remove is in flight. So adding
 * one clip dimmed 230 tiles to 40% and undimmed them a moment later. Dimming
 * has to follow the clip, not the request.
 */
describe('the Home composer picker during an add or a remove', () => {
  const page = read('../pages/admin/HomeComposerPage.tsx');

  /** Just the picker grid, so the assertion cannot be satisfied elsewhere. */
  const picker = page.slice(
    page.indexOf('candidates.map((candidate)'),
    page.indexOf('PLAY WITH ME HAS NO CONTROLS'),
  );

  it('never dims a tile because some other tile is busy', () => {
    expect(picker.length).toBeGreaterThan(0);
    expect(picker).not.toMatch(/className=[^\n]*disabled:opacity/);
    // "In the Hero already" is a state of the clip, so it still dims.
    expect(picker).toContain("? 'opacity-40'");
  });

  it('shows progress only on the clip being acted on', () => {
    expect(page).toContain('pendingAsset === candidate.assetId');
    expect(page).toContain('setPendingAsset(assetId)');
    expect(page).toContain('setPendingAsset(clip.assetId)');
    // Cleared whether the request succeeded or failed — once per action.
    expect(page.match(/setPendingAsset\(null\)/g) ?? []).toHaveLength(2);
  });

  /**
   * Adding or removing a Hero clip cannot change which clips are APPROVED, and
   * the response already names the new Hero — so re-requesting all 230 rows to
   * learn one boolean was pure cost on every click.
   */
  it('re-flags the picker from the response instead of refetching the library', () => {
    expect(page).toContain('function markInHero(');
    const actions = page.slice(
      page.indexOf('async function addHero'),
      page.indexOf('async function moveHero'),
    );
    expect(actions).toContain('markInHero(res.clips)');
    expect(actions).not.toContain('heroCandidates()');
  });
});
