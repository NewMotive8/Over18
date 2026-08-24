import type {
  HomeCategoryView,
  PublicClip,
  PublicHome,
} from '../lib/api';

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

/** A one-line description of what a preview payload contains. */
export function previewSummary(home: PublicHome): string {
  const rails = home.categories.filter((c) => c.clips.length > 0).length;
  const banners = home.banners.before_search.length + home.banners.below_results.length;
  return [
    `${home.hero.length} hero clip${home.hero.length === 1 ? '' : 's'}`,
    `${home.playWithMe.length} in Play with me`,
    `${rails} category rail${rails === 1 ? '' : 's'}`,
    `${banners} banner${banners === 1 ? '' : 's'}`,
  ].join(' · ');
}

/* ------------------------------------------------------------------ *
 * Hero: configured versus fallback
 *
 * These are different things and the screen must never blur them. A Hero with
 * clips is the operator's explicit choice, in their order. A Hero with none
 * makes the app borrow representative clips so the top of the page is not
 * blank — that borrowing is computed per request, is never written down, and
 * is not an assignment. An operator who cannot tell them apart will believe
 * they configured something they did not.
 * ------------------------------------------------------------------ */

export type HeroMode = 'configured' | 'fallback';

export function heroMode(assigned: readonly unknown[]): HeroMode {
  return assigned.length > 0 ? 'configured' : 'fallback';
}

/** The heading state, said plainly. */
export function heroModeLabel(mode: HeroMode): string {
  return mode === 'configured'
    ? 'Configured — the app shows exactly these clips, in this order.'
    : 'Not configured — the app is temporarily showing borrowed clips. Add clips to choose.';
}

/**
 * What the fallback is doing, for the panel that shows it.
 *
 * Says "borrowed" and "not saved" in as many words, because the failure this
 * prevents is an operator seeing a full Hero on the app and assuming it is
 * theirs.
 */
export function heroFallbackNote(clips: readonly PublicClip[]): string {
  if (clips.length === 0) {
    return 'Nothing is eligible to borrow, so the Hero is empty on the app right now.';
  }
  const n = clips.length;
  return `Borrowed: ${n} clip${n === 1 ? '' : 's'} the app is showing because no Hero clip is chosen. This is not saved, and adding a single clip above replaces it entirely.`;
}

/* ------------------------------------------------------------------ *
 * Play with me has NO ADMIN SURFACE
 *
 * The rail is one deterministic rule — active character, her newest publicly
 * reachable video, one card. There are no modes to label, no picker rows to
 * derive and no consequence to warn about, so none of that lives here any more.
 * An operator who wants a character on the rail approves and publishes a video
 * of hers.
 * ------------------------------------------------------------------ */
