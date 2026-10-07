import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MediaViewer from './MediaViewer';
import VideoSoundControl, { MUTE_LABEL, UNMUTE_LABEL } from './VideoSoundControl';
import HeroMedia from './HeroMedia';
import { INITIAL_SOUND, toggleMute } from '../lib/videoSound';
import type { CharacterMediaItem } from '../lib/media';

/**
 * THE CONTROL THAT LETS HER CLIPS BE HEARD.
 *
 * The rules themselves are pinned in lib/videoSound.test.ts, which can exercise
 * them because they are React-free. These cover what only rendering can show:
 * that the control reaches the full-screen viewer, that it reaches VIDEO and
 * nothing else, and -- the part that matters most -- that every other surface
 * in the app still renders a hard-muted clip exactly as it did before.
 */

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

/**
 * A clip, EXPLICIT BY DEFAULT, because that is the only kind sound is offered
 * on and these cases are about the control. The rating is a parameter rather
 * than a fixture so the SFW half can use the same builder and differ in exactly
 * the one field under test.
 */
const video = (id = 'v', contentRating: 'sfw' | 'explicit' = 'explicit'): CharacterMediaItem => ({
  id,
  media: { kind: 'video', src: `https://vid/${id}.mp4` },
  premium: false,
  contentRating,
});

/** A clip whose builder reported no rating at all -- the header deck, chat. */
const unratedVideo = (id = 'u'): CharacterMediaItem => ({
  id,
  media: { kind: 'video', src: `https://vid/${id}.mp4` },
  premium: false,
});
const image = (id = 'i'): CharacterMediaItem => ({
  id,
  media: { kind: 'image', src: `https://img/${id}.jpg` },
  premium: false,
});

const viewer = (items: CharacterMediaItem[], startIndex = 0) =>
  render(
    <MediaViewer items={items} startIndex={startIndex} label="Luna" onClose={() => {}} videoFit="contain" />,
  );

