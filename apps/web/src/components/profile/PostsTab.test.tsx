import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { CustomerContentAccess } from '@over18/shared';
import PostsTab from './PostsTab';
import type { PublicClip } from '../../lib/api';
import { contentAccessStateFromResponse, type ContentAccessState } from '../../lib/contentAccess';

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

const render = (clips: PublicClip[], access?: ContentAccessState) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PostsTab clips={clips} onOpenClip={() => {}} access={access} />
    </MemoryRouter>,
  );

const decided = (items: CustomerContentAccess[]): ContentAccessState => contentAccessStateFromResponse({ items });

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

/**
 * P8.1 -- the tab renders each tile in the state the server (P4.2) gave for
 * that asset, and asks for nothing of its own.
 */
describe('the Posts tab renders the access the server decided', () => {
  const access = (assetId: string, over: Partial<CustomerContentAccess> = {}): CustomerContentAccess => ({
    assetId,
    state: 'free',
    creditPrice: null,
    ageFloor: null,
    decision: 'open',
    ...over,
  });

  it('is exactly the tab it is today while no access is known -- the production default', () => {
    const markup = render([clip('a'), clip('b')]);
    expect(markup).not.toContain('locked-content-card');
    expect(markup).not.toMatch(/Premium|Credits|Unavailable/);
    // No balance either: the pill renders nothing, and its row collapses.
    expect(markup).toContain('flex justify-end empty:hidden');
    expect(markup).not.toContain('Credits</span>');
  });

  it('locks each tile the server locked, and leaves the others playing', () => {
    const markup = render(
      [clip('free'), clip('prem'), clip('cost'), clip('poor'), clip('age'), clip('gone')],
      decided([
        access('free'),
        access('prem', { state: 'premium', decision: 'premium_required' }),
        access('cost', { state: 'credit', creditPrice: 50, decision: 'credits_required' }),
        access('poor', { state: 'credit', creditPrice: 50, decision: 'insufficient_credits' }),
        access('age', { ageFloor: 21, decision: 'age_restricted' }),
        access('gone', { state: 'unavailable', decision: 'unavailable' }),
      ]),
    );
    expect(markup.match(/data-testid="locked-content-card"/g)).toHaveLength(5);
    for (const state of ['premium_required', 'credits_required', 'insufficient_credits', 'age_restricted', 'unavailable']) {
      expect(markup, state).toContain(`data-state="${state}"`);
    }
    // The free tile still plays, and every tile still shows its own media.
    expect(markup).toContain('<button type="button" aria-label="Post 1"');
    for (const id of ['free', 'prem', 'cost', 'poor', 'age', 'gone']) expect(markup, id).toContain(`/api/media/assets/${id}/file`);
    // Premium and Credits are told apart, and the price is the server's.
    expect(markup).toContain('href="/subscription"');
    expect(markup).toContain('href="/credits"');
    expect(markup).toContain('50 Credits');
  });

  it('only autoplays what the server revealed', () => {
    const markup = render([clip('free'), clip('prem')], decided([access('free'), access('prem', { state: 'premium', decision: 'premium_required' })]));
    expect(markup.match(/autoplay=""/g)).toHaveLength(1);
  });

  it('shows no access state for an asset the server did not answer for', () => {
    const markup = render([clip('a'), clip('b')], decided([access('a', { state: 'premium', decision: 'premium_required' })]));
    expect(markup.match(/data-testid="locked-content-card"/g)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Unlocking, from the tab that offers it (P8.2)
 * ------------------------------------------------------------------ */

describe('the tab offers the unlock, and shows what the server decided', () => {
  const priced = (id: string, over: Partial<CustomerContentAccess> = {}): CustomerContentAccess => ({
    assetId: id,
    state: 'credit',
    creditPrice: 50,
    ageFloor: null,
    decision: 'credits_required',
    ...over,
  });

  it('a Credit-priced tile offers a real unlock here, not a "coming soon"', () => {
    const markup = render([clip('a1')], decided([priced('a1')]));
    expect(markup).toContain('Unlock · 50 Credits');
    // This tab CAN carry it through, so the control works.
    expect(markup).not.toContain('Unlocking is coming soon.');
    expect(markup).not.toContain('disabled=""');
    // And nothing is revealed by offering it.
    expect(markup).toContain('data-state="credits_required"');
  });

  it('once the server says it is owned, the same tile is revealed and plays', () => {
    const locked = render([clip('a1')], decided([priced('a1')]));
    expect(locked).toContain('blur-xl');
    expect(locked).not.toContain('autoplay');

    // The only thing that changed is the server's answer.
    const owned = render([clip('a1')], decided([priced('a1', { decision: 'owned' })]));
    expect(owned).toContain('Unlocked');
    expect(owned).not.toContain('blur-xl');
    expect(owned).toContain('autoplay');
    expect(owned).not.toContain('Unlock · 50 Credits');
  });

  it('too few Credits is never an unlock: it is the existing route to Credits', () => {
    const markup = render([clip('a1')], decided([priced('a1', { decision: 'insufficient_credits' })]));
    expect(markup).toContain('You need 50 Credits to unlock this.');
    expect(markup).toContain('href="/credits"');
    expect(markup).not.toContain('Unlock · 50 Credits');
  });

  it('keeps Premium and Credits apart: a Premium tile still sends them to Premium', () => {
    const markup = render([clip('a1')], decided([priced('a1', { state: 'premium', creditPrice: null, decision: 'premium_required' })]));
    expect(markup).toContain('href="/subscription"');
    expect(markup).not.toContain('href="/credits"');
    expect(markup).not.toMatch(/Unlock ·/);
  });

  it('keeps age restriction ahead of the price: nothing can be bought through it', () => {
    const markup = render([clip('a1')], decided([priced('a1', { ageFloor: 21, decision: 'age_restricted' })]));
    expect(markup).toContain('21+');
    expect(markup).toContain('Confirm your age to view this.');
    expect(markup).not.toMatch(/Unlock ·/);
  });

  it('shows no confirmation until the customer asks for one', () => {
    expect(render([clip('a1')], decided([priced('a1')]))).not.toContain('data-testid="unlock-sheet"');
  });

  it('shows no balance, and no unlock, when the server said nothing about the content', () => {
    const markup = render([clip('a1')]);
    expect(markup).not.toMatch(/Unlock ·|Credits/);
    expect(markup).not.toContain('data-testid="unlock-sheet"');
  });
});
