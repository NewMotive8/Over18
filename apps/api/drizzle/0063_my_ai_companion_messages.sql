-- My AI: talking to a companion you made.
--
-- NO CONVERSATION ROW, and that is the whole shape of it. A catalogue
-- character is talked to by thousands of people, so `conversations` exists to
-- separate one person's thread from another's. A companion belongs to exactly
-- one account: she IS the thread. A conversations row would carry a user id
-- that could only ever hold her owner's, and a second place for ownership to
-- be got wrong.
--
-- `message_sender` is the EXISTING enum ('user', 'character'). She is a
-- character in the only sense this column cares about -- the side of the
-- conversation the words came from.
--
-- Hand-written like 0058-0062, for the same reason: drizzle-kit's snapshot
-- predates those migrations and regenerating would re-add columns that exist.

CREATE TABLE "user_companion_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"companion_id" uuid NOT NULL,
	"sender" "message_sender" NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ON DELETE CASCADE: deleting a companion takes the conversation with her.
-- Nothing on disk to clean up, unlike her photographs.
ALTER TABLE "user_companion_messages" ADD CONSTRAINT "user_companion_messages_companion_id_user_companions_id_fk" FOREIGN KEY ("companion_id") REFERENCES "public"."user_companions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Every read is "this companion's messages, oldest first". Also covers the
-- foreign key, which Postgres does not index on its own.
CREATE INDEX "user_companion_messages_companion_created_idx" ON "user_companion_messages" USING btree ("companion_id","created_at");
