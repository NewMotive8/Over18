import { useCallback, useEffect, useRef, useState } from 'react';
import type { MyAiOption } from '@over18/shared';

/**
 * A row of photographic choice tiles.
 *
 * ── WHY A ROW AND NOT A GRID ────────────────────────────────────────────────
 *
 * Step 3 carries 17 options and step 4 carries 14. As a vertical grid on a
 * phone that is roughly nine screens of scrolling per step, and the
 * photographs — which are the whole reason this flow is worth building — would
 * have to shrink to fit. A horizontal row per attribute keeps each tile large
 * and each STEP to about one screen.
 *
 * ── MAKING THE SCROLL VISIBLE, WHICH TOOK TWO GOES ──────────────────────────
 *
 * The first version relied on the next tile peeking past the right edge. On a
 * 390px phone that peek is a sliver and reads as "swipe"; on a 411px one the
 * third tile is ~70% visible and reads as a GRID THAT HAS BEEN CUT OFF — so
 * people stop at three hairstyles and never see the other five. A cue whose
 * meaning flips with the viewport width is not a cue.
 *
 * Three things now say it instead, none of which depend on screen size:
 *   1. An arrow button at each end. It is an affordance AND a control — it
 *      works on a desktop, where there is nothing to swipe at all.
 *   2. A gradient fade under each arrow, so content visibly continues beneath
 *      rather than ending.
 *   3. Both appear ONLY when there is actually more in that direction, so an
 *      arrow is never a lie. A row that fits entirely shows neither.
 */
export interface TileRowProps {
  label: string;
  /** Field name on the draft — also the aria grouping name. */
  name: string;
  options: readonly MyAiOption[];
  value: string | null;
  onChange: (id: string) => void;
  /**
   * The image for an option. Returning null renders the tile as a plain
   * label — which is what the Anime path will do before its art exists.
   */
  tileUrl: (optionId: string) => string | null;
  /**
   * `grid` gives two large tiles per line, for a step that is the only thing
   * on screen (her background). `row` is the default side-scroller.
   */
  layout?: 'row' | 'grid';
}

function Tick() {
  return (
    <span
      aria-hidden
      className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-rose-500 text-white shadow"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
    </svg>
  );
}

function Tile({
  option,
  selected,
  src,
  onSelect,
}: {
  option: MyAiOption;
  selected: boolean;
  src: string | null;
  onSelect: () => void;
}) {
  /*
   * A tile whose photograph fails to load must still be choosable. Hiding the
   * <img> on error leaves the label over the placeholder tint rather than a
   * broken-image glyph, and the button keeps working either way.
   */
  const [broken, setBroken] = useState(false);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-id={option.id}
      onClick={onSelect}
      className={`relative block w-full shrink-0 snap-start overflow-hidden rounded-xl border text-left transition ${
        selected ? 'border-rose-500 ring-1 ring-rose-500' : 'border-zinc-800 hover:border-zinc-700'
      }`}
    >
      <div className="relative aspect-[3/4] w-full bg-zinc-900">
        {src && !broken && (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        )}
        {/* The scrim exists so a pale photograph cannot swallow the label. */}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2.5 pb-2 pt-7 text-sm font-semibold text-white">
          {option.label}
        </span>
        {selected && <Tick />}
      </div>
    </button>
  );
}

