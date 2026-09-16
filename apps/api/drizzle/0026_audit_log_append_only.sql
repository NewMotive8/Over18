-- audit_log is APPEND-ONLY, enforced by the database (PRD v1.2 section 34.2).
--
-- A custom migration, generated with `drizzle-kit generate --custom`: drizzle
-- cannot express a trigger. It is kept in its OWN file so it can be reviewed,
-- and reverted, independently of the tables in 0025.
--
-- UPDATE and DELETE are refused. INSERT is unaffected. TRUNCATE is not a
-- row-level operation and is also unaffected, which the test harness relies
-- on to reset the database between tests.
CREATE OR REPLACE FUNCTION "audit_log_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_mutation"();
