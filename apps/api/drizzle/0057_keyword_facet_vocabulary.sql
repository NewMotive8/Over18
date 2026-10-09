-- The first facets, and the vocabulary cleanup that files today's keywords
-- under them. A custom migration because none of this is a schema diff: it is
-- data, and most of it is a judgement about what an operator meant.
--
-- NOTHING AN OPERATOR IS USING IS DELETED, and that is a correction to the
-- plan this migration was written from. The intention had been to drop
-- `all-key-words`, `girl` and `big-ass` as junk. Reading the live data first
-- showed every one of them backs a discovery category:
--
--     all-key-words -> "All"       a deliberate catch-all; dropping it would
--                                  empty the category outright
--     girl          -> "Teen"      Teen is `girl` OR `teen`; dropping it
--                                  narrows a live category
--     big-ass       -> "Big Ass"   the category's ONLY keyword
--
-- A category is a set of keywords matched with OR, so removing one silently
-- changes what a visitor sees with nothing to indicate why. Dropping butt size
-- as a FILTER DIMENSION never required deleting the keyword behind it: an
-- ungrouped keyword keeps working everywhere it already works and simply does
-- not appear as a facet. So these three stay, unfiled.
--
-- WHAT IS DELETED is `east-asian` and `south-asian`, and only because deleting
-- them provably changes nothing: they carry no assets, and their sole category
-- ("Asian") also holds `asian`, which they fold into. The category matches the
-- same clips before and after.

-- 1. THE DIMENSIONS.
--
-- Ethnicity is `single`: it is the one facet here where offering a combination
-- would invite a question nobody meant to ask. The rest take several values at
-- once -- "blonde or brown" is a reasonable thing to want.
--
-- Butt size is deliberately absent. It is the facet most likely to be judged
-- wrong from a photograph, and a filter nobody trusts is worse than no filter.
INSERT INTO "keyword_facets" ("key", "label", "selection", "position") VALUES
  ('hair_color',  'Hair colour', 'multi',  10),
  ('body_type',   'Body type',   'multi',  20),
  ('breast_size', 'Breast size', 'multi',  30),
  ('ethnicity',   'Ethnicity',   'single', 40),
  ('age_band',    'Age',         'multi',  50),
  ('style',       'Style',       'multi',  60)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

-- 2. TWO KEYS THAT WERE TYPED WRONG.
--
-- `key` is the stable identity, so renaming one is normally the thing this
-- schema forbids. It is safe here only because both references are by id:
-- asset_keywords and discovery_category_keywords point at the row, not the
-- spelling, so the "Mlf" and "Blonde" categories keep matching exactly what
-- they matched before. The labels are fixed to match.
UPDATE "content_keywords" SET "key" = 'milf',   "label" = 'MILF'   WHERE "key" = 'mlf';--> statement-breakpoint
UPDATE "content_keywords" SET "key" = 'blonde', "label" = 'Blonde' WHERE "key" = 'blond';--> statement-breakpoint

-- 3. THREE WAYS OF SAYING ASIAN BECOME ONE.
--
-- Ethnicity is a single-choice facet, so it cannot hold three overlapping
-- values for one idea. Links move to `asian` first -- ON CONFLICT because the
-- "Asian" category already holds `asian` and the move would otherwise collide
-- with itself -- and only then are the empty keywords removed.
UPDATE "asset_keywords" ak
   SET "keyword_id" = (SELECT id FROM "content_keywords" WHERE "key" = 'asian')
 WHERE ak."keyword_id" IN (SELECT id FROM "content_keywords" WHERE "key" IN ('east-asian', 'south-asian'))
   AND NOT EXISTS (
     SELECT 1 FROM "asset_keywords" x
      WHERE x."asset_id" = ak."asset_id"
        AND x."keyword_id" = (SELECT id FROM "content_keywords" WHERE "key" = 'asian')
   );--> statement-breakpoint

INSERT INTO "discovery_category_keywords" ("discovery_category_id", "keyword_id")
SELECT dk."discovery_category_id", (SELECT id FROM "content_keywords" WHERE "key" = 'asian')
  FROM "discovery_category_keywords" dk
 WHERE dk."keyword_id" IN (SELECT id FROM "content_keywords" WHERE "key" IN ('east-asian', 'south-asian'))
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Any surviving link is a duplicate of one that now points at `asian`; the
-- cascade on both join tables clears them with the keyword.
DELETE FROM "content_keywords" WHERE "key" IN ('east-asian', 'south-asian');--> statement-breakpoint

-- 4. FILE WHAT IS LEFT.
--
-- Only keywords that answer one of the dimensions are filed. `beach`,
-- `bikini`, `lingerie`, `party` and `restaurant` describe what is happening in
-- a clip rather than who she is, and `all-key-words`, `girl` and `big-ass`
-- answer no dimension offered here -- all of them stay ungrouped, which is
-- exactly the behaviour every keyword had before facets existed.
UPDATE "content_keywords" SET "facet_id" = (SELECT id FROM "keyword_facets" WHERE "key" = 'hair_color')
 WHERE "key" IN ('blonde', 'red-hair');--> statement-breakpoint
UPDATE "content_keywords" SET "facet_id" = (SELECT id FROM "keyword_facets" WHERE "key" = 'body_type')
 WHERE "key" IN ('curvy');--> statement-breakpoint
UPDATE "content_keywords" SET "facet_id" = (SELECT id FROM "keyword_facets" WHERE "key" = 'breast_size')
 WHERE "key" IN ('big-tits');--> statement-breakpoint
UPDATE "content_keywords" SET "facet_id" = (SELECT id FROM "keyword_facets" WHERE "key" = 'ethnicity')
 WHERE "key" IN ('asian');--> statement-breakpoint
UPDATE "content_keywords" SET "facet_id" = (SELECT id FROM "keyword_facets" WHERE "key" = 'age_band')
 WHERE "key" IN ('teen', 'milf');--> statement-breakpoint
UPDATE "content_keywords" SET "facet_id" = (SELECT id FROM "keyword_facets" WHERE "key" = 'style')
 WHERE "key" IN ('goth');
