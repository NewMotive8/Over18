import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  assetKeywords,
  characterKeywords,
  characterVisualAssets,
  contentKeywords,
  keywordFacets,
} from '../db/schema.js';

/**
 * FACETED FILTERING — the question a filter panel asks, as SQL.
 *
 * WHAT A FACET CHANGES ABOUT MATCHING. A discovery category is a set of
 * keywords matched with OR: one hit is enough, and that is the product rule.
 * A filter panel asks something different. "Blonde" and "Petite" answer two
 * questions, and choosing both means blonde AND petite -- so each facet
 * narrows, while the values inside one facet widen. Both rules live here:
 *
 *   OR WITHIN a facet     one `in (...)` over that facet's chosen keywords;
 *   AND ACROSS facets     one condition PER facet, which the caller hands to
 *                         `and(...)` exactly as it already does for the
 *                         category, the search text and the rating.
 *
 * AND ACROSS IS NOT WRITTEN DOWN ANYWHERE HERE, and that is deliberate. Each
 * facet produces an independent predicate; the conjunction is the caller's
 * existing `and(...conditions)`. Nothing had to learn about facets for them to
 * compose with what was already there.
 *
 * HER KEYWORDS AND THE CLIP'S, IN ONE MATCH. Hair colour is recorded on the
 * character and `beach` on the asset, so a facet matches when EITHER carries
 * the keyword. That union is what lets one filter panel mix "who she is" with
 * "what is in this clip" without the caller knowing which is which.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO.
 *
 *   It never mentions content rating. Explicit visibility is a separate
 *   predicate the caller owns, so making it depend on a subscription later is
 *   a change there and not a change here. A facet that quietly filtered by
 *   rating would make that impossible to move.
 *
 *   It never mentions `facet_id`. An UNFILED keyword -- `beach`, `lingerie`,
 *   `all-key-words` -- is matched by exactly the same `asset_keywords` rows it
 *   always was. Facets add a way to ask a narrower question; they take nothing
 *   out of the vocabulary, and no existing discovery result can disappear
 *   because a keyword was never filed.
 *
 * NO JOIN TO THE OUTER TABLE. Each predicate is a correlated `exists` against
 * `character_visual_assets` as the caller already has it, never a re-join of
 * it -- the mistake `browsePublicClips` documents for category membership,
 * where nesting the outer table correlates the wrong row and silently returns
 * nothing.
 */

/** The query-string prefix a facet selection arrives under: `facet.hair_color=blonde,red-hair`. */
export const FACET_PARAM_PREFIX = 'facet.';

/** One facet and the values chosen inside it, as the request stated them. */
export interface FacetSelection {
  facetKey: string;
  keywordKeys: string[];
}

/** A selection after the database has said which keywords those names are. */
export interface ResolvedFacet {
  facetKey: string;
  keywordIds: string[];
}

/**
 * Reads `facet.<key>=<v1>,<v2>` out of a query string.
 *
 * PURE, and separate from resolving them, because this half is the part worth
 * testing exhaustively: what a visitor can type is open-ended, what the
 * database holds is not. Unknown facet names survive parsing and are refused
 * later by resolution, so a typo cannot be mistaken here for "no filter".
 *
 * Values are trimmed, de-duplicated and emptied-out; a facet left with no
 * values at all is dropped, because "hair colour: nothing" is not a filter.
 */
export function parseFacetParams(query: Record<string, unknown>): FacetSelection[] {
  const selections: FacetSelection[] = [];
  for (const [param, raw] of Object.entries(query ?? {})) {
    if (!param.startsWith(FACET_PARAM_PREFIX)) continue;
    const facetKey = param.slice(FACET_PARAM_PREFIX.length).trim();
    if (!facetKey) continue;
    // A repeated parameter arrives as an array; both spellings mean the same.
    const parts = (Array.isArray(raw) ? raw : [raw])
      .filter((v): v is string => typeof v === 'string')
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    const keywordKeys = [...new Set(parts)];
    if (keywordKeys.length === 0) continue;
    selections.push({ facetKey, keywordKeys });
  }
  return selections;
}

export type SelectionLimitCheck =
  | { ok: true }
  | { ok: false; facetKey: string; chosen: number };

