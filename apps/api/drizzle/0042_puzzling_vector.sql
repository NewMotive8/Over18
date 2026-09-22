CREATE TYPE "public"."paid_action_status" AS ENUM('held', 'captured', 'released', 'refunded');--> statement-breakpoint
CREATE TABLE "paid_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"quality_tier" text NOT NULL,
	"duration_seconds" integer,
	"currency" text NOT NULL,
	"amount" integer NOT NULL,
	"ruleset_id" uuid NOT NULL,
	"ruleset_version" integer NOT NULL,
	"status" "paid_action_status" DEFAULT 'held' NOT NULL,
	"hold_transaction_id" uuid NOT NULL,
	"settlement_transaction_id" uuid,
	"refund_transaction_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_id" text,
	"failure_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "paid_actions_amount_positive" CHECK ("paid_actions"."amount" > 0),
	CONSTRAINT "paid_actions_duration_positive" CHECK ("paid_actions"."duration_seconds" is null or "paid_actions"."duration_seconds" > 0),
	CONSTRAINT "paid_actions_settlement_by_status" CHECK (("paid_actions"."status" = 'held') = ("paid_actions"."settlement_transaction_id" is null)
        and ("paid_actions"."status" = 'held') = ("paid_actions"."settled_at" is null)),
	CONSTRAINT "paid_actions_refund_by_status" CHECK (("paid_actions"."status" = 'refunded') = ("paid_actions"."refund_transaction_id" is not null)
        and ("paid_actions"."refund_transaction_id" is null or "paid_actions"."settlement_transaction_id" is not null)),
	CONSTRAINT "paid_actions_idempotency_key_format" CHECK (length(btrim("paid_actions"."idempotency_key")) > 0 and length("paid_actions"."idempotency_key") <= 200)
);
--> statement-breakpoint
ALTER TABLE "paid_actions" ADD CONSTRAINT "paid_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_actions" ADD CONSTRAINT "paid_actions_currency_wallet_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."wallet_currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_actions" ADD CONSTRAINT "paid_actions_ruleset_id_economy_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."economy_rulesets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_actions" ADD CONSTRAINT "paid_actions_hold_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("hold_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_actions" ADD CONSTRAINT "paid_actions_settlement_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("settlement_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_actions" ADD CONSTRAINT "paid_actions_refund_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("refund_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paid_actions_idempotency_idx" ON "paid_actions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "paid_actions_hold_idx" ON "paid_actions" USING btree ("hold_transaction_id");--> statement-breakpoint
CREATE INDEX "paid_actions_user_idx" ON "paid_actions" USING btree ("user_id","created_at");