import type {
  HomeCategoryView,
  PlayWithMeAdminView,
  PlayWithMeCandidateView,
  PublicClip,
  PublicHome,
  RecentCandidateView,
  RecentlyAddedAdminView,
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

/** How Recently Added is currently behaving, in one sentence. */
export function recentModeLabel(view: RecentlyAddedAdminView): string {
  return view.curated
    ? 'Custom list — you have arranged this rail by hand.'
    : 'Automatic — the 12 newest characters. Any edit switches this to a custom list.';
}

/** One row of the Recently Added picker. */
export interface RecentPickerRow {
  characterId: string;
  displayName: string;
  createdAt: string;
  /** Already on the rail, so adding again would do nothing. */
  onRail: boolean;
}

/**
 * The Recently Added picker's rows.
 *
 * The eligibility rule is the SERVER'S — `/admin/home/recent/candidates`
 * returns active characters, newest first — and is not re-decided here. The one
 * thing this adds is `onRail`, because that endpoint (unlike the Hero's) does
 * not mark which candidates are already on the rail, and offering an operator a
 * button whose only effect is nothing is worse than showing them why.
 *
 * Derived from the CURRENT rail on every render rather than stored, so it
 * cannot go stale: the moment an add succeeds and the rail comes back, the row
 * it came from reads as already present.
 */
export function recentPickerRows(
  candidates: readonly RecentCandidateView[],
  rail: RecentlyAddedAdminView | null,
): RecentPickerRow[] {
  const present = new Set((rail?.characters ?? []).map((c) => c.characterId));
  return candidates.map((candidate) => ({
    characterId: candidate.characterId,
    displayName: candidate.displayName,
    createdAt: candidate.createdAt,
    onRail: present.has(candidate.characterId),
  }));
}

/**
 * What adding will do to the rail's mode, said before the operator commits.
 *
 * Adding to an automatic rail materialises the current 12 and appends — the
 * server's `ensureCurated`. That is a one-way door until Reset, so it is stated
 * rather than discovered.
 */
export function addRecentConsequence(rail: RecentlyAddedAdminView | null): string {
  return rail?.curated === true
    ? 'Added to the end of your custom list.'
    : 'Adding switches this rail from automatic to a custom list. Reset puts it back.';
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
 * Play with me — the same automatic-versus-curated wording
 *
 * Shares Recently Added's model exactly, so it shares its phrasing: an
 * operator should not have to learn two vocabularies for one idea.
 * ------------------------------------------------------------------ */

/** How the Play with me rail is currently behaving, in one sentence. */
export function playWithMeModeLabel(view: { curated: boolean }): string {
  return view.curated
    ? 'Custom list — you have arranged this rail by hand.'
    : 'Automatic — every active character, alphabetically. Any edit switches this to a custom list.';
}

/**
 * What adding will do to the rail's mode, said before the operator commits.
 *
 * The first edit materialises the automatic list and then applies to it, which
 * is a one-way door until Reset — so it is stated rather than discovered.
 */
export function addPlayWithMeConsequence(view: { curated: boolean } | null): string {
  return view?.curated === true
    ? 'Added to the end of your custom list.'
    : 'Adding switches this rail from automatic to a custom list. Reset puts it back.';
}

/** One row of the Play with me picker. */
export interface PlayWithMePickerRow {
  characterId: string;
  displayName: string;
  createdAt: string;
  profileImage: string | null;
  /** Already on the rail, so adding again would do nothing. */
  onRail: boolean;
}

/**
 * The Play with me picker's rows.
 *
 * Same derivation and same reason as `recentPickerRows` — the candidates
 * endpoint decides eligibility and does not mark who is already on the rail, so
 * `onRail` is computed from the CURRENT rail on every render and cannot go
 * stale. It carries the profile image through so the picker can show a face
 * rather than a name alone.
 */
export function playWithMePickerRows(
  candidates: readonly PlayWithMeCandidateView[],
  rail: PlayWithMeAdminView | null,
): PlayWithMePickerRow[] {
  const present = new Set((rail?.characters ?? []).map((c) => c.characterId));
  return candidates.map((candidate) => ({
    characterId: candidate.characterId,
    displayName: candidate.displayName,
    createdAt: candidate.createdAt,
    profileImage: candidate.profileImage,
    onRail: present.has(candidate.characterId),
  }));
}
