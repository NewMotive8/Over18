-- Economy runtime authority (PRD v1.2 sections 19.2, 30.1, 31) -- P1.2.
--
-- A custom migration (drizzle cannot express triggers). It REPLACES the 0028
-- version guard in place -- 0028 itself is not edited -- and closes three gaps
-- the P1.1 review demonstrated, each of which would undermine the resolver's
-- guarantees:
--
--   1. THE REAL CLOCK, NOT TRANSACTION START. 0028 stamped published_at and an
--      immediate effective_from with now(), which is the start of the
--      transaction. A slow publishing transaction therefore back-dated its own
--      effect. Both are now stamped with clock_timestamp(), so a version takes
--      effect at the instant it is actually published.
--
--   2. A RESOLVED VERSION CAN NEVER BECOME CANCELLED. 0028 compared a
--      cancellation with now(), so a transaction that began just before
--      effective_from could cancel a version the resolver had ALREADY served
--      live (demonstrated in review). A downstream record naming that version
--      would then point at something that "never took effect". Cancellation is
--      now judged by clock_timestamp() AND must happen at least one minute
--      before effective_from. Inside that minute a version can no longer be
--      withdrawn -- it is superseded by a newer version instead, exactly as an
--      effective one is. The margin covers transaction and commit latency, and
--      reasonable clock differences between the database and any host that
--      reads it.
--
--   3. STABLE IDENTITY. economy_plans.code and economy_packs.code are the keys
--      the resolver resolves by, and the identity P0's planCode carries. They
--      could be renamed; they are now immutable once created. A parent with no
--      versions can still be deleted.
--
-- Unchanged from 0028: drafts only on insert; explicit publication; linear
-- version ordering; immutability of published and cancelled rows; drafts-only
-- deletion; frozen ruleset children.

CREATE OR REPLACE FUNCTION "economy_version_guard"() RETURNS trigger AS $$
DECLARE
  parent_col text := TG_ARGV[0];
  parent_id uuid;
  conflicting integer;
  immutable_keys text[] := ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at'];
  -- Wall-clock time at this statement, deliberately NOT now() (transaction start).
  instant timestamptz := clock_timestamp();
  cancellation_margin constant interval := interval '1 minute';
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
    IF OLD.effective_from <= instant THEN
      RAISE EXCEPTION '%: version % has already taken effect and cannot be cancelled; publish a new version instead',
        TG_TABLE_NAME, OLD.version USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.effective_from - cancellation_margin <= instant THEN
      RAISE EXCEPTION '%: version % takes effect within % and can no longer be cancelled; publish a new version to supersede it',
        TG_TABLE_NAME, OLD.version, cancellation_margin USING ERRCODE = 'check_violation';
    END IF;
    NEW.cancelled_at := instant;
    NEW.updated_at := instant;
    RETURN NEW;
  END IF;

  -- OLD.status = 'draft'
  NEW.updated_at := instant;
  IF NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION '%: a draft is deleted, not cancelled', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  -- draft -> published
  NEW.published_at := instant;
  NEW.effective_from := coalesce(NEW.effective_from, instant);

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
CREATE OR REPLACE FUNCTION "economy_parent_code_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION '%: code "%" is a stable identity and cannot be changed', TG_TABLE_NAME, OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "economy_plans_code_immutable"
  BEFORE UPDATE ON "economy_plans"
  FOR EACH ROW EXECUTE FUNCTION "economy_parent_code_guard"();
--> statement-breakpoint
CREATE TRIGGER "economy_packs_code_immutable"
  BEFORE UPDATE ON "economy_packs"
  FOR EACH ROW EXECUTE FUNCTION "economy_parent_code_guard"();
