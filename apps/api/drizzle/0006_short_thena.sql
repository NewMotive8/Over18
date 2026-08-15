CREATE TYPE "public"."generation_job_status" AS ENUM('queued', 'running', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"visual_identity_id" uuid,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" "generation_job_status" DEFAULT 'queued' NOT NULL,
	"effective_config" jsonb NOT NULL,
	"requested_quantity" integer DEFAULT 1 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" text,
	"actual_cost_usd" text,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sequence_run_id" uuid,
	"step_ordinal" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "generation_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"character_id" uuid,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"character_id" uuid,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_visual_identity_id_character_visual_identities_id_fk" FOREIGN KEY ("visual_identity_id") REFERENCES "public"."character_visual_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_presets" ADD CONSTRAINT "generation_presets_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_sequences" ADD CONSTRAINT "generation_sequences_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_jobs_character_idx" ON "generation_jobs" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_status_idx" ON "generation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "generation_jobs_sequence_run_idx" ON "generation_jobs" USING btree ("sequence_run_id","step_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_presets_name_idx" ON "generation_presets" USING btree ("name");--> statement-breakpoint
CREATE INDEX "generation_sequences_character_idx" ON "generation_sequences" USING btree ("character_id");