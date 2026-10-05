/**
 * The sound rules for a clip being watched full screen — React-free, so they
 * can actually be tested.
 *
 * WHY THIS MODULE EXISTS. The web test environment is node with no DOM and no
 * events (see apps/web/vitest.config.ts), so a rule written inline in a
 * component's `onClick` cannot be exercised by any test in this repo —
 * `characterForm.ts` exists for exactly the same reason, and says so. Mute,
 * unmute and volume are rules, not rendering, so they live out here where a
 * test can reach them and the component stays a component.
 *
 * WHAT THE RULES ARE, and why each one is a rule rather than a default:
 *
 *   starts muted   — browsers refuse autoplay with sound, so this is the only
 *                    state a clip can legally open in. Unmuting then happens
 *                    inside a user gesture, which is what the policy asks for.
 *   volume survives
 *   a mute         — muting is not "set volume to zero". Someone who mutes at a
 *                    third and unmutes expects a third back, not full blast in
 *                    a quiet room.
 *   dragging to 0
 *   mutes          — otherwise the speaker icon claims sound while silent.
 *   leaving 0 un-
 *   mutes          — the only way a slider at zero can be raised again.
 *   volume clamps  — `HTMLMediaElement.volume` THROWS on a value outside 0–1,
 *                    which would take the viewer down with it.
 */

export interface VideoSound {
  muted: boolean;
  /** 0–1. Retained across a mute so unmuting restores the chosen level. */
  volume: number;
}

/** Muted, at full volume: silent now, and loud enough to be worth unmuting. */
export const INITIAL_SOUND: VideoSound = { muted: true, volume: 1 };

/**
 * Keeps `volume` inside the range the DOM accepts.
 *
 * NaN is the only value with no sensible place on the scale, so it becomes
 * silence. Infinity is not: it is simply off the top, and clamps to the top
 * like any other over-large number would.
 */
export function clampVolume(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Mute, or unmute.
 *
 * Unmuting a clip whose volume sits at 0 would be silent and would look broken,
 * so it also lifts the level back to full — the one place a toggle is allowed
 * to touch the volume, because the alternative is a control that does nothing.
 */
export function toggleMute(state: VideoSound): VideoSound {
  if (!state.muted) return { ...state, muted: true };
  return { muted: false, volume: state.volume > 0 ? state.volume : 1 };
}

/**
 * Moves the slider, and lets the slider mute and unmute at its own extreme.
 *
 * Takes no prior state because it needs none: where the slider lands decides
 * both the level and whether there is anything to hear.
 */
export function setVolume(next: number): VideoSound {
  const volume = clampVolume(next);
  return { volume, muted: volume === 0 };
}

/**
 * Whether the slider is worth drawing.
 *
 * Hidden while muted: a slider you cannot hear invites a drag that does
 * nothing, and on a phone it costs thumb-width in a bar that has little to
 * spare.
 */
export function showsSlider(state: VideoSound): boolean {
  return !state.muted;
}
