CREATE TABLE "prompt_drive_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" text NOT NULL,
	"refresh_token_ciphertext" text NOT NULL,
	"refresh_token_iv" text NOT NULL,
	"refresh_token_tag" text NOT NULL,
	"google_account_email" text,
	"scope" text,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_error_kind" text,
	"last_error_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prompt_drive_oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prompt_drive_connections" ADD CONSTRAINT "prompt_drive_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_drive_oauth_states" ADD CONSTRAINT "prompt_drive_oauth_states_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_drive_connections_slot_idx" ON "prompt_drive_connections" USING btree ("slot");--> statement-breakpoint
CREATE INDEX "prompt_drive_oauth_states_expires_idx" ON "prompt_drive_oauth_states" USING btree ("expires_at");