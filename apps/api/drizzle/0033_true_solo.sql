CREATE TYPE "public"."credit_class" AS ENUM('included', 'earned', 'purchased');--> statement-breakpoint
CREATE TYPE "public"."wallet_entry_direction" AS ENUM('credit', 'debit');--> statement-breakpoint
CREATE TYPE "public"."wallet_entry_type" AS ENUM('grant', 'reward', 'purchase', 'paid_action', 'refund', 'reversal', 'admin_adjustment', 'hold', 'capture', 'release');--> statement-breakpoint
CREATE TABLE "wallet_currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_currencies_code_format" CHECK ("wallet_currencies"."code" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"entry_type" "wallet_entry_type" NOT NULL,
	"direction" "wallet_entry_direction" NOT NULL,
	"amount" integer NOT NULL,
	"credit_class" "credit_class" NOT NULL,
	"balance_after" integer DEFAULT 0 NOT NULL,
	"held_after" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"related_transaction_id" uuid,
	"source_type" text,
	"source_id" text,
	"reason" text,
	"actor_user_id" uuid,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_transactions_amount_positive" CHECK ("wallet_transactions"."amount" > 0),
	CONSTRAINT "wallet_transactions_sequence_positive" CHECK ("wallet_transactions"."sequence" > 0),
	CONSTRAINT "wallet_transactions_after_non_negative" CHECK ("wallet_transactions"."balance_after" >= 0 and "wallet_transactions"."held_after" >= 0),
	CONSTRAINT "wallet_transactions_direction_by_type" CHECK (("wallet_transactions"."entry_type" in ('grant', 'reward', 'purchase', 'refund', 'release') and "wallet_transactions"."direction" = 'credit')
        or ("wallet_transactions"."entry_type" in ('paid_action', 'hold', 'capture') and "wallet_transactions"."direction" = 'debit')
        or "wallet_transactions"."entry_type" in ('reversal', 'admin_adjustment')),
	CONSTRAINT "wallet_transactions_related_by_type" CHECK (("wallet_transactions"."related_transaction_id" is not null) = ("wallet_transactions"."entry_type" in ('capture', 'release', 'refund', 'reversal'))),
	CONSTRAINT "wallet_transactions_not_self_related" CHECK ("wallet_transactions"."related_transaction_id" is null or "wallet_transactions"."related_transaction_id" <> "wallet_transactions"."id"),
	CONSTRAINT "wallet_transactions_admin_attributed" CHECK ("wallet_transactions"."entry_type" <> 'admin_adjustment' or (
        "wallet_transactions"."actor_user_id" is not null and "wallet_transactions"."reason" is not null and length(btrim("wallet_transactions"."reason")) > 0
      )),
	CONSTRAINT "wallet_transactions_idempotency_key_format" CHECK (length(btrim("wallet_transactions"."idempotency_key")) > 0 and length("wallet_transactions"."idempotency_key") <= 200),
	CONSTRAINT "wallet_transactions_source_complete" CHECK (("wallet_transactions"."source_type" is null and "wallet_transactions"."source_id" is null) or (
        "wallet_transactions"."source_type" ~ '^[a-z][a-z0-9_]{1,63}$' and "wallet_transactions"."source_id" is not null and length(btrim("wallet_transactions"."source_id")) > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"held" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_user_currency_unique" UNIQUE("user_id","currency"),
	CONSTRAINT "wallets_balance_non_negative" CHECK ("wallets"."balance" >= 0),
	CONSTRAINT "wallets_held_non_negative" CHECK ("wallets"."held" >= 0),
	CONSTRAINT "wallets_version_non_negative" CHECK ("wallets"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_related_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("related_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_fk" FOREIGN KEY ("user_id","currency") REFERENCES "public"."wallets"("user_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_currency_wallet_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."wallet_currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_sequence_idx" ON "wallet_transactions" USING btree ("user_id","currency","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_idempotency_idx" ON "wallet_transactions" USING btree ("user_id","currency","idempotency_key");--> statement-breakpoint
CREATE INDEX "wallet_transactions_related_idx" ON "wallet_transactions" USING btree ("related_transaction_id") WHERE "wallet_transactions"."related_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "wallet_transactions_source_idx" ON "wallet_transactions" USING btree ("source_type","source_id") WHERE "wallet_transactions"."source_type" is not null;