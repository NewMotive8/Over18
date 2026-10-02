ALTER TYPE "public"."credit_class" ADD VALUE 'bonus';--> statement-breakpoint
ALTER TABLE "economy_pack_versions" ADD COLUMN "badge" text;--> statement-breakpoint
ALTER TABLE "economy_pack_versions" ADD COLUMN "bonus_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "economy_pack_versions" ADD COLUMN "was_price_minor" integer;--> statement-breakpoint
ALTER TABLE "economy_pack_versions" ADD COLUMN "promotion_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "terms" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "context" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "economy_pack_versions" ADD CONSTRAINT "economy_pack_versions_badge" CHECK ("economy_pack_versions"."badge" is null or (length(btrim("economy_pack_versions"."badge")) > 0 and length("economy_pack_versions"."badge") <= 40));--> statement-breakpoint
ALTER TABLE "economy_pack_versions" ADD CONSTRAINT "economy_pack_versions_bonus_credits" CHECK ("economy_pack_versions"."bonus_credits" >= 0);--> statement-breakpoint
ALTER TABLE "economy_pack_versions" ADD CONSTRAINT "economy_pack_versions_was_price" CHECK ("economy_pack_versions"."was_price_minor" is null or "economy_pack_versions"."was_price_minor" > "economy_pack_versions"."price_minor");--> statement-breakpoint
ALTER TABLE "economy_pack_versions" ADD CONSTRAINT "economy_pack_versions_promotion_needs_was_price" CHECK ("economy_pack_versions"."promotion_ends_at" is null or "economy_pack_versions"."was_price_minor" is not null);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_terms_object" CHECK (jsonb_typeof("payments"."terms") = 'object');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_context_object" CHECK (jsonb_typeof("payments"."context") = 'object');