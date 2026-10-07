import { describe, expect, it } from 'vitest';
import {
  INITIAL_SOUND,
  clampVolume,
  setVolume,
  showsSlider,
  toggleMute,
} from './videoSound';

/**
 * SOUND ON HER EXPLICIT CLIPS.
 *
 * Her explicit clips are stored with their audio track, and until now every
 * player muted them with no way to undo it. These pin the rules that let the
 * sound out: that it still STARTS silent, because a browser allows nothing
 * else and a lightbox that opened talking would be the wrong thing in a shared
 * room; and that once someone turns it on, the control behaves the way a
 * person expects rather than the way a boolean would.
 */

describe('where a clip starts', () => {
  /** The browser allows no other opening state, and neither does the product. */
  it('starts muted', () => {
    expect(INITIAL_SOUND.muted).toBe(true);
  });

  it('starts at a level worth unmuting to', () => {
    expect(INITIAL_SOUND.volume).toBe(1);
  });

  it('shows no slider until there is something to adjust', () => {
    expect(showsSlider(INITIAL_SOUND)).toBe(false);
  });
});

describe('muting and unmuting', () => {
  it('unmutes, then mutes again', () => {
    const on = toggleMute(INITIAL_SOUND);
    expect(on.muted).toBe(false);
    expect(toggleMute(on).muted).toBe(true);
  });

  /**
   * THE RULE THAT MAKES IT FEEL LIKE A MUTE BUTTON. Muting is not "volume to
   * zero": someone listening quietly who mutes and unmutes must get their
   * quiet level back, not a room-filling one.
   */
  it('remembers the level across a mute', () => {
    const quiet = setVolume(0.3);
    const muted = toggleMute(quiet);
    expect(muted.muted).toBe(true);
    expect(muted.volume).toBe(0.3);
    expect(toggleMute(muted)).toEqual({ muted: false, volume: 0.3 });
  });

  /**
   * Unmuting into silence would look like the button was broken -- which is the
   * very bug this whole change exists to remove.
   */
  it('never unmutes into silence', () => {
    const silent = setVolume(0);
    expect(silent.muted).toBe(true);
    const on = toggleMute(silent);
    expect(on.muted).toBe(false);
    expect(on.volume).toBe(1);
  });

  it('reveals the slider once unmuted', () => {
    expect(showsSlider(toggleMute(INITIAL_SOUND))).toBe(true);
  });
});

describe('the slider', () => {
  it('sets the level', () => {
    expect(setVolume(0.45).volume).toBe(0.45);
  });

  it('mutes when dragged to zero, so the icon never lies', () => {
    expect(setVolume(0).muted).toBe(true);
  });

  it('unmutes when lifted off zero', () => {
    expect(setVolume(0.2)).toEqual({ muted: false, volume: 0.2 });
  });
});

/**
 * `HTMLMediaElement.volume` THROWS on a value outside 0-1, which would take the
 * whole viewer down with it. A range input cannot produce one, but a future
 * caller could, and the element is not forgiving.
 */
describe('the level can never be one the DOM refuses', () => {
  it('clamps both ends', () => {
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(0.5)).toBe(0.5);
  });

  it('treats an unusable number as silence rather than throwing', () => {
    expect(clampVolume(Number.NaN)).toBe(0);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('never lets a state carry an out-of-range level', () => {
    for (const v of [-5, 0, 0.5, 1, 99, Number.NaN]) {
      const { volume } = setVolume(v);
      expect(volume).toBeGreaterThanOrEqual(0);
      expect(volume).toBeLessThanOrEqual(1);
    }
  });
});
