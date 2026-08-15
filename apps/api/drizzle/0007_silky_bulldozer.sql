ALTER TYPE "public"."generation_job_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."generation_job_status" ADD VALUE 'blocked';--> statement-breakpoint
CREATE TABLE "generation_sequence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_id" uuid,
	"character_id" uuid NOT NULL,
	"status" "generation_job_status" DEFAULT 'queued' NOT NULL,
	"total_steps" integer NOT NULL,
	"completed_steps" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "generation_sequence_runs" ADD CONSTRAINT "generation_sequence_runs_sequence_id_generation_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."generation_sequences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_sequence_runs" ADD CONSTRAINT "generation_sequence_runs_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_sequence_runs_character_idx" ON "generation_sequence_runs" USING btree ("character_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_idempotency_idx" ON "generation_jobs" USING btree ("idempotency_key");