import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  audienceMatches,
  HOME_BANNER_SLOTS,
  type BannerViewer,
  type HomeBannerSlot,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import {
  appCategories,
  appCategoryAssets,
  characters,
  characterVisualAssets,
  homeHeroClips,
  homePlayWithMeCharacters,
  homeRecentCharacters,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { PUBLISHABLE_STATUS } from './app-merchandising-service.js';
import { mediaTypeOf } from './content-review-service.js';
import { publicAssetUrl, publiclyReachableCondition } from './public-media-service.js';
import { listEligibleHomeBanners } from './home-banner-service.js';
import {
  publicBannerCreativeUrl,
  type BannerCreativeStorage,
} from './banner-creative-service.js';

/**
 * Home composition (US-102.4).
 *
 * THE ONE PLACE THAT DECIDES WHAT HOME IS. Every rail, every banner slot and
 * every clip on the public Home surface is assembled here and nowhere else, so
 * "what does the app show" has a single answer that can be read in one file.
 *
 * IT COMPOSES; IT DOES NOT OWN. The pieces already belong to earlier tickets and
 * are consumed through their own functions rather than re-queried:
 *   - US-102.1 owns categories and their identity.
 *   - US-102.2 owns what is in a category and what "publishable" means.
 *   - US-102.3 owns banners, their schedule, their audience and their
 *     eligibility. This file adds only WHERE a banner renders.
 * Nothing here writes to any of them.
 *
 * PUBLISHABILITY IS RE-ASKED ON EVERY READ, never stored. An asset that loses
 * approval leaves Home immediately and returns by itself if approved again; a
 * category unpublished from Home stops rendering without its assignments being
 * touched. There is no cache, no materialised arrangement and no job.
 *
 * THE PUBLIC PROJECTION IS NARROW ON PURPOSE. `listPublishableCategoryAssets`
 * returns the ADMIN row shape — status, contentRating, featured, publishable,
 * and an admin-gated previewUrl. None of that may reach an anonymous browser,
 * so this module builds its own minimal view rather than forwarding one.
 *
 * TWO SYSTEM RAILS, THEN THE OPERATOR'S. Play with Me and Recently Added are
 * fixed and unordered by the admin; published CMS categories follow, in
 * `home_position` order. That ordering is a product decision recorded in the
 * ticket, not an emergent property of the queries.
 */

/** Recently Added's default size when no operator override exists. */
export const RECENTLY_ADDED_DEFAULT_LIMIT = 12;

/** How many clips a Home category rail carries. Rails are previews, not pages. */
export const CATEGORY_RAIL_LIMIT = 24;

/* ------------------------------------------------------------------ *
 * Public projections — deliberately minimal
 * ------------------------------------------------------------------ */

export interface PublicClipView {
  id: string;
  mediaType: 'image' | 'video';
  /** Opaque, id-keyed route. Never a storage key, path or extension. */
  url: string;
  characterId: string;
  characterName: string;
}

export interface PublicCharacterCardView {
  id: string;
  /** Stable slug. The lobby's card components key their local clip manifest on it. */
  name: string;
  displayName: string;
  shortBio: string;
  /**
   * The legacy display locator on `characters` — NOT a storage key. This column
   * has always been an opaque locator chosen by an operator (a URL or a
   * web-served path), never a filesystem path, so exposing it leaks nothing the
   * media route protects. It is the card's last-resort image.
   */
  profileImage: string | null;
  /**
   * The App Categories this character's publicly reachable clips belong to.
   * Real CMS membership — the card chips are editorial, not decoration.
   */
  categories: Array<{ slug: string; name: string }>;
  /** One representative approved clip, or null when the character has none. */
  clip: PublicClipView | null;
}

export interface PublicHomeBannerView {
  id: string;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  /** Opaque creative locator, or null when the banner has no creative. */
  creativeUrl: string | null;
  creativeMediaType: 'image' | 'video' | null;
  destination: { kind: string; categoryId: string | null; characterId: string | null; assetId: string | null; url: string | null };
}

export interface PublicCategoryRailView {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  clips: PublicClipView[];
}

export interface PublicHomeView {
  banners: Record<HomeBannerSlot, PublicHomeBannerView[]>;
  hero: PublicClipView[];
  playWithMe: PublicCharacterCardView[];
  recentlyAdded: PublicCharacterCardView[];
  categories: PublicCategoryRailView[];
}

function clipView(
  asset: Pick<CharacterVisualAssetRow, 'id' | 'characterId' | 'storageKey' | 'provenance'>,
  characterName: string,
): PublicClipView | null {
  const url = publicAssetUrl(asset.id, asset.storageKey);
  if (!url) return null;
  return {
    id: asset.id,
    mediaType: mediaTypeOf(asset.storageKey, asset.provenance) === 'video' ? 'video' : 'image',
    url,
    characterId: asset.characterId,
    characterName,
  };
}

/* ------------------------------------------------------------------ *
 * Representative clip for a character card
 * ------------------------------------------------------------------ */

/**
 * One approved clip to represent a character on a card.
 *
 * Deterministic and preference-ordered rather than random or "featured": a
 * canonical reference first (that is what the character has chosen to look
 * like), then any approved asset, oldest first so the choice is stable between
 * requests. A character with no approved content gets a null clip and the card
 * renders its fallback — it is NOT dropped from the rail, because presence in
 * Play with Me is about the character, not about their media.
 *
 * Fetched for the whole rail in one query rather than per character: N cards
 * must not become N round trips.
 */
export async function representativeClips(
  db: Db,
  characterIds: string[],
): Promise<Map<string, PublicClipView>> {
  const found = new Map<string, PublicClipView>();
  if (characterIds.length === 0) return found;

  const rows = await db
    .select({
      id: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      isCanonical: characterVisualAssets.isCanonical,
      characterName: characters.displayName,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(
      // The SAME predicate the media route enforces. Choosing a clip the media
      // route would refuse gives every card a broken image; this makes the two
      // agree by construction rather than by coincidence.
      and(inArray(characterVisualAssets.characterId, characterIds), publiclyReachableCondition()),
    )
    // Canonical first, then oldest — a stable, explainable choice.
    .orderBy(
      desc(characterVisualAssets.isCanonical),
      asc(characterVisualAssets.createdAt),
      asc(characterVisualAssets.id),
    );

  for (const row of rows) {
    if (found.has(row.characterId)) continue;
    const view = clipView(row, row.characterName);
    if (view) found.set(row.characterId, view);
  }
  return found;
}

async function characterCards(
  db: Db,
  rows: Array<{
    id: string;
    name: string;
    displayName: string;
    shortBio: string;
    profileImage: string | null;
  }>,
): Promise<PublicCharacterCardView[]> {
  const ids = rows.map((row) => row.id);
  const [clips, categories] = await Promise.all([
    representativeClips(db, ids),
    characterCategoryNames(db, ids),
  ]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    shortBio: row.shortBio,
    profileImage: row.profileImage,
    categories: categories.get(row.id) ?? [],
    clip: clips.get(row.id) ?? null,
  }));
}

/**
 * Which enabled App Categories each character appears in, via a publicly
 * reachable clip.
 *
 * The card chips in the lobby are these names. They were previously derived in
 * the browser from `index + displayName.length`, which produced stable-looking
 * but entirely invented tags; they are now real editorial membership, so what a
 * visitor reads on a card matches what an operator assigned.
 */
async function characterCategoryNames(
  db: Db,
  characterIds: string[],
): Promise<Map<string, Array<{ slug: string; name: string }>>> {
  const found = new Map<string, Array<{ slug: string; name: string }>>();
  if (characterIds.length === 0) return found;

  const rows = await db
    .selectDistinct({
      characterId: characterVisualAssets.characterId,
      slug: appCategories.slug,
      name: appCategories.name,
      position: appCategories.position,
    })
    .from(appCategoryAssets)
    .innerJoin(appCategories, eq(appCategories.id, appCategoryAssets.categoryId))
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, appCategoryAssets.assetId))
    .where(
      and(
        inArray(characterVisualAssets.characterId, characterIds),
        eq(appCategories.enabled, true),
        eq(appCategories.homePublished, true),
        publiclyReachableCondition(),
      ),
    )
    .orderBy(asc(appCategories.position), asc(appCategories.slug));

  for (const row of rows) {
    const list = found.get(row.characterId) ?? [];
    list.push({ slug: row.slug, name: row.name });
    found.set(row.characterId, list);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Hero — admin-assigned only
 * ------------------------------------------------------------------ */

/**
 * The Hero carousel: exactly the clips an admin assigned, in their order,
 * filtered to those still approved.
 *
 * No performance input of any kind. This product records no views, plays or
 * impressions, and the ticket states the editorial/performance mixing rule is
 * still unspecified — so inventing a proxy here would be inventing product.
 */
export async function listHeroClips(db: Db): Promise<PublicClipView[]> {
  const rows = await db
    .select({
      id: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      characterName: characters.displayName,
      position: homeHeroClips.position,
    })
    .from(homeHeroClips)
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, homeHeroClips.assetId))
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    // Approved AND owned by an active character: every rail links to a
    // character profile, and a retired character's profile is a 404.
    .where(and(eq(characterVisualAssets.status, PUBLISHABLE_STATUS), eq(characters.status, 'active')))
    .orderBy(asc(homeHeroClips.position), asc(homeHeroClips.assetId));

  return rows
    .map((row) => clipView(row, row.characterName))
    .filter((clip): clip is PublicClipView => clip !== null);
}

