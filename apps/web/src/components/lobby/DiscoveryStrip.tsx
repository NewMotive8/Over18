import { useState } from 'react';
import type { PublicDiscoveryCategory } from '../../lib/api';
import { FilterIcon } from '../icons';

/**
 * The keyword-driven Discovery category strip (US-102.4).
 *
 * THE FILTER CONTROL STAYS FIXED WHILE THE PILLS SCROLL BEHIND IT. That is a
 * structural change, not styling: the previous version passed the funnel button
 * into CategoryPills as a `leading` child, which put it INSIDE the scrolling
 * track, so it slid away with the pills. Here the button is a sibling of the
 * track, outside `overflow-x-auto`, and a gradient mask on the track's left
 * edge makes the pills visibly pass under it.
 *
 * THE PILLS ARE CMS DATA. There is no hard-coded list and no "All" entry — the
 * first pill is whatever the operator ordered first, which the ticket says is
 * "Sexy". The component does not know that name and must not.
 *
 * These are NOT App CMS Categories. They are keyword queries over all content
 * and share nothing with the Home rails above them.
 */
export default function DiscoveryStrip({
  categories,
  active,
  onSelect,
}: {
  categories: PublicDiscoveryCategory[];
  active: string | null;
  onSelect: (slug: string) => void;
}) {
  const [showFilters, setShowFilters] = useState(false);

  if (categories.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-2">
        {/* Outside the scroller: this is what "the filter icon stays fixed" means. */}
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          aria-label="Advanced filters"
          aria-expanded={showFilters}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${
            showFilters
              ? 'border-rose-500/60 bg-rose-500/15 text-rose-300'
              : 'border-white/10 bg-white/5 text-zinc-300 hover:text-white'
          }`}
        >
          <FilterIcon className="h-[18px] w-[18px]" />
        </button>

        <div className="relative min-w-0 flex-1">
          {/* Pills visibly pass under the fixed control. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-4 bg-gradient-to-r from-zinc-950 to-transparent"
          />
          <div
            data-testid="discovery-pill-track"
            className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {categories.map((category) => {
              const isActive = category.slug === active;
              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => onSelect(category.slug)}
                  aria-pressed={isActive}
                  className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                    isActive
                      ? 'bg-white text-zinc-950'
                      : 'bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {category.name}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {showFilters && (
        <div className="rounded-2xl border border-white/10 bg-zinc-900/70 p-3 text-xs text-zinc-400">
          <p className="font-semibold text-zinc-300">Advanced filters</p>
          <p className="mt-1">
            Refine by body type, personality and availability. Full filtering arrives in a later
            release — categories and search are live now.
          </p>
        </div>
      )}
    </div>
  );
}
