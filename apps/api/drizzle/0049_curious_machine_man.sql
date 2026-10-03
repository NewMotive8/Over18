CREATE TYPE "public"."call_turn_speaker" AS ENUM('user', 'character');--> statement-breakpoint
CREATE TABLE "call_transcript_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_session_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"speaker" "call_turn_speaker" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_transcript_turns" ADD CONSTRAINT "call_transcript_turns_call_session_id_call_sessions_id_fk" FOREIGN KEY ("call_session_id") REFERENCES "public"."call_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_transcript_turns_call_seq_idx" ON "call_transcript_turns" USING btree ("call_session_id","seq");