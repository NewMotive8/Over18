import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  enforceSelectionLimits,
  facetConditions,
  parseFacetParams,
  type FacetSelection,
} from '../services/facet-filter.js';

/**
 * THE RULES A FILTER PANEL RUNS ON, tested as SQL rather than as results.
 *
 * These cases need no database, and that is not a compromise. What matters
 * about faceted filtering is the SHAPE of the question it asks -- one
 * predicate per facet so they conjoin, one `in (...)` inside each so values
 * widen, and nothing about content rating or `facet_id` anywhere -- and the
 * shape is visible in the rendered statement. A row-counting test would assert
 * the same rules through a fixture and prove less about why they hold.
 *
 * `PgDialect` renders a condition exactly as the driver would send it, so
 * these read the real statement, not a description of one.
 */

const dialect = new PgDialect();
const render = (condition: SQL): string => dialect.sqlToQuery(condition).sql;
const renderAll = (conditions: SQL[]): string => render(and(...conditions)!);
/** Ids are BOUND, never interpolated, so they live in params and not in the text. */
const paramsOf = (conditions: SQL[]): unknown[] => dialect.sqlToQuery(and(...conditions)!).params;

const HAIR = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const BODY = ['33333333-3333-4333-8333-333333333333'];

/* ------------------------------------------------------------------ *
 * 1. AND across facets
 * ------------------------------------------------------------------ */

