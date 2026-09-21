CREATE TYPE "public"."payment_kind" AS ENUM('subscription', 'credit_pack');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'cancelled', 'refunded', 'disputed');--> statement-breakpoint
ALTER TYPE "public"."subscription_change_source" ADD VALUE 'payment';--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_ref" text NOT NULL,
	"payment_id" uuid,
	"type" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"product_ref" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"checkout_ref" text NOT NULL,
	"transaction_ref" text,
	"provider_subscription_ref" text,
	"provider_customer_ref" text,
	"method_hint" text,
	"idempotency_key" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_minor" > 0),
	CONSTRAINT "payments_currency_format" CHECK ("payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_settled_by_status" CHECK (("payments"."status" = 'pending') = ("payments"."settled_at" is null))
);
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_ref_idx" ON "payment_events" USING btree ("provider","event_ref");--> statement-breakpoint
CREATE INDEX "payment_events_payment_idx" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_checkout_idx" ON "payments" USING btree ("provider","checkout_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_user_idempotency_idx" ON "payments" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id","created_at");