CREATE TABLE "character_keywords" (
	"character_id" uuid NOT NULL,
	"keyword_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_keywords_character_id_keyword_id_pk" PRIMARY KEY("character_id","keyword_id")
);
--> statement-breakpoint
CREATE TABLE "keyword_facets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"selection" text DEFAULT 'multi' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_facets_key_format" CHECK ("keyword_facets"."key" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "keyword_facets_selection" CHECK ("keyword_facets"."selection" in ('single', 'multi'))
);
--> statement-breakpoint
ALTER TABLE "content_keywords" ADD COLUMN "facet_id" uuid;--> statement-breakpoint
ALTER TABLE "character_keywords" ADD CONSTRAINT "character_keywords_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_keywords" ADD CONSTRAINT "character_keywords_keyword_id_content_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."content_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_keywords_keyword_idx" ON "character_keywords" USING btree ("keyword_id");--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_facets_key_uq" ON "keyword_facets" USING btree ("key");--> statement-breakpoint
CREATE INDEX "keyword_facets_position_idx" ON "keyword_facets" USING btree ("position");--> statement-breakpoint
ALTER TABLE "content_keywords" ADD CONSTRAINT "content_keywords_facet_id_keyword_facets_id_fk" FOREIGN KEY ("facet_id") REFERENCES "public"."keyword_facets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_keywords_facet_idx" ON "content_keywords" USING btree ("facet_id");