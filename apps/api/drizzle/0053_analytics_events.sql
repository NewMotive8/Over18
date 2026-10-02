CREATE TABLE "analytics_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	CONSTRAINT "analytics_events_name_format" CHECK ("analytics_events"."name" ~ '^[a-z][a-z_]{1,63}$'),
	CONSTRAINT "analytics_events_source" CHECK ("analytics_events"."source" in ('server', 'client')),
	CONSTRAINT "analytics_events_properties_object" CHECK (jsonb_typeof("analytics_events"."properties") = 'object')
);
--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_events_name_occurred_idx" ON "analytics_events" USING btree ("name","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_user_occurred_idx" ON "analytics_events" USING btree ("user_id","occurred_at");