export default function TileRow({
  label,
  name,
  options,
  value,
  onChange,
  tileUrl,
  layout = 'row',
}: TileRowProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // A 1px tolerance: sub-pixel layout means scrollLeft rarely lands exactly
    // on the maximum, and without it the right arrow never switches off.
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - 1);
  }, []);

  useEffect(() => {
    if (layout !== 'row') return;
    measure();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Re-measure on rotation or a width change: a row that needed arrows in
    // portrait may fit entirely in landscape.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout, measure, options]);

  const page = (direction: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    /*
     * NO `behavior: 'smooth'`, deliberately.
     *
     * It is prettier and it is not dependable: in a browser that declines to
     * run the animation the call returns having moved nothing at all, and the
     * arrow becomes a button that visibly does nothing. Measured here —
     * `scrollBy({left: 296, behavior:'smooth'})` left scrollLeft at 0 while the
     * identical call with the default behaviour landed on 284.
     *
     * A control that always works beats one that animates when it feels like
     * it. Scroll-snap lands the jump on a tile edge either way, so the result
     * is a clean step rather than a ragged offset.
     *
     * Roughly two tiles, so something already seen stays on screen as an
     * anchor rather than the row jumping to wholly unfamiliar content.
     */
    el.scrollBy({ left: direction * el.clientWidth * 0.72 });

    /*
     * MEASURE HERE RATHER THAN WAITING FOR THE SCROLL EVENT.
     *
     * We just moved it, so we know it moved — asking the DOM now is both
     * simpler and strictly more reliable than waiting to be told. It also
     * means the arrows stay honest in any browser that is stingy with scroll
     * events (this was found in one that dispatches none at all: scrollLeft
     * changed 0 -> 284 while a plain native listener never fired once).
     *
     * The `onScroll` handler stays for the other way in — a finger swipe,
     * where nothing but the event can tell us where we ended up.
     *
     * Safe to call synchronously because the scroll above is not animated.
     */
    measure();
  };

  if (layout === 'grid') {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">{label}</h2>
          <span className="text-xs text-zinc-500">{options.length} options</span>
        </div>
        <div role="radiogroup" aria-label={label} data-group={name} className="grid grid-cols-2 gap-3">
          {options.map((option) => (
            <Tile
              key={option.id}
              option={option}
              selected={value === option.id}
              src={tileUrl(option.id)}
              onSelect={() => onChange(option.id)}
            />
          ))}
        </div>
      </div>
    );
  }

  const scrollable = !(atStart && atEnd);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-100">{label}</h2>
        <span className="text-xs text-zinc-500">
          {scrollable ? `Swipe · ${options.length}` : `${options.length} options`}
        </span>
      </div>

      <div className="relative -mx-4">
        <div
          ref={scroller}
          onScroll={measure}
          role="radiogroup"
          aria-label={label}
          data-group={name}
          /*
           * -mx-4/px-4 lets the row bleed to the screen edges inside the
           * shell's padded column, so a tile can sit flush at the edge and the
           * next one continues under the fade rather than stopping at a gutter.
           */
          /*
           * `scroll-px-4` MATTERS, and its absence is a bug I shipped once.
           * Scroll-snap parks on a tile's own edge, and `px-4` insets the
           * first tile by 16px — so a row at rest sat at scrollLeft 16, the
           * "are we at the start" test failed, and a back arrow pointing at
           * nothing appeared on every row. Scroll padding makes the snapport
           * account for the gutter, so resting at the start really is 0.
           */
          className="flex snap-x scroll-px-4 gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {options.map((option) => (
            <div key={option.id} className="w-[8.25rem] shrink-0">
              <Tile
                option={option}
                selected={value === option.id}
                src={tileUrl(option.id)}
                onSelect={() => onChange(option.id)}
              />
            </div>
          ))}
        </div>

        {/* Fades and arrows, each shown only while there is more that way. */}
        {!atStart && (
          <>
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-zinc-950 to-transparent" />
            <button
              type="button"
              aria-label={`Scroll ${label} back`}
              onClick={() => page(-1)}
              className="absolute left-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/90 text-zinc-200 shadow-lg backdrop-blur transition-colors hover:bg-zinc-800"
            >
              <Chevron dir="left" />
            </button>
          </>
        )}
        {!atEnd && (
          <>
            <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-zinc-950 to-transparent" />
            <button
              type="button"
              aria-label={`Scroll ${label} forward`}
              onClick={() => page(1)}
              className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/90 text-zinc-200 shadow-lg backdrop-blur transition-colors hover:bg-zinc-800"
            >
              <Chevron dir="right" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
