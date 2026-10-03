import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * Previous / next buttons for a horizontal rail, desktop only (`lg` and up).
 *
 * WHY. The rails hide their scrollbar and scroll with a swipe -- natural on a
 * phone or a trackpad, but a mouse has no horizontal wheel, so on a desktop the
 * rest of the rail was simply unreachable. These buttons page it by most of a
 * screen-width, smoothly. Below `lg` they are not shown (`hidden lg:flex`), so
 * the phone keeps exactly the swipe it had.
 *
 * Each button disables itself at its end of the rail; neither renders when the
 * rail fits without scrolling.
 */
export default function RailArrows({ scrollerRef, label }: { scrollerRef: RefObject<HTMLElement>; label: string }) {
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const start = el.scrollLeft <= 1;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [scrollerRef]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [scrollerRef, measure]);

  if (edges.start && edges.end) return null;

  const page = (direction: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.85), behavior: 'smooth' });
  };

  const button =
    'absolute top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-zinc-950/80 text-xl text-white shadow-lg shadow-black/40 backdrop-blur transition-opacity hover:bg-zinc-900 disabled:pointer-events-none disabled:opacity-0 lg:flex';

  return (
    <>
      <button
        type="button"
        aria-label={`Scroll ${label} back`}
        data-testid="rail-prev"
        disabled={edges.start}
        onClick={() => page(-1)}
        className={`${button} -left-4`}
      >
        <span aria-hidden>‹</span>
      </button>
      <button
        type="button"
        aria-label={`Scroll ${label} forward`}
        data-testid="rail-next"
        disabled={edges.end}
        onClick={() => page(1)}
        className={`${button} -right-4`}
      >
        <span aria-hidden>›</span>
      </button>
    </>
  );
}
