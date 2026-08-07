CREATE TYPE "public"."character_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"profile_image" text,
	"short_bio" text NOT NULL,
	"personality" text NOT NULL,
	"interests" text[] DEFAULT '{}' NOT NULL,
	"conversation_style" text NOT NULL,
	"system_prompt" text NOT NULL,
	"status" character_status DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "characters_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "characters_status_idx" ON "characters" USING btree ("status");