/* ------------------------------------------------------------------ *
 * Play with Me — active characters, one card each
 * ------------------------------------------------------------------ */

/**
 * Every active character, one card each, represented by an approved clip.
 *
 * NOT a presence rail. This product has no online/offline state — the ticket
 * defers presence to later work and explicitly says not to fabricate it — so
 * membership is simply "active", which is the only truth the schema holds.
 */
export async function listPlayWithMe(db: Db): Promise<PublicCharacterCardView[]> {
  // CURATED WINS WHOLE. A single row in the override table makes that list the
  // rail entirely — the automatic rule below is not consulted, so an operator's
  // arrangement is never topped up with characters they did not choose. Same
  // rule Recently Added and the Hero already follow.
  const curated = await db
    .select({
      id: characters.id,
      displayName: characters.displayName,
      name: characters.name,
      shortBio: characters.shortBio,
      profileImage: characters.profileImage,
      position: homePlayWithMeCharacters.position,
    })
    .from(homePlayWithMeCharacters)
    .innerJoin(characters, eq(characters.id, homePlayWithMeCharacters.characterId))
    // A curated character who is retired still leaves the rail: publication
    // gating is not something curation can override.
    .where(eq(characters.status, 'active'))
    .orderBy(
      asc(homePlayWithMeCharacters.position),
      asc(homePlayWithMeCharacters.characterId),
    );

  if (curated.length > 0) return characterCards(db, curated);

  // AUTOMATIC, unchanged: every active character, alphabetically.
  const rows = await db
    .select({
      id: characters.id,
      displayName: characters.displayName,
      name: characters.name,
      shortBio: characters.shortBio,
      profileImage: characters.profileImage,
    })
    .from(characters)
    .where(eq(characters.status, 'active'))
    .orderBy(asc(characters.displayName), asc(characters.id));
  return characterCards(db, rows);
}

