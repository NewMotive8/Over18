import { useState } from 'react';
import type { MyAiOption } from '@over18/shared';

/**
 * A row of photographic choice tiles.
 *
 * ── WHY A ROW AND NOT A GRID ────────────────────────────────────────────────
 *
 * Step 3 carries 17 options and step 4 carries 14. As a vertical grid on a
 * phone that is roughly nine screens of scrolling per step, and the photographs
 * — which are the whole reason this flow is worth building — would have to
 * shrink to fit. A horizontal row per attribute keeps each tile large and each
 * STEP to about one screen.
 *
 * The cost of a row is discoverability: what is off the right edge is easy to
 * miss. Two things pay for it. The row is sized so the next tile is always
 * partly visible (`basis` below leaves a deliberate sliver), which is the
 * signal people actually read, and the count sits beside the label so "8
 * styles" is stated rather than implied.
 *
 * `snap-x` means a flick lands on a tile rather than between two.
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
      onClick={onSelect}
      className={`relative shrink-0 snap-start overflow-hidden rounded-xl border text-left transition ${
        selected
          ? 'border-rose-500 ring-1 ring-rose-500'
          : 'border-zinc-800 hover:border-zinc-700'
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
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-100">{label}</h2>
        <span className="text-xs text-zinc-500">{options.length} options</span>
      </div>

      <div
        role="radiogroup"
        aria-label={label}
        data-group={name}
        className={
          layout === 'grid'
            ? 'grid grid-cols-2 gap-3'
            : // -mx-4/px-4 lets the row bleed to the screen edges inside the
              // shell's padded column, so a tile can sit flush at the edge and
              // the next one peeks rather than being clipped by a gutter.
              '-mx-4 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        }
      >
        {options.map((option) => (
          <div key={option.id} className={layout === 'grid' ? '' : 'w-[8.25rem] shrink-0'}>
            <Tile
              option={option}
              selected={value === option.id}
              src={tileUrl(option.id)}
              onSelect={() => onChange(option.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
