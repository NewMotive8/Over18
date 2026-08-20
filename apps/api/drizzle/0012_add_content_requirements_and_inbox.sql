CREATE TABLE "content_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'unassigned' NOT NULL,
	"mime_type" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"original_name" text,
	"storage_path" text,
	"uploaded_by" uuid,
	"assigned_asset_id" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"media_type" text NOT NULL,
	"required_quantity" integer DEFAULT 1 NOT NULL,
	"content_rating" "content_rating",
	"enabled" boolean DEFAULT true NOT NULL,
	"assign_primary_reference" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_inbox" ADD CONSTRAINT "content_inbox_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_inbox" ADD CONSTRAINT "content_inbox_assigned_asset_id_character_visual_assets_id_fk" FOREIGN KEY ("assigned_asset_id") REFERENCES "public"."character_visual_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_inbox" ADD CONSTRAINT "content_inbox_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_inbox_status_idx" ON "content_inbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_requirements_key_uq" ON "content_requirements" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "content_requirements_primary_reference_uq" ON "content_requirements" USING btree ("assign_primary_reference") WHERE "content_requirements"."assign_primary_reference" = true;--> statement-breakpoint
CREATE INDEX "content_requirements_position_idx" ON "content_requirements" USING btree ("position");--> statement-breakpoint
CREATE INDEX "character_visual_assets_character_requirement_idx" ON "character_visual_assets" USING btree ("character_id","requirement_key");--> statement-breakpoint
-- The DEFAULT content requirements.
--
-- Seeded here, as data, because that is the whole point: these five rows are
-- configuration an operator edits in Admin -> Settings, not constants in code.
-- No category name or quantity appears anywhere in TypeScript.
--
-- Idempotent on `key`, so re-running against a database that already has them
-- (or one where an operator has since edited them) changes nothing.
INSERT INTO "content_requirements"
  ("key", "label", "media_type", "required_quantity", "content_rating", "assign_primary_reference", "position")
VALUES
  ('primary_natural', 'Primary — regular / natural', 'image', 1, 'sfw',      true,  1),
  ('primary_nude',    'Primary — fully nude',        'image', 1, 'explicit', false, 2),
  ('selfie',          'Selfies',                     'video', 2, NULL,       false, 3),
  ('sexy',            'Non-explicit / sexy clips',   'video', 2, 'sfw',      false, 4),
  ('explicit',        'Explicit clips',              'video', 4, 'explicit', false, 5)
ON CONFLICT ("key") DO NOTHING;
