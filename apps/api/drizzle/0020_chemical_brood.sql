CREATE TABLE "prompt_drive_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" text NOT NULL,
	"drive_folder_id" text NOT NULL,
	"folder_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_drive_folders_slot_idx" ON "prompt_drive_folders" USING btree ("slot");