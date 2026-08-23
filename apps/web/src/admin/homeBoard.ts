import type { HomeCategoryView, PublicHome, RecentlyAddedAdminView } from '../lib/api';

/**
 * Admin Home-composition presentation logic (US-102.4) — React-free, like its
 * siblings, because this repo's web tests run in node with no DOM.
 *
 * Only wording and arrangement live here. Every truth it describes — what is
 * published, what is publishable, what Home would render — is decided by the
 * server and simply reported.
 */

/** The two Home banner slots, in page order, with operator-facing labels. */
export const HOME_SLOTS = [
  {
    key: 'before_search' as const,
    label: 'Before Search',
    hint: 'Shown after the category rails and immediately above the search section.',
  },
  {
    key: 'below_results' as const,
    label: 'Below results',
    hint: 'Shown under the search results, above the footer.',
  },
];

export function slotLabel(slot: string): string {
  return HOME_SLOTS.find((s) => s.key === slot)?.label ?? slot;
}

/**
 * Why a published category would still show nothing.
 *
 * Publishing something that cannot render is the failure an operator is most
 * likely to hit and least likely to notice, so the reason is spelled out rather
 * than left as a silent absence on the app.
 */
export function emptyReason(category: HomeCategoryView): string | null {
  if (!category.homePublished) return null;
  if (!category.enabled) {
    return 'Published to Home, but the category is disabled — nothing will show until you enable it.';
  }
  if (category.publishableAssetCount === 0) {
    return category.assetCount === 0
      ? 'Published to Home, but it has no content yet. Add approved content in Categories.'
      : 'Published to Home, but none of its content is approved right now, so nothing will show.';
  }
  return null;
}

/** "8 of 11 approved" — what Home would actually render versus what is assigned. */
export function contentSummary(category: HomeCategoryView): string {
  if (category.assetCount === 0) return 'No content assigned';
  if (category.publishableAssetCount === category.assetCount) {
    return `${category.assetCount} item${category.assetCount === 1 ? '' : 's'}`;
  }
  return `${category.publishableAssetCount} of ${category.assetCount} approved`;
}

export interface HomeTotals {
  published: number;
  total: number;
  needsAttention: number;
}

export function summariseHome(categories: readonly HomeCategoryView[]): HomeTotals {
  return {
    total: categories.length,
    published: categories.filter((c) => c.homePublished).length,
    needsAttention: categories.filter((c) => c.wouldRenderEmpty).length,
  };
}

/** Published categories only, in Home order — the list the operator arranges. */
export function publishedInOrder(categories: readonly HomeCategoryView[]): HomeCategoryView[] {
  return categories
    .filter((c) => c.homePublished)
    .slice()
    .sort((a, b) => a.homePosition - b.homePosition || a.id.localeCompare(b.id));
}

export function unpublished(categories: readonly HomeCategoryView[]): HomeCategoryView[] {
  return categories.filter((c) => !c.homePublished);
}

/** How Recently Added is currently behaving, in one sentence. */
export function recentModeLabel(view: RecentlyAddedAdminView): string {
  return view.curated
    ? 'Custom list — you have arranged this rail by hand.'
    : 'Automatic — the 12 newest characters. Any edit switches this to a custom list.';
}

/** A one-line description of what a preview payload contains. */
export function previewSummary(home: PublicHome): string {
  const rails = home.categories.filter((c) => c.clips.length > 0).length;
  const banners = home.banners.before_search.length + home.banners.below_results.length;
  return [
    `${home.hero.length} hero clip${home.hero.length === 1 ? '' : 's'}`,
    `${home.playWithMe.length} in Play with me`,
    `${home.recentlyAdded.length} recently added`,
    `${rails} category rail${rails === 1 ? '' : 's'}`,
    `${banners} banner${banners === 1 ? '' : 's'}`,
  ].join(' · ');
}
