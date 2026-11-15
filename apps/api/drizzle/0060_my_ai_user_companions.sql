-- My AI: the companions a USER builds for themselves.
--
-- WHY A TABLE OF ITS OWN, AND NOT A ROW IN `characters`.
--
-- `characters` is the operator-curated catalogue. What is visible from it is
-- decided by `status`, by `published_at` and by category placement, and a
-- dozen public queries read it: Home, Discovery, Play with me, Swipe,
-- Favourites, the category rails. A private companion living in that table
-- would mean every one of those queries needs a new exclusion, for ever, and
-- one missed WHERE would publish a stranger's companion to the lobby. That
-- failure is silent, immediate, and cannot be taken back.
--
-- A separate table cannot leak into a surface that never reads it.
--
-- NOTHING HERE IS PUBLIC. There is no active status, no publication, no
-- placement. A companion belongs to exactly one account, and `user_id` is
-- taken from the session on every read -- never from a path or a body.
--
-- HAND-WRITTEN, like 0058 and 0059. `drizzle-kit generate` also wanted to
-- re-add `characters.grok_voice`, `grok_speaking_style`,
-- `grok_call_instructions` and `age`, because those two migrations were
-- hand-written and its snapshot had never recorded them. Applying that would
-- fail on every environment where 0058 and 0059 have run. Only the new table
-- is below; the accompanying snapshot IS kept, so the drift stops here.

CREATE TYPE "public"."user_companion_status" AS ENUM('generating', 'ready', 'failed');--> statement-breakpoint

CREATE TABLE "user_companions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"age" integer NOT NULL,
	"voice" text NOT NULL,
	-- Her look and character as OUR option ids ({"ethnicity":"latina",...}),
	-- never the generation provider's vocabulary -- so a provider renaming a
	-- value, or being replaced outright, does not rewrite anybody's companion.
	"attributes" jsonb NOT NULL,
	"status" "user_companion_status" DEFAULT 'generating' NOT NULL,
	-- Kept only so an in-flight generation can be polled. Never sent to a client.
	"provider_character_guid" text,
	-- ABSOLUTE PATH ON THE MEDIA VOLUME. Named `image_path`, not `storage_key`:
	-- in this schema `storage_key` means an API serve path for a character
	-- asset, and reusing that name for a filesystem path is how one ends up
	-- being fed to the other. Null until the provider finishes. The bytes are
	-- ours -- downloaded rather than linked, because a link we do not host
	-- expires, and a companion whose picture vanishes is not a companion.
	"image_path" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- 21, not the platform's 18. The provider that renders her refuses anything
	-- under 21 server-side, so a row below it could never have been drawn, and
	-- storing one would mean a companion whose shown age and whose generated
	-- age disagree -- precisely what the confirmed-age work exists to prevent.
	CONSTRAINT "user_companions_age_21_plus" CHECK (age >= 21)
);
--> statement-breakpoint

ALTER TABLE "user_companions" ADD CONSTRAINT "user_companions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Every read is "this user's companions, newest first". Also covers the
-- foreign key, which Postgres does not index on its own.
CREATE INDEX "user_companions_user_created_idx" ON "user_companions" USING btree ("user_id","created_at");
