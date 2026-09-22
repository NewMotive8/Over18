import { API_URL } from '../lib/api';
import { TILE_MEDIA_CLASS, tileFrameClass } from '../lib/mediaTile';

/**
 * One small still of an asset, for admin screens that manage clips by sight.
 *
 * It is built from the SHARED tile rules -- `tileFrameClass` for the fixed
 * frame and `TILE_MEDIA_CLASS` for the fitting -- so it letterboxes rather than
 * crops, exactly like the Library, the Review queue and the Home composer's
 * carousel rows. Nothing about fitting, framing or letterboxing is decided
 * here; this is the markup those constants were written for, in one place
 * instead of a seventh copy.
 *
 * ── A STILL, NOT A PLAYING VIDEO ─────────────────────────────────────────────
 *
 * The admin tiles elsewhere spread `TILE_VIDEO_PLAYBACK`, which autoplays and
 * loops: on a rail of a handful of clips, motion is what tells a video from a
 * photograph. This one deliberately does NOT. A character's whole shelf can be
 * a dozen clips at once, and a dozen looping videos means a dozen full files
 * fetched and decoded to classify something -- while the operator's question is
 * only "which clip is this?", which one frame answers.
 *
 * So: `preload="metadata"` fetches the header rather than the file, and the
 * `#t=0.1` media fragment asks the browser to show the frame a tenth of a
 * second in. A frame at exactly 0 is often black on encoded video, which would
 * make every tile look identical -- the one thing a recognition aid must not
 * do. `muted` and `playsInline` are here for what they PREVENT (a tile that
 * takes over iOS full screen, or makes noise) should anything ever start it.
 */
export default function ClipThumb({
  previewUrl,
  mediaType,
  className = 'w-16 sm:w-20',
}: {
  previewUrl: string | null;
  mediaType: string;
  /** The width the frame fills. The aspect ratio is the shared tile's. */
  className?: string;
}) {
  const src = previewUrl ? `${API_URL}${previewUrl}` : null;
  return (
    <div className={`${className} shrink-0 overflow-hidden rounded-md`} data-testid="clip-thumb">
      <div className={tileFrameClass(true)}>
        {src === null ? (
          // No bytes to show. Saying so beats an empty grey square that reads
          // as a still the operator cannot make out.
          <div className="flex h-full items-center justify-center px-1 text-center text-[9px] uppercase tracking-wide text-zinc-600">
            no preview
          </div>
        ) : mediaType === 'video' ? (
          <>
            <video
              src={`${src}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              className={TILE_MEDIA_CLASS}
              data-testid="clip-thumb-video"
            />
            <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] uppercase tracking-wide text-zinc-200">
              video
            </span>
          </>
        ) : (
          <img src={src} alt="" loading="lazy" className={TILE_MEDIA_CLASS} data-testid="clip-thumb-image" />
        )}
      </div>
    </div>
  );
}
