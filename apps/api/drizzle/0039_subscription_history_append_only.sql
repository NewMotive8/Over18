-- subscription_history is APPEND-ONLY, enforced by the database (P3.5).
--
-- A custom migration, generated with `drizzle-kit generate --custom`: drizzle
-- cannot express a trigger. Kept in its OWN file, beside the table in 0038, as
-- 0026 is beside audit_log -- so it can be reviewed, and reverted, on its own.
--
-- UPDATE and DELETE are refused: a recorded change is never rewritten or
-- removed, so the history cannot lose a previous state. INSERT is unaffected.
-- TRUNCATE is not a row-level operation and is also unaffected, which the test
-- harness relies on to reset the database between tests.
CREATE OR REPLACE FUNCTION "subscription_history_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'subscription_history is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "subscription_history_append_only"
  BEFORE UPDATE OR DELETE ON "subscription_history"
  FOR EACH ROW EXECUTE FUNCTION "subscription_history_reject_mutation"();
