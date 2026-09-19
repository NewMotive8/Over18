CREATE TYPE "public"."subscription_change" AS ENUM('assign', 'change_plan', 'cancel', 'end');--> statement-breakpoint
CREATE TYPE "public"."subscription_change_source" AS ENUM('admin');--> statement-breakpoint
CREATE TABLE "subscription_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"change" "subscription_change" NOT NULL,
	"source" "subscription_change_source" NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_plan_version_id" uuid,
	"previous_status" "subscription_status",
	"previous_period_end" timestamp with time zone,
	"plan_version_id" uuid NOT NULL,
	"status" "subscription_status" NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"reference" text,
	"request_id" text,
	CONSTRAINT "subscription_history_sequence_positive" CHECK ("subscription_history"."sequence" >= 1),
	CONSTRAINT "subscription_history_previous_complete" CHECK (("subscription_history"."previous_plan_version_id" IS NULL) = ("subscription_history"."previous_status" IS NULL) AND ("subscription_history"."previous_status" IS NULL) = ("subscription_history"."previous_period_end" IS NULL)),
	CONSTRAINT "subscription_history_admin_attributed" CHECK ("subscription_history"."source" <> 'admin' OR ("subscription_history"."actor_user_id" IS NOT NULL AND length(btrim(coalesce("subscription_history"."reason", ''))) > 0))
);
--> statement-breakpoint
ALTER TABLE "subscription_history" ADD CONSTRAINT "subscription_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_history" ADD CONSTRAINT "subscription_history_previous_plan_version_id_economy_plan_versions_id_fk" FOREIGN KEY ("previous_plan_version_id") REFERENCES "public"."economy_plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_history" ADD CONSTRAINT "subscription_history_plan_version_id_economy_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."economy_plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_history_user_sequence_idx" ON "subscription_history" USING btree ("user_id","sequence");