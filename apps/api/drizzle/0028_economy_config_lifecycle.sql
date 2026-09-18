-- Economy configuration lifecycle (PRD v1.2 sections 20, 30.1, 31) -- P1.1.
--
-- A custom migration, generated with `drizzle-kit generate --custom`: drizzle
-- cannot express triggers. 0027 defines what each STATE must contain (CHECK
-- constraints, unique and partial indexes); this defines the TRANSITIONS
-- between states, which a CHECK cannot see because it has no OLD row.
--
-- Rules enforced for economy_plan_versions, economy_pack_versions and
-- economy_rulesets:
--
--   1. A row is created as `draft`. Publication is always an explicit UPDATE.
--   2. draft -> published stamps published_at from the database clock and, when
--      no effective_from was given, makes the version effective immediately.
--      The 0027 CHECK then guarantees effective_from >= published_at: no
--      published price can ever apply retroactively.
--   3. Publishing keeps history linear: a higher version number must take
--      effect strictly after every lower published version, and a lower one
--      strictly before every higher one. Two publishes of one parent cannot
--      race today, because 0027 allows only one open draft per parent; the
--      per-parent advisory lock keeps this check correct if that rule is ever
--      relaxed.
--   4. A published row is immutable. The only permitted change is
--      published -> cancelled, and only while effective_from is still in the
--      future. Once a version has applied, it is superseded, never rewritten.
--   5. A cancelled row is immutable.
--   6. Only drafts may be deleted; a draft is deleted rather than cancelled.
--
-- And for a ruleset's action costs, allowances and rewards:
--
--   7. They can be inserted, changed or deleted only while their ruleset is a
--      draft. The ruleset row is share-locked while checking, so a child cannot
--      slip into a ruleset that is being published concurrently.
--
-- TRUNCATE is unaffected (statement-level), which the test harness relies on.
-- Error code 23514 (check_violation) throughout, matching the 0027 CHECKs.

CREATE OR REPLACE FUNCTION "economy_version_guard"() RETURNS trigger AS $$
DECLARE
  -- The version's parent column (e.g. plan_id), or '' for the global ruleset stream.
  parent_col text := TG_ARGV[0];
  parent_id uuid;
  conflicting integer;
  immutable_keys text[] := ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION '%: a version must be created as a draft (got %); publish it with an explicit update',
        TG_TABLE_NAME, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION '%: version % is % and cannot be deleted; only drafts can',
        TG_TABLE_NAME, OLD.version, OLD.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION '%: version % is cancelled and immutable', TG_TABLE_NAME, OLD.version
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.status <> 'cancelled'
       OR (to_jsonb(NEW) - immutable_keys) IS DISTINCT FROM (to_jsonb(OLD) - immutable_keys) THEN
      RAISE EXCEPTION '%: version % is published and immutable; the only permitted change is cancelling it before it takes effect',
        TG_TABLE_NAME, OLD.version USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.effective_from <= now() THEN
      RAISE EXCEPTION '%: version % has already taken effect and cannot be cancelled; publish a new version instead',
        TG_TABLE_NAME, OLD.version USING ERRCODE = 'check_violation';
    END IF;
    NEW.cancelled_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- OLD.status = 'draft'
  NEW.updated_at := now();
  IF NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION '%: a draft is deleted, not cancelled', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  -- draft -> published
  NEW.published_at := now();
  NEW.effective_from := coalesce(NEW.effective_from, now());

  IF parent_col <> '' THEN
    EXECUTE format('SELECT ($1).%I', parent_col) INTO parent_id USING NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_NAME || ':' || coalesce(parent_id::text, '*'), 0));

  EXECUTE format(
    'SELECT version FROM %I
      WHERE status = ''published'' AND id <> $1 %s
        AND ((version < $2 AND effective_from >= $3) OR (version > $2 AND effective_from <= $3))
      ORDER BY version
      LIMIT 1',
    TG_TABLE_NAME,
    CASE WHEN parent_col <> '' THEN format('AND %I = $4', parent_col) ELSE '' END
  ) INTO conflicting USING NEW.id, NEW.version, NEW.effective_from, parent_id;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION '%: version % cannot take effect at % -- published version % would then be out of order; later versions must take effect strictly later',
      TG_TABLE_NAME, NEW.version, NEW.effective_from, conflicting USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "economy_plan_versions_lifecycle"
  BEFORE INSERT OR UPDATE OR DELETE ON "economy_plan_versions"
  FOR EACH ROW EXECUTE FUNCTION "economy_version_guard"('plan_id');
--> statement-breakpoint
CREATE TRIGGER "economy_pack_versions_lifecycle"
  BEFORE INSERT OR UPDATE OR DELETE ON "economy_pack_versions"
  FOR EACH ROW EXECUTE FUNCTION "economy_version_guard"('pack_id');
--> statement-breakpoint
CREATE TRIGGER "economy_rulesets_lifecycle"
  BEFORE INSERT OR UPDATE OR DELETE ON "economy_rulesets"
  FOR EACH ROW EXECUTE FUNCTION "economy_version_guard"('');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "economy_ruleset_child_guard"() RETURNS trigger AS $$
DECLARE
  ruleset_status "economy_version_status";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    -- A ruleset row this transaction is deleting (a draft's cascade) is no
    -- longer visible, so NULL means "going away with its parent": allowed.
    SELECT status INTO ruleset_status FROM "economy_rulesets" WHERE id = OLD.ruleset_id FOR SHARE;
    IF ruleset_status IS NOT NULL AND ruleset_status <> 'draft' THEN
      RAISE EXCEPTION '%: ruleset is % and its rows are frozen', TG_TABLE_NAME, ruleset_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO ruleset_status FROM "economy_rulesets" WHERE id = NEW.ruleset_id FOR SHARE;
    IF ruleset_status IS NOT NULL AND ruleset_status <> 'draft' THEN
      RAISE EXCEPTION '%: ruleset is % and its rows are frozen', TG_TABLE_NAME, ruleset_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "economy_ruleset_action_costs_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "economy_ruleset_action_costs"
  FOR EACH ROW EXECUTE FUNCTION "economy_ruleset_child_guard"();
--> statement-breakpoint
CREATE TRIGGER "economy_ruleset_allowances_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "economy_ruleset_allowances"
  FOR EACH ROW EXECUTE FUNCTION "economy_ruleset_child_guard"();
--> statement-breakpoint
CREATE TRIGGER "economy_ruleset_rewards_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "economy_ruleset_rewards"
  FOR EACH ROW EXECUTE FUNCTION "economy_ruleset_child_guard"();
