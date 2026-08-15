CREATE TYPE "public"."generation_result_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "generation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"status" "generation_result_status" DEFAULT 'pending' NOT NULL,
	"asset_id" uuid,
	"error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "generation_results" ADD CONSTRAINT "generation_results_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_results" ADD CONSTRAINT "generation_results_asset_id_character_visual_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."character_visual_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_results_job_ordinal_idx" ON "generation_results" USING btree ("job_id","ordinal");--> statement-breakpoint
CREATE INDEX "generation_results_status_idx" ON "generation_results" USING btree ("status");