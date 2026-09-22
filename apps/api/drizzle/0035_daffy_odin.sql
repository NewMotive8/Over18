CREATE TYPE "public"."subscription_status" AS ENUM('active', 'past_due', 'grace', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"status" "subscription_status" NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_version_id_economy_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."economy_plan_versions"("id") ON DELETE restrict ON UPDATE no action;