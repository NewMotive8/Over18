CREATE TYPE "public"."call_session_status" AS ENUM('pending', 'active', 'ended', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "call_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_session_id" text,
	"voice" text NOT NULL,
	"status" "call_session_status" DEFAULT 'pending' NOT NULL,
	"max_seconds" integer NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"termination_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_sessions_duration_nonneg" CHECK ("call_sessions"."duration_seconds" is null or "call_sessions"."duration_seconds" >= 0),
	CONSTRAINT "call_sessions_max_seconds_positive" CHECK ("call_sessions"."max_seconds" > 0)
);
--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "live_call_voice" text;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_sessions_live_idx" ON "call_sessions" USING btree ("conversation_id") WHERE "call_sessions"."status" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "call_sessions_user_idx" ON "call_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "call_sessions_status_idx" ON "call_sessions" USING btree ("status","started_at");