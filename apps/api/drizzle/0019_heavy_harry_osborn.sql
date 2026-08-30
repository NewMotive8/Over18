CREATE TYPE "public"."prompt_batch_status" AS ENUM('draft', 'running', 'paused', 'completed');--> statement-breakpoint
CREATE TYPE "public"."prompt_job_status" AS ENUM('queued', 'generating', 'uploading', 'completed', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."prompt_output_status" AS ENUM('pending', 'generated', 'uploading', 'completed', 'failed', 'drive_upload_failed');--> statement-breakpoint
CREATE TABLE "prompt_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "prompt_batch_status" DEFAULT 'draft' NOT NULL,
	"model" text NOT NULL,
	"params" jsonb NOT NULL,
	"outputs_per_prompt" integer DEFAULT 2 NOT NULL,
	"drive_folder_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prompt_job_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"status" "prompt_output_status" DEFAULT 'pending' NOT NULL,
	"output_filename" text NOT NULL,
	"spool_path" text,
	"drive_file_id" text,
	"drive_web_view_link" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prompt_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"original_filename" text NOT NULL,
	"prompt_text" text NOT NULL,
	"status" "prompt_job_status" DEFAULT 'queued' NOT NULL,
	"requested_outputs" integer DEFAULT 2 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "prompt_batches" ADD CONSTRAINT "prompt_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_job_outputs" ADD CONSTRAINT "prompt_job_outputs_job_id_prompt_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."prompt_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_jobs" ADD CONSTRAINT "prompt_jobs_batch_id_prompt_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."prompt_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prompt_batches_status_idx" ON "prompt_batches" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_job_outputs_job_ordinal_idx" ON "prompt_job_outputs" USING btree ("job_id","ordinal");--> statement-breakpoint
CREATE INDEX "prompt_job_outputs_status_idx" ON "prompt_job_outputs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "prompt_jobs_batch_idx" ON "prompt_jobs" USING btree ("batch_id","ordinal");--> statement-breakpoint
CREATE INDEX "prompt_jobs_status_idx" ON "prompt_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_jobs_batch_filename_idx" ON "prompt_jobs" USING btree ("batch_id","original_filename");