describe('each facet narrows, so facets conjoin', () => {
  it('produces ONE predicate per facet, which is how AND across them happens', () => {
    const conditions = facetConditions([
      { facetKey: 'hair_color', keywordIds: HAIR },
      { facetKey: 'body_type', keywordIds: BODY },
    ]);
    expect(conditions).toHaveLength(2);
  });

  /**
   * The conjunction is the caller's existing `and(...conditions)`. Nothing in
   * the facet layer writes "and" -- which is why facets compose with the
   * category, the search text and the rating without any of them changing.
   */
  it('renders as two independent groups joined by and', () => {
    const sql = renderAll(
      facetConditions([
        { facetKey: 'hair_color', keywordIds: HAIR },
        { facetKey: 'body_type', keywordIds: BODY },
      ]),
    );
    expect(sql).toContain(' and ');
    // Two facets, each asking the asset AND the character: four subqueries.
    expect(sql.match(/exists \(/g)).toHaveLength(4);
    const bound = paramsOf([
      ...facetConditions([
        { facetKey: 'hair_color', keywordIds: HAIR },
        { facetKey: 'body_type', keywordIds: BODY },
      ]),
    ]);
    for (const id of [...HAIR, ...BODY]) expect(bound).toContain(id);
  });

  /** Blonde AND Petite must be narrower than Blonde. A second facet may only add. */
  it('keeps the first facet intact when a second is added', () => {
    const one = renderAll(facetConditions([{ facetKey: 'hair_color', keywordIds: HAIR }]));
    const two = renderAll(
      facetConditions([
        { facetKey: 'hair_color', keywordIds: HAIR },
        { facetKey: 'body_type', keywordIds: BODY },
      ]),
    );
    expect(two.length).toBeGreaterThan(one.length);
    const bound = paramsOf(
      facetConditions([
        { facetKey: 'hair_color', keywordIds: HAIR },
        { facetKey: 'body_type', keywordIds: BODY },
      ]),
    );
    for (const id of HAIR) expect(bound).toContain(id);
  });
});

/* ------------------------------------------------------------------ *
 * 2. OR within a facet
 * ------------------------------------------------------------------ */

describe('values inside one facet widen', () => {
  it('puts every chosen value of a facet in ONE predicate, not one each', () => {
    const conditions = facetConditions([{ facetKey: 'hair_color', keywordIds: HAIR }]);
    expect(conditions).toHaveLength(1);
    const sql = render(conditions[0]!);
    expect(sql).toContain(' in (');
    expect(paramsOf(conditions)).toEqual([...HAIR, ...HAIR]);
  });

  /** Hers or the clip's: a facet matches either side, which is one `or`. */
  it('matches the character or the asset', () => {
    const sql = render(facetConditions([{ facetKey: 'hair_color', keywordIds: HAIR }])[0]!);
    expect(sql).toContain('"asset_keywords"');
    expect(sql).toContain('"character_keywords"');
    expect(sql).toContain(' or ');
  });
});

/* ------------------------------------------------------------------ *
 * 3. No facet selected is the behaviour that already existed
 * ------------------------------------------------------------------ */

describe('no selection changes nothing', () => {
  it('adds no condition at all', () => {
    expect(facetConditions([])).toEqual([]);
  });

  it('reads no facet out of a query that has none', () => {
    expect(parseFacetParams({ category: 'sexy', q: 'luna' })).toEqual([]);
    expect(parseFacetParams({})).toEqual([]);
  });

  /**
   * A facet NAMED but left empty is not a filter. Dropping it is what keeps
   * `facet.hair_color=` from meaning "no hair colour exists".
   */
  it('drops a facet whose values are all blank', () => {
    expect(parseFacetParams({ 'facet.hair_color': ' , ,' })).toEqual([]);
  });

  /**
   * A facet that resolved to NOTHING is the opposite case and must match
   * nothing -- the same answer an empty category gives. A filter the visitor
   * can see selected, silently doing nothing, looks like a broken filter.
   */
  it('matches nothing for a facet that resolved to no keywords', () => {
    const conditions = facetConditions([{ facetKey: 'hair_color', keywordIds: [] }]);
    expect(conditions).toHaveLength(1);
    expect(render(conditions[0]!)).toContain('false');
  });
});

/* ------------------------------------------------------------------ *
 * 4. Unfiled keywords are untouched
 * ------------------------------------------------------------------ */

describe('a keyword filed under no facet keeps working', () => {
  /**
   * `beach`, `lingerie` and `all-key-words` are matched by exactly the
   * `asset_keywords` rows they always were. If a facet predicate consulted
   * `facet_id`, an unfiled keyword would start being excluded by a feature
   * that was supposed to add a way to ask a narrower question.
   */
  it('never consults facet_id, so nothing can be filtered out for being unfiled', () => {
    const sql = renderAll(
      facetConditions([
        { facetKey: 'hair_color', keywordIds: HAIR },
        { facetKey: 'body_type', keywordIds: BODY },
      ]),
    );
    expect(sql).not.toContain('facet_id');
    expect(sql).not.toContain('"keyword_facets"');
    expect(sql).not.toContain('"content_keywords"');
  });

  it('matches purely on keyword id, which an unfiled keyword also has', () => {
    const sql = render(facetConditions([{ facetKey: 'style', keywordIds: BODY }])[0]!);
    expect(sql).toContain('"keyword_id"');
  });
});

/* ------------------------------------------------------------------ *
 * 5. Discovery categories are not involved
 * ------------------------------------------------------------------ */

describe('discovery category behaviour is untouched', () => {
  const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  /**
   * A category stays a set of keywords matched with OR, where one hit is
   * enough. The clearest proof that facets did not change it is that the
   * service implementing it never learned facets exist.
   */
  it('the discovery service does not import the facet layer', () => {
    const discovery = source('../services/discovery-service.ts');
    expect(discovery).not.toContain('facet-filter');
    expect(discovery).not.toContain('facetConditions');
    expect(discovery).not.toContain('facet_id');
    expect(discovery).not.toContain('facetId');
  });

  /** Its OR rule is still stated and still implemented over asset_keywords alone. */
  it('still matches a category with OR over its own keywords', () => {
    const discovery = source('../services/discovery-service.ts');
    expect(discovery).toContain('OR, NOT AND');
    expect(discovery).toContain('discoveryCategoryKeywords');
  });
});

/* ------------------------------------------------------------------ *
 * 6. The rating predicate stays separable
 * ------------------------------------------------------------------ */

describe('content rating is nobody else s business', () => {
  /**
   * Showing explicit clips to Premium has to remain a change to ONE predicate
   * in the lobby query. A facet that quietly filtered by rating would scatter
   * that decision across every condition that narrows the grid.
   */
  it('no facet predicate mentions rating in any form', () => {
    const sql = renderAll(
      facetConditions([
        { facetKey: 'hair_color', keywordIds: HAIR },
        { facetKey: 'ethnicity', keywordIds: BODY },
      ]),
    );
    expect(sql).not.toContain('content_rating');
    expect(sql).not.toContain('explicit');
  });

  it('the lobby query still carries the rating rule as its own condition', () => {
    const lobby = readFileSync(
      fileURLToPath(new URL('../services/home-composition-service.ts', import.meta.url)),
      'utf8',
    );
    expect(lobby).toContain('notExplicitVideoCondition()');
  });
});

/* ------------------------------------------------------------------ *
 * Reading a selection off the wire
 * ------------------------------------------------------------------ */

describe('what a request may say', () => {
  it('reads one facet and its values', () => {
    expect(parseFacetParams({ 'facet.hair_color': 'blonde,red-hair' })).toEqual([
      { facetKey: 'hair_color', keywordKeys: ['blonde', 'red-hair'] },
    ]);
  });

  it('accepts a repeated parameter as the same thing as a comma list', () => {
    expect(parseFacetParams({ 'facet.hair_color': ['blonde', 'red-hair'] })).toEqual([
      { facetKey: 'hair_color', keywordKeys: ['blonde', 'red-hair'] },
    ]);
  });

  it('trims and de-duplicates, so a double-click cannot widen a filter', () => {
    expect(parseFacetParams({ 'facet.hair_color': ' blonde , blonde ,red-hair' })).toEqual([
      { facetKey: 'hair_color', keywordKeys: ['blonde', 'red-hair'] },
    ]);
  });

  /** An unknown name survives parsing; resolution refuses it, not this. */
  it('keeps an unknown facet name for resolution to reject', () => {
    expect(parseFacetParams({ 'facet.nonsense': 'x' })).toEqual([
      { facetKey: 'nonsense', keywordKeys: ['x'] },
    ]);
  });
});

describe('a single-choice facet refuses a combination', () => {
  const modes = new Map<string, 'single' | 'multi'>([
    ['ethnicity', 'single'],
    ['hair_color', 'multi'],
  ]);
  const sel = (facetKey: string, keywordKeys: string[]): FacetSelection => ({ facetKey, keywordKeys });

  it('allows one value', () => {
    expect(enforceSelectionLimits([sel('ethnicity', ['asian'])], modes)).toEqual({ ok: true });
  });

  /** Refused, not truncated: a silently dropped value gives a result nobody can explain. */
  it('refuses two, naming the facet and how many were sent', () => {
    expect(enforceSelectionLimits([sel('ethnicity', ['asian', 'latina'])], modes)).toEqual({
      ok: false,
      facetKey: 'ethnicity',
      chosen: 2,
    });
  });

  it('lets a multi facet take as many as it likes', () => {
    expect(
      enforceSelectionLimits([sel('hair_color', ['blonde', 'red-hair', 'black'])], modes),
    ).toEqual({ ok: true });
  });

  /** An unknown facet has no mode and is not refused here -- resolution drops it. */
  it('does not refuse a facet it has never heard of', () => {
    expect(enforceSelectionLimits([sel('nonsense', ['a', 'b'])], modes)).toEqual({ ok: true });
  });
});