/* ------------------------------------------------------------------ *
 * Recently Added — 12 newest by default, curated when overridden
 * ------------------------------------------------------------------ */

/**
 * The Recently Added rail.
 *
 * EMPTY OVERRIDE TABLE MEANS DEFAULT: the 12 newest active characters, computed
 * per read. Once an operator adds, removes or reorders anything the table holds
 * the explicit list and that is used verbatim. Clearing it restores the
 * automatic behaviour — which is what makes the operator's changes reversible
 * without a second "mode" flag to get out of sync.
 *
 * Inactive characters are filtered from BOTH paths, so deactivating a character
 * removes them from a curated rail without the curation being rewritten.
 */
export async function listRecentlyAdded(db: Db): Promise<PublicCharacterCardView[]> {
  const curated = await db
    .select({
      id: characters.id,
      displayName: characters.displayName,
      name: characters.name,
      shortBio: characters.shortBio,
      profileImage: characters.profileImage,
      position: homeRecentCharacters.position,
    })
    .from(homeRecentCharacters)
    .innerJoin(characters, eq(characters.id, homeRecentCharacters.characterId))
    .where(eq(characters.status, 'active'))
    .orderBy(asc(homeRecentCharacters.position), asc(homeRecentCharacters.characterId));

  if (curated.length > 0) return characterCards(db, curated);

  const newest = await db
    .select({
      id: characters.id,
      displayName: characters.displayName,
      name: characters.name,
      shortBio: characters.shortBio,
      profileImage: characters.profileImage,
    })
    .from(characters)
    .where(eq(characters.status, 'active'))
    .orderBy(desc(characters.createdAt), asc(characters.id))
    .limit(RECENTLY_ADDED_DEFAULT_LIMIT);
  return characterCards(db, newest);
}

