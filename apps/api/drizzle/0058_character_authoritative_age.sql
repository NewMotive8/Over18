-- Her age, as an operator confirmed it: the authoritative one.
--
-- WHY A COLUMN AND NOT THE PERSONA. Two numbers already existed and neither is
-- a statement of fact. `character_personas.persona->>'age'` was written by a
-- vision model, and `character_visual_identities.visual_dna->>'apparentAgeBand'`
-- describes how old she LOOKS. Cards derived from the band, the chat and voice
-- prompts stated the persona's number, and the two disagreed in production:
-- a card read 26 while the same character told a caller she was 32.
--
-- DELIBERATELY NOT BACKFILLED. Copying the 33 existing persona ages in here
-- would promote a model's guess to confirmed operator data, which is precisely
-- what this column exists to separate. Every row starts NULL; the read path
-- falls back to the persona and then the band, and Admin shows an unset age as
-- unset rather than as a number somebody chose.
--
-- IDEMPOTENT. Both statements are guarded, so re-running this migration -- or
-- running it against a database where an earlier attempt half-applied -- is a
-- no-op rather than an error.

ALTER TABLE "characters" ADD COLUMN IF NOT EXISTS "age" integer;--> statement-breakpoint

-- ADULT OR ABSENT, ENFORCED BY POSTGRES. The API and Admin validate too, but
-- this is the guarantee that holds for a script, a console session or a future
-- writer nobody has written yet: a row describing a minor cannot exist.
--
-- `ADD CONSTRAINT IF NOT EXISTS` is not available for CHECK constraints, so the
-- guard is an explicit catalogue lookup.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'characters_age_adult'
  ) THEN
    ALTER TABLE "characters"
      ADD CONSTRAINT "characters_age_adult"
      CHECK ("age" IS NULL OR "age" >= 18);
  END IF;
END
$$;
