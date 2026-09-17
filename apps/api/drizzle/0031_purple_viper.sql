ALTER TYPE "public"."visual_asset_status" ADD VALUE 'archived';--> statement-breakpoint
ALTER TABLE "character_visual_assets" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "character_visual_assets" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "character_visual_assets" ADD CONSTRAINT "character_visual_assets_archived_consistent" CHECK (("character_visual_assets"."status"::text = 'archived') = ("character_visual_assets"."archived_at" is not null));