/** True when an operator has taken manual control of Recently Added. */
export async function recentlyAddedIsCurated(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(homeRecentCharacters);
  return Number(row?.count ?? 0) > 0;
}

/* ------------------------------------------------------------------ *
 * Category rails
 * ------------------------------------------------------------------ */

/**
 * The published Home category rails, in the operator's Home order.
 *
 * BOTH GATES. A rail renders only when the category is `enabled` (it exists and
 * is usable) AND `home_published` (an operator deliberately put it on Home).
 * They are independent: a category can be enabled and absent from Home, which
 * is the normal state for most of them.
 *
 * Clip approval is joined in the same query rather than filtered after, so an
 * unapproved asset has no code path to a public rail — the same construction
 * US-102.2 used for its publishable read, for the same reason.
 */
export async function listHomeCategoryRails(db: Db): Promise<PublicCategoryRailView[]> {
  const cats = await db
    .select()
    .from(appCategories)
    .where(and(eq(appCategories.enabled, true), eq(appCategories.homePublished, true)))
    .orderBy(asc(appCategories.homePosition), asc(appCategories.id));

  if (cats.length === 0) return [];

  const rows = await db
    .select({
      categoryId: appCategoryAssets.categoryId,
      position: appCategoryAssets.position,
      id: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      characterName: characters.displayName,
    })
    .from(appCategoryAssets)
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, appCategoryAssets.assetId))
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(
      and(
        inArray(
          appCategoryAssets.categoryId,
          cats.map((c) => c.id),
        ),
        eq(characterVisualAssets.status, PUBLISHABLE_STATUS),
        // Same rule as the Hero: a retired character's clips leave the app with
        // them, rather than becoming tiles that link to a 404.
        eq(characters.status, 'active'),
      ),
    )
    .orderBy(asc(appCategoryAssets.position), asc(appCategoryAssets.assetId));

  const byCategory = new Map<string, PublicClipView[]>();
  for (const row of rows) {
    const list = byCategory.get(row.categoryId) ?? [];
    if (list.length >= CATEGORY_RAIL_LIMIT) continue;
    const view = clipView(row, row.characterName);
    if (view) list.push(view);
    byCategory.set(row.categoryId, list);
  }

  return cats.map((category) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    tagline: category.tagline,
    clips: byCategory.get(category.id) ?? [],
  }));
}

/* ------------------------------------------------------------------ *
 * Banner slots
 * ------------------------------------------------------------------ */

/**
 * Eligible banners, grouped into the two Home slots.
 *
 * ELIGIBILITY IS NOT DECIDED HERE. listEligibleHomeBanners (US-102.3) already
 * applies status, schedule window, dependency health and audience; this only
 * asks where each survivor renders. Re-implementing any part of that filter
 * would create a second, drifting definition of "publicly visible banner".
 *
 * Every slot is always present in the result, possibly empty, so the client
 * renders nothing rather than crashing on a missing key.
 */
