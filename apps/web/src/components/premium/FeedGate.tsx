import { useEffect, useRef } from 'react';

/**
 * The end of a Free customer's feed: a locked card that invites them on, and
 * an invisible line just past it. Scrolling ONTO that line -- trying to
 * continue past the last character they may meet -- opens the Premium funnel
 * once per approach; tapping the card opens it any time.
 */
export default function FeedGate({ onContinue }: { onContinue: () => void }) {
  const lineRef = useRef<HTMLDivElement>(null);
  const latest = useRef(onContinue);
  latest.current = onContinue;

  useEffect(() => {
    const line = lineRef.current;
    if (!line || typeof IntersectionObserver === 'undefined') return;
    // Fires on ARRIVAL only: closing the funnel while the line is still in view
    // does not reopen it; scrolling away and back does.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) latest.current();
    });
    observer.observe(line);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="col-span-2 flex flex-col">
      <button
        type="button"
        onClick={onContinue}
        data-testid="feed-premium-locked"
        className="flex flex-col items-center gap-2 rounded-2xl border border-rose-500/25 bg-gradient-to-b from-rose-500/15 to-zinc-950 px-6 py-8 text-center"
      >
        <span aria-hidden className="text-3xl">👀</span>
        <span className="text-base font-bold text-white">More companions are waiting</span>
        <span className="text-sm text-zinc-400">You&rsquo;ve met your free companions. Premium unlocks the whole feed.</span>
        <span className="mt-2 rounded-xl bg-gradient-to-r from-rose-500 to-fuchsia-600 px-5 py-2.5 text-sm font-bold text-white">Unlock Premium Now</span>
      </button>
      <div ref={lineRef} data-testid="feed-premium-line" aria-hidden className="h-px w-full" />
    </div>
  );
}
