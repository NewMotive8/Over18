/**
 * The ringback tone: what a caller hears while the other phone rings.
 *
 * GENERATED, NOT A FILE. Two sine waves at 440 Hz and 480 Hz -- the standard
 * North American ringback -- two seconds on, four seconds off, quietly. Web
 * Audio makes it in a few lines, so there is no asset to ship, license or
 * cache, and nothing to download before the first ring.
 *
 * ITS OWN AudioContext. The call's playback context runs at the provider's
 * 24 kHz and its clock schedules her speech; the ring must not share that
 * clock or outlive the ringing. This one is created on `start()` -- inside the
 * tap on Call, so the browser allows sound -- and closed on `stop()`.
 *
 * Browser glue only, like `voiceCallAudio.ts`: the controller decides WHEN it
 * rings, and its tests use a fake.
 */

export interface Ringback {
  start(): void;
  /** Safe to call at any time, any number of times. */
  stop(): void;
}

export const RING_FREQUENCIES_HZ = [440, 480] as const;
export const RING_ON_MS = 2_000;
export const RING_CYCLE_MS = 6_000;
/** Quiet: a cue that the call is ringing, not an alarm. */
export const RING_GAIN = 0.06;

export function createBrowserRingback(): Ringback {
  let context: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const ring = (): void => {
    const ctx = context;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const t1 = t0 + RING_ON_MS / 1000;
    const gain = ctx.createGain();
    // Short ramps in and out, so each ring starts and ends without a click.
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(RING_GAIN, t0 + 0.03);
    gain.gain.setValueAtTime(RING_GAIN, t1 - 0.03);
    gain.gain.linearRampToValueAtTime(0, t1);
    gain.connect(ctx.destination);
    for (const frequency of RING_FREQUENCIES_HZ) {
      const tone = ctx.createOscillator();
      tone.frequency.value = frequency;
      tone.connect(gain);
      tone.start(t0);
      tone.stop(t1);
    }
  };

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    const ctx = context;
    context = null;
    // Closing the context silences anything already scheduled, mid-ring included.
    void ctx?.close().catch(() => undefined);
  };

  return {
    start() {
      if (context !== null || typeof AudioContext === 'undefined') return;
      try {
        context = new AudioContext();
      } catch {
        // No audio: the call simply has no ring. Never a reason to fail a call.
        context = null;
        return;
      }
      void context.resume().catch(() => undefined);
      ring();
      timer = setInterval(ring, RING_CYCLE_MS);
    },
    stop,
  };
}
