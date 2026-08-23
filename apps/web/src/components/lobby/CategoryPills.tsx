import type { ReactNode } from 'react';
import type { PublicCategoryPill } from '../../lib/api';

/**
 * Horizontal pill-shaped category selector (US-28 / v2 brief §1).
 *
 * The row scrolls horizontally and intentionally lets the right-most pills
 * bleed off-screen on mobile to cue that there's more. An optional `leading`
 * slot hosts the Advanced-Filter funnel button.
 *
 * THE PILLS ARE CMS DATA. They were a hard-coded twelve-entry list; they are
 * now the operator's enabled App Categories, in the operator's own order —
 * the same categories they merchandise in Admin, not a second taxonomy.
 *
 * "ALL" IS FIRST AND IS THE DEFAULT. It maps to `null`, meaning no category
 * filter at all. That is what lets search work before a single category has
 * been configured: with nothing selected the grid is unfiltered rather than
 * scoped to a category that might match nothing.
 */
export default function CategoryPills({
  categories,
  active,
  onSelect,
  leading,
  size = 'md',
}: {
  categories: readonly PublicCategoryPill[];
  /** The selected slug, or null for All. */
  active: string | null;
  onSelect: (slug: string | null) => void;
  leading?: ReactNode;
  size?: 'sm' | 'md';
}) {
  const pad = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm';
  const pill = (key: string, label: string, slug: string | null) => {
    const isActive = active === slug;
    return (
      <button
        key={key}
        type="button"
        onClick={() => onSelect(slug)}
        aria-pressed={isActive}
        className={`shrink-0 whitespace-nowrap rounded-full font-semibold transition-colors ${pad} ${
          isActive
            ? 'bg-white text-zinc-950'
            : 'bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {leading}
      {pill('__all__', 'All', null)}
      {categories.map((category) => pill(category.slug, category.name, category.slug))}
    </div>
  );
}
