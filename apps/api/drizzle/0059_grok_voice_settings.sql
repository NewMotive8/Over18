-- Grok's own voice settings, BESIDE SpicyAPI's rather than instead of them.
--
-- WHY THREE NEW COLUMNS AND NOT A REWRITE. `live_call_voice` holds a SpicyAPI
-- voice name and `conversation_style` holds how she carries a call; both are in
-- use and both must survive, because rolling back to SpicyAPI is meant to be
-- one environment variable (`VOICE_LLM_PROVIDER`) and not a data migration.
-- Overwriting or migrating either would make that rollback lossy.
--
-- EVERY ROW STARTS NULL, AND NULL MEANS "NOT CONFIGURED FOR GROK YET":
--   grok_voice             falls back to the SpicyAPI voice through the
--                          existing SPICYAPI_TO_GROK mapping, then the default
--   grok_speaking_style    falls back to conversation_style, which is what a
--                          Grok call already uses today
--   grok_call_instructions adds nothing when absent
-- So no character needs reconfiguring and nothing sounds different on deploy.
--
-- NO CHECK CONSTRAINTS. A voice id is validated against the published roster in
-- the application, which is where the roster lives; pinning the list in SQL
-- would mean a migration every time xAI adds a voice.
--
-- IDEMPOTENT: every statement is guarded, so re-running is a no-op.

ALTER TABLE "characters" ADD COLUMN IF NOT EXISTS "grok_voice" text;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN IF NOT EXISTS "grok_speaking_style" text;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN IF NOT EXISTS "grok_call_instructions" text;
