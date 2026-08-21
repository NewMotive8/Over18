CREATE TABLE "app_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_category_assets" (
	"category_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_category_assets_category_id_asset_id_pk" PRIMARY KEY("category_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "app_category_assets" ADD CONSTRAINT "app_category_assets_category_id_app_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."app_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_category_assets" ADD CONSTRAINT "app_category_assets_asset_id_character_visual_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."character_visual_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_categories_slug_uq" ON "app_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "app_categories_position_idx" ON "app_categories" USING btree ("position");--> statement-breakpoint
CREATE INDEX "app_category_assets_category_idx" ON "app_category_assets" USING btree ("category_id","position");--> statement-breakpoint
CREATE INDEX "app_category_assets_asset_idx" ON "app_category_assets" USING btree ("asset_id");