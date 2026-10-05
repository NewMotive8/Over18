/**
 * Mute / unmute and volume for a clip being watched full screen.
 *
 * WHY THIS EXISTS. Her explicit clips are stored WITH their audio track — three
 * approved explicit assets on the media volume carry one each — but every
 * surface that rendered video did so with a hard-coded `muted`, and the
 * full-screen viewer offered no control at all. So a clip that had sound could
 * not be heard anywhere, and nothing on screen suggested there was anything to
 * hear. Nothing was wrong with the asset or the pipeline; the sound had simply
 * never been given a way out.
 *
 * STARTS MUTED, ALWAYS. Browsers refuse autoplay WITH sound, and that refusal
 * is correct — a lightbox that opened talking would be the wrong thing in a
 * room with other people in it, which for this product is not a small concern.
 * So the clip autoplays silently, exactly as it did before this existed, and
 * the first unmute happens inside a real user gesture, which is precisely the
 * condition every browser's policy asks for. There is no workaround here and
 * none is wanted.
 *
 * A SILENT CLIP STILL SHOWS THE CONTROL. Whether a video has an audio track
 * cannot be asked portably: Firefox has `mozHasAudio`, Chrome only infers it
 * from `webkitAudioDecodedByteCount` once decoding has begun, and Safari's
 * `audioTracks` is gated. Every one of them can say "no audio" about a clip
 * that has some, and hiding the control on that answer would recreate the
 * original bug on exactly the clips this is meant to fix. Showing it always is
 * honest: unmuting a silent clip produces silence, which is what the asset
 * contains. Nothing is generated to fill it.
 */

import { showsSlider, type VideoSound } from '../lib/videoSound';

export const MUTE_LABEL = 'Mute';
export const UNMUTE_LABEL = 'Unmute';

/** The viewer's own button shape, so this reads as part of it rather than beside it. */
const BUTTON_CLASS =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20';

export default function VideoSoundControl({
  sound,
  onToggleMute,
  onVolumeChange,
}: {
  sound: VideoSound;
  onToggleMute: () => void;
  onVolumeChange: (next: number) => void;
}) {
  const { muted, volume } = sound;
  return (
    <div
      // The viewer closes on a backdrop click; this is not the backdrop.
      onClick={(e) => e.stopPropagation()}
      className="pointer-events-auto flex items-center gap-2 rounded-full bg-black/60 px-2 py-1.5 backdrop-blur-sm"
    >
      <button
        type="button"
        onClick={onToggleMute}
        aria-label={muted ? UNMUTE_LABEL : MUTE_LABEL}
        aria-pressed={!muted}
        className={BUTTON_CLASS}
      >
        <span aria-hidden className="text-lg leading-none">
          {muted ? '🔇' : '🔊'}
        </span>
      </button>

      {/*
        Shown only once there is something to adjust. A slider next to a muted
        clip invites a drag that cannot be heard, and on a phone it would eat
        thumb-width from a bar that has little to spare.
      */}
      {showsSlider(sound) && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
          aria-label="Volume"
          // h-10 keeps the touch target full height on a phone even though the
          // track is drawn thin; w-24 stays inside the narrowest viewport.
          className="h-10 w-24 cursor-pointer accent-rose-500"
        />
      )}
    </div>
  );
}
