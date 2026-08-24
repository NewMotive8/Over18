import type { PublicCategoryRail, PublicCharacterCard, PublicClip, PublicHome } from './api';

/**
 * Home presentation logic (US-102.4) — React-free, like its admin siblings,
 * because this repo's web tests run in node with no DOM.
 *
 * WHAT MOVED HERE, AND WHY IT MATTERS. The old lobby invented its own content:
 * `lobbyContent.ts` hard-coded a twelve-entry category list beginning with
 * "All", `personaTags()` derived category membership from
 * `index + displayName.length`, and `personaBadge()` produced NEW/HOT from
 * `index % 4`. None of it came from the CMS, so nothing an operator did in
 * Admin could change what the app showed. Home is now composed server-side and
 * this module only arranges what arrives.
 *
 * NOTHING IN HERE INVENTS CONTENT. There is no fallback that manufactures a
 * rail, no placeholder category and no derived badge. An empty Home renders as
 * empty, which is the honest answer when an operator has published nothing.
 */

/** The fixed rail order. System rails first, then the operator's arrangement. */
export type HomeSectionKind = 'hero' | 'play_with_me' | 'category';

export interface HomeSection {
  kind: HomeSectionKind;
  /** Stable key for React and for tests. */
  key: string;
  title: string;
  /** Present for category rails; the two system rails carry their own data. */
  rail?: PublicCategoryRail;
}

export const PLAY_WITH_ME_TITLE = 'Play with me';

/**
 * The rails, in the order Home renders them.
 *
 * Play with Me is the one FIXED system rail; every published category follows
 * it, so admin ordering applies only to the tail. Encoding that here rather
 * than in the page keeps it testable and keeps the page dumb.
 *
 * RECENTLY ADDED IS NOT A SECTION KIND. It was removed as a product feature,
 * not hidden: there is no branch here that could render it, no title constant
 * to reach for, and no payload field to read. Home is Play with Me, then
 * categories, then the search grid.
 *
 * A rail with no clips is dropped: publishing a category whose content is all
 * unapproved should show nothing, not an empty heading.
 */
export function homeSections(home: PublicHome): HomeSection[] {
  const sections: HomeSection[] = [];
  if (home.playWithMe.length > 0) {
    sections.push({ kind: 'play_with_me', key: 'play-with-me', title: PLAY_WITH_ME_TITLE });
  }
  for (const rail of home.categories) {
    if (rail.clips.length === 0) continue;
    sections.push({ kind: 'category', key: `category-${rail.id}`, title: rail.name, rail });
  }
  return sections;
}

/** True when Home has nothing at all to show. */
export function homeIsEmpty(home: PublicHome): boolean {
  return (
    home.hero.length === 0 &&
    home.playWithMe.length === 0 &&
    home.categories.every((rail) => rail.clips.length === 0) &&
    home.banners.before_search.length === 0 &&
    home.banners.below_results.length === 0
  );
}

/**
 * Where a banner sends someone.
 *
 * External links are returned verbatim — the server has already validated them
 * as https with no credentials, and re-deriving that rule here would create a
 * second definition that could drift. An unresolvable destination yields null
 * and the caller renders a non-navigating card rather than a dead link.
 */
export function bannerHref(banner: {
  destination: {
    kind: string;
    categoryId: string | null;
    characterId: string | null;
    assetId: string | null;
    url: string | null;
  };
}): string | null {
  const { kind, characterId, url } = banner.destination;
  switch (kind) {
    case 'character':
      return characterId ? `/characters/${characterId}` : null;
    case 'external':
      return url;
    case 'category':
    case 'content':
      // Home has no per-category or per-clip destination screen in this ticket.
      // Returning null renders the banner without a link rather than inventing
      // a route that does not exist.
      return null;
    default:
      return null;
  }
}

/** A character's card media, or null when they have no approved content. */
export function cardClip(card: PublicCharacterCard): PublicClip | null {
  return card.clip;
}

/**
 * The default discovery category — the first pill in the strip.
 *
 * DATA, NOT A CONSTANT. That the first one is "Sexy" is a fact about the
 * operator's ordering, not something this module knows: the old lobby
 * hard-coded "All" in first position and there is deliberately no equivalent
 * here. An empty strip has no default, and the grid then shows everything.
 */
export function defaultCategorySlug(
  categories: ReadonlyArray<{ slug: string }>,
): string | null {
  return categories[0]?.slug ?? null;
}

export type DiscoveryView = 'grid' | 'feed';

/** Toggles the results presentation. Two views, nothing else. */
export function nextView(current: DiscoveryView): DiscoveryView {
  return current === 'grid' ? 'feed' : 'grid';
}

/** Human count for the results header. */
export function resultsLabel(total: number, query: string, categoryName: string | null): string {
  const noun = total === 1 ? 'clip' : 'clips';
  if (query.trim()) return `${total} ${noun} matching "${query.trim()}"`;
  if (categoryName) return `${total} ${noun} in ${categoryName}`;
  return `${total} ${noun}`;
}