export async function listHomeBannerSlots(
  db: Db,
  storage: BannerCreativeStorage,
  options: { now: Date; viewer: BannerViewer },
): Promise<Record<HomeBannerSlot, PublicHomeBannerView[]>> {
  const eligible = await listEligibleHomeBanners(db, storage, options);

  const slots: Record<HomeBannerSlot, PublicHomeBannerView[]> = {
    before_search: [],
    below_results: [],
  };

  for (const banner of eligible) {
    const slot: HomeBannerSlot = HOME_BANNER_SLOTS.includes(banner.slot as HomeBannerSlot)
      ? (banner.slot as HomeBannerSlot)
      : 'before_search';
    slots[slot].push({
      id: banner.id,
      title: banner.title,
      subtitle: banner.subtitle,
      ctaLabel: banner.ctaLabel,
      // The PUBLIC locator, never banner.creative.fileUrl — that one is the
      // admin route and would 401 for every anonymous visitor.
      creativeUrl: banner.creative ? publicBannerCreativeUrl(banner.creative.id) : null,
      creativeMediaType: banner.creative ? banner.creative.mediaType : null,
      destination: {
        kind: banner.destination.kind,
        categoryId: banner.destination.categoryId,
        characterId: banner.destination.characterId,
        assetId: banner.destination.assetId,
        url: banner.destination.url,
      },
    });
  }
  return slots;
}

/* ------------------------------------------------------------------ *
 * The whole surface
 * ------------------------------------------------------------------ */

/**
 * Everything Home needs, in one payload.
 *
 * One `now` for the whole composition, threaded from the route, so a single
 * response can never straddle a schedule boundary and show one banner as live
 * and its neighbour as expired from two different clock reads — the same
 * discipline US-102.3 applies inside its own routes.
 */
export async function composeHome(
  db: Db,
  storage: BannerCreativeStorage,
  options: { now: Date; viewer: BannerViewer },
): Promise<PublicHomeView> {
  const [banners, assignedHero, playWithMe, recentlyAdded, categories] = await Promise.all([
    listHomeBannerSlots(db, storage, options),
    listHeroClips(db),
    listPlayWithMe(db),
    listRecentlyAdded(db),
    listHomeCategoryRails(db),
  ]);
  // AN UNCONFIGURED HERO FALLS BACK; A CONFIGURED ONE NEVER DOES. See
  // heroFallback: assignment is the operator's statement of intent, and once
  // they have made it nothing may add to or override it.
  const hero = assignedHero.length > 0 ? assignedHero : heroFallback(playWithMe);
  return { banners, hero, playWithMe, recentlyAdded, categories };
}

/** How many characters the unconfigured Hero shows. Matches what it always showed. */
export const HERO_FALLBACK_LIMIT = 3;

/**
 * The Hero when an operator has assigned no clips.
 *
 * WHY THERE IS A FALLBACK AT ALL. The Hero is the first thing on Home. Before
 * the CMS existed it always rendered something, and an empty page-top is a
 * worse default than a reasonable one — so an unconfigured Hero borrows the
 * clips Play with Me already resolved rather than going blank.
 *
 * WHY IT IS SAFE. It invents nothing and relaxes nothing. Every clip here came
 * from `representativeClips`, which applies `publiclyReachableCondition` — the
 * same predicate the media route enforces — so the fallback can only ever show
 * a clip that was already public on this page. Characters with no publicly
 * reachable clip contribute nothing, and if none qualify the Hero is empty,
 * exactly as before.
 *
 * WHY IT IS NOT A MERGE. The moment an operator assigns one clip, that list is
 * the Hero, whole. A fallback that topped up a short assigned list would put
 * clips on the front page that nobody chose.
 */
export function heroFallback(cards: readonly PublicCharacterCardView[]): PublicClipView[] {
  const clips: PublicClipView[] = [];
  for (const card of cards) {
    if (clips.length >= HERO_FALLBACK_LIMIT) break;
    if (card.clip) clips.push(card.clip);
  }
  return clips;
}

/** Re-exported so callers do not reach past this module for the audience rule. */
export { audienceMatches };

