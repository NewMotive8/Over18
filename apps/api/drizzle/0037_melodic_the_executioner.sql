CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "account_status" DEFAULT 'active' NOT NULL;