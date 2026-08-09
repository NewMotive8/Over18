CREATE TYPE "public"."content_rating" AS ENUM('sfw', 'explicit');--> statement-breakpoint
CREATE TYPE "public"."visual_asset_kind" AS ENUM('reference', 'generated');--> statement-breakpoint
CREATE TYPE "public"."visual_asset_status" AS ENUM('generated', 'under_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."visual_identity_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TABLE "character_visual_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"visual_identity_id" uuid NOT NULL,
	"kind" "visual_asset_kind" NOT NULL,
	"status" "visual_asset_status" NOT NULL,
	"is_canonical" boolean DEFAULT false NOT NULL,
	"position" integer,
	"storage_key" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_rating" "content_rating" DEFAULT 'sfw' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_visual_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "visual_identity_status" DEFAULT 'draft' NOT NULL,
	"visual_dna" jsonb NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_visual_assets" ADD CONSTRAINT "character_visual_assets_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_visual_assets" ADD CONSTRAINT "character_visual_assets_visual_identity_id_character_visual_identities_id_fk" FOREIGN KEY ("visual_identity_id") REFERENCES "public"."character_visual_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_visual_identities" ADD CONSTRAINT "character_visual_identities_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_visual_assets_character_idx" ON "character_visual_assets" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "character_visual_assets_identity_kind_status_idx" ON "character_visual_assets" USING btree ("visual_identity_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "character_visual_identities_character_version_uq" ON "character_visual_identities" USING btree ("character_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "character_visual_identities_active_uq" ON "character_visual_identities" USING btree ("character_id") WHERE "character_visual_identities"."status" = 'active';--> statement-breakpoint
CREATE INDEX "character_visual_identities_character_idx" ON "character_visual_identities" USING btree ("character_id");