import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProfileHero from './ProfileHero';
import { characterHeaderItems, type CharacterClipRef } from '../../lib/media';
import type { PublicCharacter } from '@over18/shared';

/**
 * The Character page header, rendered.
 *
 * `media.test.ts` proves the DECISION — which asset the header picks. This
 * proves the RENDER — that the picked video actually reaches the DOM as a
 * playing element, because a correct decision that renders an `<img>` would
 * still be the bug the operator reported.
 *
 * Node environment, no DOM: `useInViewport` returns true for both answers when
 * `IntersectionObserver` is missing, which is the same path a real browser
 * takes here anyway — the header is NOT lazy (`lazy` defaults to false), since
 * its media is the thing the visitor came to see.
 */

function character(overrides: Partial<PublicCharacter> = {}): PublicCharacter {
  return {
    id: 'c1',
    name: 'not-in-manifest',
    displayName: 'Aria',
    profileImage: null,
    shortBio: '',
    personality: '',
    interests: [],
    conversationStyle: '',
    ...overrides,
  };
}

const clip = (id: string, mediaType: 'image' | 'video' = 'video'): CharacterClipRef => ({
  id,
  mediaType,
  url: `/api/media/assets/${id}/file`,
});

const render = (items: ReturnType<typeof characterHeaderItems>) =>
  renderToStaticMarkup(
    <ProfileHero
      items={items}
      name="Aria"
      age={24}
      onBack={() => {}}
      onOpen={() => {}}
    />,
  );

describe('a character WITH an eligible header video', () => {
  const markup = () => render(characterHeaderItems(character(), [clip('v1')], null));

  it('renders a video element, not an image', () => {
    expect(markup()).toContain('<video');
  });

  it('autoplays, muted, looping and inline', () => {
    const html = markup();
    for (const attr of ['autoplay', 'muted', 'loop', 'playsinline']) {
      expect(html).toContain(attr);
    }
  });

  it('points at the opaque media route, resolved against the API origin', () => {
    const html = markup();
    expect(html).toContain('/api/media/assets/v1/file');
    // The existing delivery mechanism, and nothing that could leak a location.
    expect(html).not.toContain('storageKey');
    expect(html).not.toContain('/app/var/media');
  });

  it('keeps the approved header treatment exactly — frame, snap and gradients', () => {
    const html = markup();
    expect(html).toContain('aspect-[4/5]');
    expect(html).toContain('snap-center');
    expect(html).toContain('rounded-b-3xl');
    expect(html).toContain('bg-gradient-to-t from-zinc-950');
    // Scroll-snap paging is untouched by the framing change.
    expect(html).toContain('snap-x snap-mandatory overflow-x-auto');
  });

  /**
   * HER HEAD WAS BEING CUT OFF.
   *
   * Every production clip is portrait -- 9:16, 640x1152, 544x960, 768x1168 --
   * and this frame is 4/5 = 0.8, wider than all of them. `object-cover` filled
   * the width and discarded about 30% of a 9:16 clip's height, and the default
   * `center` anchor split that evenly, so roughly 15% came off the top.
   *
   * `contain` fits the whole clip instead. The frame does NOT change, so the
   * cost is a dark bar down each side -- which is why the slide needs a
   * background of its own, and why that is asserted here rather than left to
   * whatever sits behind the carousel.
   */
  it('shows a VIDEO whole instead of cropping it', () => {
    const html = markup();
    expect(html).toContain('<video');
    expect(html).toContain('object-contain');
    expect(html, 'the cropping fit must be gone for video').not.toContain('object-cover');
  });

  it('gives the slide its own dark background for the letterboxing', () => {
    const html = markup();
    expect(html).toContain('aspect-[4/5] w-full shrink-0 snap-center bg-zinc-900');
  });
});

describe('a character with NO eligible header video', () => {
  it('falls back to her existing still rather than a broken video', () => {
    const items = characterHeaderItems(character({ profileImage: 'https://img/aria.png' }), [], null);
    const html = render(items);
    expect(html).not.toContain('<video');
    expect(html).toContain('<img');
    expect(html).toContain('https://img/aria.png');
  });

  it('shows the initial-letter placeholder when she has no media at all', () => {
    const html = render(characterHeaderItems(character(), [], null));
    expect(html).not.toContain('<video');
    // No invented artwork and no unrelated image — the pre-existing placeholder.
    expect(html).toContain('A');
  });

  it('does not turn an image clip into a video', () => {
    const html = render(characterHeaderItems(character(), [clip('i1', 'image')], null));
    expect(html).not.toContain('<video');
  });

  /**
   * THE FRAMING CHANGE IS VIDEO-ONLY. An image still fills the 4/5 frame, so
   * the header is unchanged for a character who has no video -- and the dark
   * background is simply never seen behind a covered image.
   */
  it('keeps her still IMAGE covering the frame, exactly as before', () => {
    const items = characterHeaderItems(character({ profileImage: 'https://img/aria.png' }), [], null);
    const html = render(items);
    expect(html).toContain('<img');
    expect(html).toContain('object-cover');
    expect(html, 'an image must not be letterboxed').not.toContain('object-contain');
    // The frame itself is the same one a video gets.
    expect(html).toContain('aspect-[4/5]');
  });

  it('keeps the initial-letter PLACEHOLDER covering the frame', () => {
    const html = render(characterHeaderItems(character(), [], null));
    expect(html).not.toContain('object-contain');
  });
});

describe('the header deck keeps its existing paging behaviour', () => {
  it('shows no dots for a single item', () => {
    expect(render(characterHeaderItems(character(), [clip('v1')], null))).not.toContain(
      'aria-current',
    );
  });

  it('shows one dot per clip when she has several', () => {
    const html = render(characterHeaderItems(character(), [clip('v1'), clip('v2')], null));
    expect(html.match(/aria-current/g)).toHaveLength(2);
    expect(html.match(/<video/g)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * The control that did nothing
 * ------------------------------------------------------------------ */

/**
 * A three-dot "More options" button was drawn here with the rest of the US-29
 * design and never wired to anything -- no handler, no menu, no reference to
 * it anywhere. It sat in the tab order announcing itself to a screen reader
 * and then doing nothing, which reads as a broken app rather than an
 * unfinished one. If a menu is built later the control returns WITH it.
 */
describe('the header offers only controls that work', () => {
  const markup = () => render(characterHeaderItems(character(), [clip('v1')], null));

  it('has no "More options" button', () => {
    expect(markup()).not.toContain('More options');
  });

  it('keeps Back, which does work', () => {
    expect(markup()).toContain('aria-label="Back"');
  });
});
