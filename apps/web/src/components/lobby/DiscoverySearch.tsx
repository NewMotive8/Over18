import { forwardRef, useState } from 'react';
import type { Category } from '../../lib/lobbyContent';
import { CATEGORIES } from '../../lib/lobbyContent';
import CategoryPills from './CategoryPills';
import { FilterIcon, SearchIcon } from '../icons';

/**
 * Scrolled-state Discovery & Search Hub (US-28 / v2 brief §1).
 *
 * A centered section title, a prominent full-width pill search input with a
 * trailing search icon, an Advanced-Filter funnel button, and horizontally
 * scrolling adult-safe category chips. The funnel toggles a lightweight
 * placeholder panel (UI-only — no backend filtering beyond category + query).
 */
const DiscoverySearch = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQueryChange: (value: string) => void;
    active: Category;
    onSelectCategory: (category: Category) => void;
  }
>(function DiscoverySearch({ query, onQueryChange, active, onSelectCategory }, ref) {
  const [showFilters, setShowFilters] = useState(false);

  return (
    <section aria-label="Discover companions" className="flex flex-col gap-3 px-4">
      <h2 className="text-center text-xl font-black tracking-tight text-white">
        Over18 <span className="text-rose-500">AI Companions</span>
      </h2>

      <div className="relative">
        <input
          ref={ref}
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search companions by name…"
          aria-label="Search companions"
          className="w-full rounded-full border border-white/10 bg-white/5 py-3 pl-5 pr-12 text-sm text-white placeholder:text-zinc-500 focus:border-rose-500/60 focus:outline-none"
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400">
          <SearchIcon className="h-5 w-5" />
        </span>
      </div>

      <CategoryPills
        categories={CATEGORIES}
        active={active}
        onSelect={onSelectCategory}
        size="sm"
        leading={
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
        }
      />

      {showFilters && (
        <div className="rounded-2xl border border-white/10 bg-zinc-900/70 p-3 text-xs text-zinc-400">
          <p className="font-semibold text-zinc-300">Advanced filters</p>
          <p className="mt-1">
            Refine by body type, personality and availability. Full filtering arrives in a later
            release — categories and search are live now.
          </p>
        </div>
      )}
    </section>
  );
});

export default DiscoverySearch;
