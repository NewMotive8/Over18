CREATE TABLE "asset_keywords" (
	"asset_id" uuid NOT NULL,
	"keyword_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_keywords_asset_id_keyword_id_pk" PRIMARY KEY("asset_id","keyword_id")
);
--> statement-breakpoint
CREATE TABLE "content_keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_category_keywords" (
	"discovery_category_id" uuid NOT NULL,
	"keyword_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_category_keywords_discovery_category_id_keyword_id_pk" PRIMARY KEY("discovery_category_id","keyword_id")
);
--> statement-breakpoint
CREATE TABLE "home_hero_clips" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_recent_characters" (
	"character_id" uuid PRIMARY KEY NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "home_banners_position_idx";--> statement-breakpoint
ALTER TABLE "app_categories" ADD COLUMN "home_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_categories" ADD COLUMN "home_position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "home_banners" ADD COLUMN "slot" text DEFAULT 'before_search' NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_keywords" ADD CONSTRAINT "asset_keywords_asset_id_character_visual_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."character_visual_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_keywords" ADD CONSTRAINT "asset_keywords_keyword_id_content_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."content_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_category_keywords" ADD CONSTRAINT "discovery_category_keywords_discovery_category_id_discovery_categories_id_fk" FOREIGN KEY ("discovery_category_id") REFERENCES "public"."discovery_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_category_keywords" ADD CONSTRAINT "discovery_category_keywords_keyword_id_content_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."content_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_hero_clips" ADD CONSTRAINT "home_hero_clips_asset_id_character_visual_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."character_visual_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_recent_characters" ADD CONSTRAINT "home_recent_characters_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_keywords_keyword_idx" ON "asset_keywords" USING btree ("keyword_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_keywords_key_uq" ON "content_keywords" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_categories_slug_uq" ON "discovery_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "discovery_categories_position_idx" ON "discovery_categories" USING btree ("position");--> statement-breakpoint
CREATE INDEX "discovery_category_keywords_keyword_idx" ON "discovery_category_keywords" USING btree ("keyword_id");--> statement-breakpoint
CREATE INDEX "home_hero_clips_position_idx" ON "home_hero_clips" USING btree ("position");--> statement-breakpoint
CREATE INDEX "home_recent_characters_position_idx" ON "home_recent_characters" USING btree ("position");--> statement-breakpoint
CREATE INDEX "app_categories_home_idx" ON "app_categories" USING btree ("home_published","home_position");--> statement-breakpoint
CREATE INDEX "home_banners_position_idx" ON "home_banners" USING btree ("slot","position");