describe('the control in the full-screen viewer', () => {
  it('offers an unmute on a clip', () => {
    expect(viewer([video()])).toContain(`aria-label="${UNMUTE_LABEL}"`);
  });

  /** Opening silent is the only thing a browser permits, and it is also correct. */
  it('opens muted, so nothing ever starts talking on its own', () => {
    const html = viewer([video()]);
    expect(html).toMatch(/<video[^>]*muted=""/);
    expect(html).toContain(`aria-label="${UNMUTE_LABEL}"`);
    expect(html).not.toContain(`aria-label="${MUTE_LABEL}"`);
  });

  it('hides the slider while muted', () => {
    expect(viewer([video()])).not.toContain('aria-label="Volume"');
  });

  /** An image has no sound to control, and must not grow a dead button. */
  it('shows nothing on an image', () => {
    const html = viewer([image()]);
    expect(html).not.toContain(`aria-label="${UNMUTE_LABEL}"`);
    expect(html).not.toContain(`aria-label="${MUTE_LABEL}"`);
    expect(html).not.toContain('aria-label="Volume"');
  });

  /** A gallery mixes the two and pages between them; the control follows the item. */
  it('appears on the clip and not on the photo beside it', () => {
    const mixed = [image('i1'), video('v1')];
    expect(viewer(mixed, 0)).not.toContain(`aria-label="${UNMUTE_LABEL}"`);
    expect(viewer(mixed, 1)).toContain(`aria-label="${UNMUTE_LABEL}"`);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * THE RATING DECIDES WHETHER SOUND IS OFFERED AT ALL.
 *
 * The control was once reachable from any video in the viewer, which made it
 * rating-blind: an ordinary clip that happened to carry a track could be
 * unmuted exactly like an explicit one. Only what she published as explicit
 * gets a way to be heard; everything else stays the silent element it was.
 * ───────────────────────────────────────────────────────────────────────────
 */
describe('only an explicit clip is offered sound', () => {
  const silent = (html: string) => {
    expect(html).not.toContain(`aria-label="${UNMUTE_LABEL}"`);
    expect(html).not.toContain(`aria-label="${MUTE_LABEL}"`);
    expect(html).not.toContain('aria-label="Volume"');
  };

  it('offers the control on an explicit clip', () => {
    expect(viewer([video('v1', 'explicit')])).toContain(`aria-label="${UNMUTE_LABEL}"`);
  });

  it('offers NOTHING on an sfw clip', () => {
    silent(viewer([video('v1', 'sfw')]));
  });

  /** Absent is not 'sfw' and is not explicit -- it is the old, quiet behaviour. */
  it('offers nothing when no rating was reported', () => {
    silent(viewer([unratedVideo()]));
  });

  /** The element itself must stay muted, not merely lose its button. */
  it('leaves an sfw clip hard-muted, exactly as every ambient surface renders it', () => {
    expect(viewer([video('v1', 'sfw')])).toMatch(/<video[^>]*muted=""/);
    expect(viewer([unratedVideo()])).toMatch(/<video[^>]*muted=""/);
  });

  /**
   * Her Posts gallery mixes both and pages between them in here, so the
   * decision has to follow the item rather than the viewer.
   */
  it('follows the item when a gallery mixes the two', () => {
    const mixed = [video('sfw1', 'sfw'), video('x1', 'explicit')];
    silent(viewer(mixed, 0));
    expect(viewer(mixed, 1)).toContain(`aria-label="${UNMUTE_LABEL}"`);
  });
});

describe('the control itself', () => {
  it('reads as unmute while muted, and mute once it is on', () => {
    const off = render(
      <VideoSoundControl sound={INITIAL_SOUND} onToggleMute={() => {}} onVolumeChange={() => {}} />,
    );
    const on = render(
      <VideoSoundControl
        sound={toggleMute(INITIAL_SOUND)}
        onToggleMute={() => {}}
        onVolumeChange={() => {}}
      />,
    );
    expect(off).toContain(`aria-label="${UNMUTE_LABEL}"`);
    expect(on).toContain(`aria-label="${MUTE_LABEL}"`);
  });

  it('exposes the slider, with its level, once unmuted', () => {
    const on = render(
      <VideoSoundControl
        sound={{ muted: false, volume: 0.4 }}
        onToggleMute={() => {}}
        onVolumeChange={() => {}}
      />,
    );
    expect(on).toContain('aria-label="Volume"');
    expect(on).toContain('type="range"');
    expect(on).toContain('value="0.4"');
  });

  /**
   * A phone is the main way this product is used, and a 40px target is the
   * smallest a thumb reliably hits. h-10 on both the button and the slider is
   * what makes the bar usable there rather than merely present.
   */
  it('keeps a thumb-sized target on both parts', () => {
    const on = render(
      <VideoSoundControl
        sound={{ muted: false, volume: 1 }}
        onToggleMute={() => {}}
        onVolumeChange={() => {}}
      />,
    );
    expect(on.match(/h-10/g)?.length).toBe(2);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * THE REGRESSION GUARD. Everything else must be byte-identical.
 *
 * Ambient surfaces autoplay many clips at once -- a rail, a grid, a swipe deck.
 * If `sound` ever became their default, a scroll down the Posts tab would play
 * a dozen explicit clips simultaneously. `sound` is opt-in for exactly that
 * reason, and these prove the opt-out side of it still holds.
 * ───────────────────────────────────────────────────────────────────────────
 */
describe('every other surface is untouched', () => {
  const clip = { kind: 'video', src: 'https://vid/a.mp4' } as const;

  it('HeroMedia with no sound prop renders the hard mute it always did', () => {
    const html = render(<HeroMedia media={clip} alt="Luna" />);
    expect(html).toMatch(/<video[^>]*muted=""/);
    expect(html).not.toContain('aria-label="Volume"');
  });

  it('a muted sound prop renders the same muted element', () => {
    const without = render(<HeroMedia media={clip} alt="Luna" />);
    const withMuted = render(<HeroMedia media={clip} alt="Luna" sound={INITIAL_SOUND} />);
    expect(withMuted).toBe(without);
  });

  /** The one real difference: unmuted means the attribute is gone. */
  it('drops the mute only when actually unmuted', () => {
    const html = render(
      <HeroMedia media={clip} alt="Luna" sound={{ muted: false, volume: 1 }} />,
    );
    expect(html).not.toMatch(/<video[^>]*muted=""/);
  });

  it('still autoplays, loops and stays inline', () => {
    const html = render(<HeroMedia media={clip} alt="Luna" sound={INITIAL_SOUND} />);
    for (const attr of ['autoplay', 'loop', 'playsinline']) {
      expect(html.toLowerCase()).toContain(attr);
    }
  });
});
