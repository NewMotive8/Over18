CREATE TABLE "character_clip_allocation" (
	"character_id" uuid PRIMARY KEY NOT NULL,
	"free_clip_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "character_clip_allocation_free_count" CHECK ("character_clip_allocation"."free_clip_count" is null or "character_clip_allocation"."free_clip_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "character_clip_allocation" ADD CONSTRAINT "character_clip_allocation_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;