/**
 * Enforces a single-choice facet.
 *
 * Ethnicity is `single` because offering a combination of ethnicities is a
 * question nobody meant to ask. A request that sends two is REFUSED rather
 * than quietly truncated to the first: silently dropping half of what someone
 * asked for produces a result they cannot explain from what they selected.
 *
 * Modes come from the database, so adding a facet or changing its selection is
 * configuration and never a code change.
 */
export function enforceSelectionLimits(
  selections: readonly FacetSelection[],
  modes: ReadonlyMap<string, 'single' | 'multi'>,
): SelectionLimitCheck {
  for (const selection of selections) {
    if (modes.get(selection.facetKey) === 'single' && selection.keywordKeys.length > 1) {
      return { ok: false, facetKey: selection.facetKey, chosen: selection.keywordKeys.length };
    }
  }
  return { ok: true };
}

/**
 * One predicate per facet: this asset, or the character it belongs to, carries
 * at least one of that facet's chosen keywords.
 *
 * A facet that resolved to NO keywords yields a condition that matches
 * nothing. That is the same answer an empty category gives -- "a misconfigured
 * pill must look empty, not look like it was ignored" -- and the alternative
 * is worse here: a filter the visitor can see selected, silently doing
 * nothing, looks exactly like a broken filter.
 */
export function facetConditions(resolved: readonly ResolvedFacet[]): SQL[] {
  return resolved.map((facet) => {
    if (facet.keywordIds.length === 0) return sql`false`;
    const ids = sql.join(
      facet.keywordIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    return sql`(
      exists (
        select 1 from ${assetKeywords}
        where ${assetKeywords.assetId} = ${characterVisualAssets.id}
          and ${assetKeywords.keywordId} in (${ids})
      )
      or exists (
        select 1 from ${characterKeywords}
        where ${characterKeywords.characterId} = ${characterVisualAssets.characterId}
          and ${characterKeywords.keywordId} in (${ids})
      )
    )`;
  });
}

/**
 * Turns the names a request used into the keyword ids they mean.
 *
 * SCOPED TO THE FACET, which is the whole point of resolving rather than
 * trusting: `facet.hair_color=curvy` resolves to nothing, because `curvy` is
 * filed under body type. A keyword cannot be borrowed into a facet it does not
 * belong to, so a filter can only ever mean what an operator filed.
 *
 * A DISABLED FACET IS NOT A FILTER. Turning one off hides it from the panel,
 * and a request that names it anyway resolves to nothing and therefore matches
 * nothing -- the same answer as a facet whose values are all unknown.
 */
export async function resolveFacetSelections(
  db: Db,
  selections: readonly FacetSelection[],
): Promise<ResolvedFacet[]> {
  if (selections.length === 0) return [];
  const facetKeys = [...new Set(selections.map((s) => s.facetKey))];
  const keywordKeys = [...new Set(selections.flatMap((s) => s.keywordKeys))];

  const rows = await db
    .select({ facetKey: keywordFacets.key, keywordKey: contentKeywords.key, keywordId: contentKeywords.id })
    .from(contentKeywords)
    .innerJoin(keywordFacets, eq(keywordFacets.id, contentKeywords.facetId))
    .where(
      and(
        eq(keywordFacets.enabled, true),
        inArray(keywordFacets.key, facetKeys),
        inArray(contentKeywords.key, keywordKeys),
      ),
    );

  const byFacet = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const bucket = byFacet.get(row.facetKey) ?? new Map<string, string>();
    bucket.set(row.keywordKey, row.keywordId);
    byFacet.set(row.facetKey, bucket);
  }

  // Every REQUESTED facet is returned, including one that resolved to nothing,
  // so the caller narrows on it rather than ignoring it.
  return selections.map((selection) => {
    const bucket = byFacet.get(selection.facetKey);
    const keywordIds = selection.keywordKeys
      .map((key) => bucket?.get(key))
      .filter((id): id is string => typeof id === 'string');
    return { facetKey: selection.facetKey, keywordIds };
  });
}

/** The selection mode of every enabled facet, for `enforceSelectionLimits`. */
export async function readFacetModes(db: Db): Promise<Map<string, 'single' | 'multi'>> {
  const rows = await db
    .select({ key: keywordFacets.key, selection: keywordFacets.selection })
    .from(keywordFacets)
    .where(eq(keywordFacets.enabled, true));
  return new Map(rows.map((row) => [row.key, row.selection === 'single' ? 'single' : 'multi']));
}