/* ------------------------------------------------------------------ *
 * The lobby's browse surface: pills and the character grid
 *
 * ONE EDITORIAL SYSTEM. The pills are App Categories — the same categories an
 * operator merchandises, with the same explicit membership and the same
 * operator-chosen order. Discovery categories are NOT exposed here: they remain
 * the keyword index behind free-text search and the landing point for future
 * automatic tagging, so nobody has to understand two category systems to put a
 * clip on the front page.
 *
 * A CATEGORY HOLDS CLIPS; THE LOBBY SHOWS CHARACTERS. Selecting a pill
 * therefore asks "which characters have at least one publicly reachable clip in
 * this category" — computed here, once, rather than guessed in the browser.
 * ------------------------------------------------------------------ */

export interface PublicCategoryPillView {
  id: string;
  slug: string;
  name: string;
}

/**
 * The pills, in the operator's CMS order.
 *
 * PUBLISHED IS THE PUBLIC GATE, and it is one switch. A pill is offered only
 * for a category that is both enabled and published to Home — the same
 * condition that makes its clips publicly reachable at all. Offering a pill for
 * an unpublished category would put a filter on the front page that is
 * guaranteed to return nobody, which reads as a broken app rather than as
 * unpublished configuration.
 */
export async function listPublicCategoryPills(db: Db): Promise<PublicCategoryPillView[]> {
  const rows = await db
    .select({ id: appCategories.id, slug: appCategories.slug, name: appCategories.name })
    .from(appCategories)
    .where(and(eq(appCategories.enabled, true), eq(appCategories.homePublished, true)))
    .orderBy(asc(appCategories.position), asc(appCategories.id));
  return rows;
}

/**
 * The character grid: active characters, newest first, optionally narrowed by a
 * category pill and/or the search box.
 *
 * NO CATEGORY MEANS NO CATEGORY FILTER — the unfiltered "All" state. That is
 * the default and it is why search works before any category exists. An unknown
 * slug is treated the same way rather than returning nothing, so a stale link
 * degrades to browsing instead of to an empty page.
 *
 * The category clause requires a publicly reachable clip in that category, so a
 * pill can never advertise a character whose clips are all unapproved, retired
 * or otherwise not servable. Both filters are independent and combine with AND.
 */
export async function browsePublicCharacters(
  db: Db,
  options: { categorySlug?: string | null; query?: string | null } = {},
): Promise<PublicCharacterCardView[]> {
  const conditions = [eq(characters.status, 'active')];

  const slug = options.categorySlug?.trim();
  if (slug) {
    // Membership is resolved to asset ids FIRST rather than correlated inline.
    // `publiclyReachableCondition` is written against `character_visual_assets`
    // as the outer table, so embedding it in a subquery that joins that same
    // table again would correlate the wrong row — a class of bug that silently
    // returns nothing rather than failing.
    const memberIds = await db
      .select({ characterId: characterVisualAssets.characterId })
      .from(appCategoryAssets)
      .innerJoin(appCategories, eq(appCategories.id, appCategoryAssets.categoryId))
      .innerJoin(
        characterVisualAssets,
        eq(characterVisualAssets.id, appCategoryAssets.assetId),
      )
      .where(
        and(
          eq(appCategories.slug, slug),
          eq(appCategories.enabled, true),
          eq(appCategories.homePublished, true),
          publiclyReachableCondition(),
        ),
      );
    const characterIds = [...new Set(memberIds.map((row) => row.characterId))];
    // An empty or unknown category matches NOTHING, never everything — the
    // same rule discovery applies. Silently widening to the whole roster would
    // make a misconfigured pill look like it was working.
    if (characterIds.length === 0) return [];
    conditions.push(inArray(characters.id, characterIds));
  }

  const query = options.query?.trim();
  if (query) {
    // Escaped so a literal % or _ typed by a visitor is matched, not treated as
    // a wildcard. Same rule the discovery search uses.
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    conditions.push(sql`${characters.displayName} ilike ${'%' + escaped + '%'} escape '\\'`);
  }

  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      displayName: characters.displayName,
      shortBio: characters.shortBio,
      profileImage: characters.profileImage,
    })
    .from(characters)
    .where(and(...conditions))
    .orderBy(desc(characters.createdAt), asc(characters.id));

  return characterCards(db, rows);
}
