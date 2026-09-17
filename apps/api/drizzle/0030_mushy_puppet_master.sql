CREATE TYPE "public"."visual_asset_origin" AS ENUM('generated', 'manual', 'imported', 'legacy');--> statement-breakpoint
ALTER TABLE "character_visual_assets" ADD COLUMN "origin" "visual_asset_origin" DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
-- Backfill ORIGIN for existing assets (P0.3). Non-destructive: only the new
-- column is written; provenance, kind, status and every file are untouched.
--
-- Mapped from the only origin evidence any writer has ever recorded (checked
-- across the full git history of every asset writer):
--   generated  a generation jobId in provenance, or a generation_results row
--              linked to the asset
--   manual     provenance.source = 'manual-upload' (shelves, Library, Inbox)
--   imported   provenance.source = 'approved-site-content' (supplied portrait)
--   legacy     everything else, including 'seed-placeholder' scaffolding and any
--              row with no recognisable evidence -- origin is never guessed.
-- Idempotent: re-running it yields the same values.
UPDATE "character_visual_assets" AS a
SET "origin" = CASE
  WHEN a."provenance" ? 'jobId'
    OR EXISTS (SELECT 1 FROM "generation_results" r WHERE r."asset_id" = a."id")
    THEN 'generated'::"visual_asset_origin"
  WHEN a."provenance"->>'source' = 'manual-upload' THEN 'manual'::"visual_asset_origin"
  WHEN a."provenance"->>'source' = 'approved-site-content' THEN 'imported'::"visual_asset_origin"
  ELSE 'legacy'::"visual_asset_origin"
END;
