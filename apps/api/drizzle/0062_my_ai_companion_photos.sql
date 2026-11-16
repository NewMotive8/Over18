-- My AI: more photographs of a companion the user already has.
--
-- WHY A SECOND TABLE RATHER THAN MORE COLUMNS. A companion has one reference
-- portrait and any number of later photographs, each with its own prompt, its
-- own generation job and its own outcome. That is a list, and a list belongs
-- in rows.
--
-- THE REFERENCE PORTRAIT IS NOT IN HERE, and that is deliberate.
-- `user_companions.image_path` stays where it is, because the reference is
-- categorically different: the provider drew it from her attributes, it is
-- their canonical record of how she looks, and it is the INPUT to every row
-- below. Folding it in would lose that distinction to save one join.
--
-- Hand-written, like 0058-0061, for the same reason: drizzle-kit's snapshot
-- predates those migrations and regenerating would re-add columns that
-- already exist.

CREATE TABLE "user_companion_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	-- WHAT THE USER ASKED FOR, in their own words. Kept because it is the only
	-- record of why a photograph looks the way it does, and because a failed
	-- generation is worth being able to retry without retyping.
	"prompt" text NOT NULL,
	-- The provider's look-of-the-picture setting: 'glam' or 'amateur'. Stored
	-- as text, not an enum, so their adding a third costs no migration.
	"style" text DEFAULT 'glam' NOT NULL,
	"status" "user_companion_status" DEFAULT 'generating' NOT NULL,
	-- The provider's async job, kept only so an in-flight one can be polled.
	"provider_job_id" text,
	-- ABSOLUTE PATH ON THE MEDIA VOLUME, like her portrait. Null until the
	-- provider finishes. The bytes are ours: the provider hands back a
	-- presigned URL that expires.
	"image_path" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ON DELETE CASCADE: deleting a companion takes her photographs with her.
-- The FILES are removed by the service, which walks these rows first.
ALTER TABLE "user_companion_photos" ADD CONSTRAINT "user_companion_photos_companion_id_user_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."user_companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Every read is "this companion's photographs, newest first". Also covers the
-- foreign key, which Postgres does not index on its own.
CREATE INDEX "user_companion_photos_companion_created_idx" ON "user_companion_photos" USING btree ("companion_id","created_at");
