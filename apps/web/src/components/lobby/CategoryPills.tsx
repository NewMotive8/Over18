import type { ReactNode } from 'react';
import type { Category } from '../../lib/lobbyContent';

/**
 * Horizontal pill-shaped category selector (US-28 / v2 brief §1).
 *
 * Used both as the initial filter tabs under the header and as the scrolled
 * Discovery Hub chips. The row scrolls horizontally and intentionally lets the
 * right-most pills bleed off-screen on mobile to cue that there's more. An
 * optional `leading` slot hosts the Advanced-Filter funnel button.
 */
export default function CategoryPills({
  categories,
  active,
  onSelect,
  leading,
  size = 'md',
}: {
  categories: readonly Category[];
  active: Category;
  onSelect: (category: Category) => void;
  leading?: ReactNode;
  size?: 'sm' | 'md';
}) {
  const pad = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm';
  return (
    <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {leading}
      {categories.map((category) => {
        const isActive = category === active;
        return (
          <button
            key={category}
            type="button"
            onClick={() => onSelect(category)}
            aria-pressed={isActive}
            className={`shrink-0 whitespace-nowrap rounded-full font-semibold transition-colors ${pad} ${
              isActive
                ? 'bg-white text-zinc-950'
                : 'bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white'
            }`}
          >
            {category}
          </button>
        );
      })}
    </div>
  );
}
