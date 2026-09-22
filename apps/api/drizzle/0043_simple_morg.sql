CREATE TABLE "content_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"paid_action_id" uuid NOT NULL,
	"credit_price" integer NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	CONSTRAINT "content_entitlements_price_positive" CHECK ("content_entitlements"."credit_price" > 0),
	CONSTRAINT "content_entitlements_revocation_complete" CHECK (("content_entitlements"."revoked_at" is null) = ("content_entitlements"."revoke_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "paid_actions" ALTER COLUMN "ruleset_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "paid_actions" ALTER COLUMN "ruleset_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "paid_actions" ADD COLUMN "price_source" text DEFAULT 'ruleset' NOT NULL;--> statement-breakpoint
ALTER TABLE "paid_actions" ADD COLUMN "price_ref_id" text;--> statement-breakpoint
ALTER TABLE "content_entitlements" ADD CONSTRAINT "content_entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_entitlements" ADD CONSTRAINT "content_entitlements_offer_id_content_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."content_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_entitlements" ADD CONSTRAINT "content_entitlements_paid_action_id_paid_actions_id_fk" FOREIGN KEY ("paid_action_id") REFERENCES "public"."paid_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_entitlements_live_idx" ON "content_entitlements" USING btree ("user_id","offer_id") WHERE "content_entitlements"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "content_entitlements_paid_action_idx" ON "content_entitlements" USING btree ("paid_action_id");--> statement-breakpoint
CREATE INDEX "content_entitlements_user_idx" ON "content_entitlements" USING btree ("user_id","acquired_at");--> statement-breakpoint
ALTER TABLE "paid_actions" ADD CONSTRAINT "paid_actions_price_source_format" CHECK ("paid_actions"."price_source" ~ '^[a-z][a-z0-9_]{1,63}$');--> statement-breakpoint
ALTER TABLE "paid_actions" ADD CONSTRAINT "paid_actions_price_pinned" CHECK (("paid_actions"."price_source" = 'ruleset') = ("paid_actions"."ruleset_id" is not null)
        and ("paid_actions"."ruleset_id" is not null) = ("paid_actions"."ruleset_version" is not null)
        and ("paid_actions"."price_source" = 'ruleset') = ("paid_actions"."price_ref_id" is null));