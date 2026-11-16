import { useEffect, useState } from 'react';

/**
 * How long this has been going, counting up.
 *
 * Deliberately elapsed time and NOT a progress bar: the provider reports no
 * progress, only "working" and then "done", so a bar would be a number we
 * invented. A clock that is visibly moving says "still happening" just as
 * well and claims nothing it cannot know.
 */
export function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return <>{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</>;
}

/**
 * The minute a picture takes to draw, made visible.
 *
 * A still line of text on a dark rectangle is indistinguishable from a screen
 * that has stopped working — exactly what it must not look like while a
 * provider is busy and a clock is running. Three independent signs of life:
 * the frame breathes, a sweep of light crosses it, and the seconds count up.
 */
export default function CreatingPortrait({ label = 'Creating…' }: { label?: string }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-zinc-900">
      <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-800 via-zinc-900 to-zinc-800" />
      {/* motion-safe: a sweep is decoration, and nobody who asked their
          machine for less motion needs it to know something is happening. */}
      <span className="pointer-events-none absolute inset-y-0 left-0 w-full bg-gradient-to-r from-transparent via-white/10 to-transparent motion-safe:animate-shimmer" />
      <div className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
        <span
          aria-hidden="true"
          className="h-9 w-9 animate-spin rounded-full border-2 border-zinc-700 border-t-rose-500"
        />
        <span className="text-sm font-medium text-zinc-200">{label}</span>
        <span className="text-xs tabular-nums text-zinc-500">
          <ElapsedSeconds />
        </span>
      </div>
    </div>
  );
}
