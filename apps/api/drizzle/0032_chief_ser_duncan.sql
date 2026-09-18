CREATE TYPE "public"."commercial_state" AS ENUM('free', 'locked', 'paid', 'retired');--> statement-breakpoint
CREATE TABLE "content_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"character_id" uuid,
	"state" "commercial_state" DEFAULT 'free' NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"economy_ref" jsonb,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_offers_retired_consistent" CHECK (("content_offers"."state" = 'retired') = ("content_offers"."retired_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "content_offers" ADD CONSTRAINT "content_offers_asset_id_character_visual_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."character_visual_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_offers" ADD CONSTRAINT "content_offers_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_offers_live_asset_idx" ON "content_offers" USING btree ("asset_id") WHERE "content_offers"."retired_at" is null and "content_offers"."asset_id" is not null;--> statement-breakpoint
CREATE INDEX "content_offers_character_idx" ON "content_offers" USING btree ("character_id");