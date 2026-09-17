CREATE TYPE "public"."economy_cost_unit" AS ENUM('per_action', 'per_minute');--> statement-breakpoint
CREATE TYPE "public"."economy_version_status" AS ENUM('draft', 'published', 'cancelled');--> statement-breakpoint
CREATE TABLE "economy_pack_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"display_name" text NOT NULL,
	"credits" integer NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_best_value" boolean DEFAULT false NOT NULL,
	"is_purchasable" boolean DEFAULT true NOT NULL,
	"status" "economy_version_status" DEFAULT 'draft' NOT NULL,
	"effective_from" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"publish_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "economy_pack_versions_version_positive" CHECK ("economy_pack_versions"."version" >= 1),
	CONSTRAINT "economy_pack_versions_display_name" CHECK (length(btrim("economy_pack_versions"."display_name")) > 0),
	CONSTRAINT "economy_pack_versions_credits_positive" CHECK ("economy_pack_versions"."credits" > 0),
	CONSTRAINT "economy_pack_versions_price_positive" CHECK ("economy_pack_versions"."price_minor" > 0),
	CONSTRAINT "economy_pack_versions_currency" CHECK ("economy_pack_versions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "economy_pack_versions_sort_order" CHECK ("economy_pack_versions"."sort_order" >= 0),
	CONSTRAINT "economy_pack_versions_published_complete" CHECK ("economy_pack_versions"."status" = 'draft' OR (
        "economy_pack_versions"."effective_from" IS NOT NULL AND "economy_pack_versions"."published_at" IS NOT NULL
        AND "economy_pack_versions"."published_by" IS NOT NULL
        AND "economy_pack_versions"."publish_reason" IS NOT NULL AND length(btrim("economy_pack_versions"."publish_reason")) > 0
        AND "economy_pack_versions"."effective_from" >= "economy_pack_versions"."published_at"
      )),
	CONSTRAINT "economy_pack_versions_draft_unpublished" CHECK ("economy_pack_versions"."status" <> 'draft' OR (
        "economy_pack_versions"."published_at" IS NULL AND "economy_pack_versions"."published_by" IS NULL AND "economy_pack_versions"."cancelled_at" IS NULL
      )),
	CONSTRAINT "economy_pack_versions_cancellation_complete" CHECK (("economy_pack_versions"."status" = 'cancelled') = (
        "economy_pack_versions"."cancelled_at" IS NOT NULL AND "economy_pack_versions"."cancelled_by" IS NOT NULL
        AND "economy_pack_versions"."cancel_reason" IS NOT NULL AND length(btrim("economy_pack_versions"."cancel_reason")) > 0
      )),
	CONSTRAINT "economy_pack_versions_cancelled_before_effective" CHECK ("economy_pack_versions"."cancelled_at" IS NULL OR "economy_pack_versions"."cancelled_at" < "economy_pack_versions"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "economy_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "economy_packs_code_unique" UNIQUE("code"),
	CONSTRAINT "economy_packs_code_format" CHECK ("economy_packs"."code" ~ '^[a-z][a-z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "economy_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"display_name" text NOT NULL,
	"billing_period_months" integer NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"monthly_included_credits" integer NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_purchasable" boolean DEFAULT true NOT NULL,
	"status" "economy_version_status" DEFAULT 'draft' NOT NULL,
	"effective_from" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"publish_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "economy_plan_versions_version_positive" CHECK ("economy_plan_versions"."version" >= 1),
	CONSTRAINT "economy_plan_versions_display_name" CHECK (length(btrim("economy_plan_versions"."display_name")) > 0),
	CONSTRAINT "economy_plan_versions_billing_period" CHECK ("economy_plan_versions"."billing_period_months" BETWEEN 1 AND 36),
	CONSTRAINT "economy_plan_versions_price_positive" CHECK ("economy_plan_versions"."price_minor" > 0),
	CONSTRAINT "economy_plan_versions_currency" CHECK ("economy_plan_versions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "economy_plan_versions_credits" CHECK ("economy_plan_versions"."monthly_included_credits" >= 0),
	CONSTRAINT "economy_plan_versions_features_object" CHECK (jsonb_typeof("economy_plan_versions"."features") = 'object'),
	CONSTRAINT "economy_plan_versions_published_complete" CHECK ("economy_plan_versions"."status" = 'draft' OR (
        "economy_plan_versions"."effective_from" IS NOT NULL AND "economy_plan_versions"."published_at" IS NOT NULL
        AND "economy_plan_versions"."published_by" IS NOT NULL
        AND "economy_plan_versions"."publish_reason" IS NOT NULL AND length(btrim("economy_plan_versions"."publish_reason")) > 0
        AND "economy_plan_versions"."effective_from" >= "economy_plan_versions"."published_at"
      )),
	CONSTRAINT "economy_plan_versions_draft_unpublished" CHECK ("economy_plan_versions"."status" <> 'draft' OR (
        "economy_plan_versions"."published_at" IS NULL AND "economy_plan_versions"."published_by" IS NULL AND "economy_plan_versions"."cancelled_at" IS NULL
      )),
	CONSTRAINT "economy_plan_versions_cancellation_complete" CHECK (("economy_plan_versions"."status" = 'cancelled') = (
        "economy_plan_versions"."cancelled_at" IS NOT NULL AND "economy_plan_versions"."cancelled_by" IS NOT NULL
        AND "economy_plan_versions"."cancel_reason" IS NOT NULL AND length(btrim("economy_plan_versions"."cancel_reason")) > 0
      )),
	CONSTRAINT "economy_plan_versions_cancelled_before_effective" CHECK ("economy_plan_versions"."cancelled_at" IS NULL OR "economy_plan_versions"."cancelled_at" < "economy_plan_versions"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "economy_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "economy_plans_code_unique" UNIQUE("code"),
	CONSTRAINT "economy_plans_code_format" CHECK ("economy_plans"."code" ~ '^[a-z][a-z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "economy_ruleset_action_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ruleset_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"quality_tier" text DEFAULT 'standard' NOT NULL,
	"max_duration_seconds" integer,
	"unit" "economy_cost_unit" DEFAULT 'per_action' NOT NULL,
	"credit_cost" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "economy_ruleset_action_costs_action_key" CHECK ("economy_ruleset_action_costs"."action_type" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "economy_ruleset_action_costs_tier_key" CHECK ("economy_ruleset_action_costs"."quality_tier" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "economy_ruleset_action_costs_cost_positive" CHECK ("economy_ruleset_action_costs"."credit_cost" > 0),
	CONSTRAINT "economy_ruleset_action_costs_duration" CHECK ("economy_ruleset_action_costs"."max_duration_seconds" IS NULL OR "economy_ruleset_action_costs"."max_duration_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "economy_ruleset_allowances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ruleset_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "economy_ruleset_allowances_key_format" CHECK ("economy_ruleset_allowances"."key" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "economy_ruleset_allowances_value" CHECK ("economy_ruleset_allowances"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "economy_ruleset_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ruleset_id" uuid NOT NULL,
	"reward_key" text NOT NULL,
	"credits" integer NOT NULL,
	"per_user_cap" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "economy_ruleset_rewards_key_format" CHECK ("economy_ruleset_rewards"."reward_key" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "economy_ruleset_rewards_credits_positive" CHECK ("economy_ruleset_rewards"."credits" > 0),
	CONSTRAINT "economy_ruleset_rewards_cap" CHECK ("economy_ruleset_rewards"."per_user_cap" IS NULL OR "economy_ruleset_rewards"."per_user_cap" > 0)
);
--> statement-breakpoint
CREATE TABLE "economy_rulesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"status" "economy_version_status" DEFAULT 'draft' NOT NULL,
	"effective_from" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"publish_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "economy_rulesets_version_positive" CHECK ("economy_rulesets"."version" >= 1),
	CONSTRAINT "economy_rulesets_published_complete" CHECK ("economy_rulesets"."status" = 'draft' OR (
        "economy_rulesets"."effective_from" IS NOT NULL AND "economy_rulesets"."published_at" IS NOT NULL
        AND "economy_rulesets"."published_by" IS NOT NULL
        AND "economy_rulesets"."publish_reason" IS NOT NULL AND length(btrim("economy_rulesets"."publish_reason")) > 0
        AND "economy_rulesets"."effective_from" >= "economy_rulesets"."published_at"
      )),
	CONSTRAINT "economy_rulesets_draft_unpublished" CHECK ("economy_rulesets"."status" <> 'draft' OR (
        "economy_rulesets"."published_at" IS NULL AND "economy_rulesets"."published_by" IS NULL AND "economy_rulesets"."cancelled_at" IS NULL
      )),
	CONSTRAINT "economy_rulesets_cancellation_complete" CHECK (("economy_rulesets"."status" = 'cancelled') = (
        "economy_rulesets"."cancelled_at" IS NOT NULL AND "economy_rulesets"."cancelled_by" IS NOT NULL
        AND "economy_rulesets"."cancel_reason" IS NOT NULL AND length(btrim("economy_rulesets"."cancel_reason")) > 0
      )),
	CONSTRAINT "economy_rulesets_cancelled_before_effective" CHECK ("economy_rulesets"."cancelled_at" IS NULL OR "economy_rulesets"."cancelled_at" < "economy_rulesets"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "economy_pack_versions" ADD CONSTRAINT "economy_pack_versions_pack_id_economy_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."economy_packs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_plan_versions" ADD CONSTRAINT "economy_plan_versions_plan_id_economy_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."economy_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_ruleset_action_costs" ADD CONSTRAINT "economy_ruleset_action_costs_ruleset_id_economy_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."economy_rulesets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_ruleset_allowances" ADD CONSTRAINT "economy_ruleset_allowances_ruleset_id_economy_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."economy_rulesets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_ruleset_rewards" ADD CONSTRAINT "economy_ruleset_rewards_ruleset_id_economy_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."economy_rulesets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "economy_pack_versions_version_idx" ON "economy_pack_versions" USING btree ("pack_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "economy_pack_versions_effective_idx" ON "economy_pack_versions" USING btree ("pack_id","effective_from") WHERE status = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "economy_pack_versions_one_draft_idx" ON "economy_pack_versions" USING btree ("pack_id") WHERE status = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "economy_plan_versions_version_idx" ON "economy_plan_versions" USING btree ("plan_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "economy_plan_versions_effective_idx" ON "economy_plan_versions" USING btree ("plan_id","effective_from") WHERE status = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "economy_plan_versions_one_draft_idx" ON "economy_plan_versions" USING btree ("plan_id") WHERE status = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "economy_ruleset_action_costs_tier_idx" ON "economy_ruleset_action_costs" USING btree ("ruleset_id","action_type","quality_tier",coalesce("max_duration_seconds", -1));--> statement-breakpoint
CREATE UNIQUE INDEX "economy_ruleset_allowances_key_idx" ON "economy_ruleset_allowances" USING btree ("ruleset_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "economy_ruleset_rewards_key_idx" ON "economy_ruleset_rewards" USING btree ("ruleset_id","reward_key");--> statement-breakpoint
CREATE UNIQUE INDEX "economy_rulesets_version_idx" ON "economy_rulesets" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "economy_rulesets_effective_idx" ON "economy_rulesets" USING btree ("effective_from") WHERE status = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "economy_rulesets_one_draft_idx" ON "economy_rulesets" USING btree ("status") WHERE status = 'draft';