CREATE TABLE "home_play_with_me_characters" (
	"character_id" uuid PRIMARY KEY NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "home_play_with_me_characters" ADD CONSTRAINT "home_play_with_me_characters_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "home_play_with_me_characters_position_idx" ON "home_play_with_me_characters" USING btree ("position");