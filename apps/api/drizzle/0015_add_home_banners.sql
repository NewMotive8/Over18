CREATE TABLE "banner_creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mime_type" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"original_name" text,
	"storage_path" text,
	"width" integer,
	"height" integer,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_banners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"cta_label" text,
	"creative_id" uuid,
	"destination_kind" text NOT NULL,
	"destination_category_id" uuid,
	"destination_character_id" uuid,
	"destination_asset_id" uuid,
	"destination_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"audience" text DEFAULT 'everyone' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"schedule_timezone" text,
	"position" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "banner_creatives" ADD CONSTRAINT "banner_creatives_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_banners" ADD CONSTRAINT "home_banners_creative_id_banner_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."banner_creatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_banners" ADD CONSTRAINT "home_banners_destination_category_id_app_categories_id_fk" FOREIGN KEY ("destination_category_id") REFERENCES "public"."app_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_banners" ADD CONSTRAINT "home_banners_destination_character_id_characters_id_fk" FOREIGN KEY ("destination_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_banners" ADD CONSTRAINT "home_banners_destination_asset_id_character_visual_assets_id_fk" FOREIGN KEY ("destination_asset_id") REFERENCES "public"."character_visual_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "home_banners_position_idx" ON "home_banners" USING btree ("position");--> statement-breakpoint
CREATE INDEX "home_banners_status_idx" ON "home_banners" USING btree ("status");