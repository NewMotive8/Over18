-- Wallets and the append-only ledger (PRD v1.2 sections 18, 19.2, 30.1, 34.2) -- P2.1.
--
-- A custom migration, generated with `drizzle-kit generate --custom`: drizzle
-- cannot express triggers. 0033 defines what each ROW must contain (CHECK
-- constraints, foreign keys, unique indexes); this defines how rows may come
-- into being and change, which a CHECK cannot see.
--
--   1. `credits` is the initial wallet currency.
--   2. A wallet is created empty. No statement may update a wallet: its
--      balance, held Credits and version change only when a transaction is
--      appended to its ledger. There is no direct write to a balance, for
--      anyone, ever (30.1, 34.2).
--   3. wallet_transactions is append-only: UPDATE and DELETE are refused. A
--      correction is a new, compensating transaction.
--   4. Appending a transaction locks its wallet (so writes to one wallet are
--      serialised and a balance cannot be overspent by a race), checks the
--      movement and stamps the wallet's next `sequence`, the resulting
--      `balance_after` / `held_after` and `created_at`. The previous state is
--      read from the ledger itself, so the ledger is the record and the wallet
--      its cache (19.2). An AFTER trigger then writes the cache -- AFTER, so
--      an `INSERT ... ON CONFLICT DO NOTHING` replay of an idempotency key
--      that inserts nothing also moves nothing.
--   5. A hold moves Credits from the spendable balance to held; a capture
--      consumes held Credits; a release returns them. Neither the balance nor
--      held may go below zero.
--   6. A capture or release names a hold in the same wallet and Credit class,
--      and all of a hold's captures and releases together may not exceed it.
--      A refund names a paid action or capture in the same wallet; a reversal
--      names any transaction but a hold or release, in the same wallet, and
--      runs opposite to it. The refunds and reversals of one transaction
--      together may not exceed it.
--
-- TRUNCATE is unaffected (statement-level), which the test harness relies on.
-- Error codes: insufficient_privilege for a forbidden operation (as 0026),
-- check_violation for invalid data (as 0027/0028).

INSERT INTO "wallet_currencies" ("code") VALUES ('credits') ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "wallets_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."balance" <> 0 OR NEW."held" <> 0 OR NEW."version" <> 0 THEN
      RAISE EXCEPTION 'wallets: a wallet is created empty; Credits arrive only through wallet_transactions'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. The only writer is wallet_transactions_apply, one trigger level
  -- down; a statement issued directly runs at depth 1.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'wallets: a balance is never written directly; append a wallet_transactions row'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."user_id" <> OLD."user_id" OR NEW."currency" <> OLD."currency"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'wallets: a wallet''s owner, currency and identity never change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "wallets_guard"
  BEFORE INSERT OR UPDATE ON "wallets"
  FOR EACH ROW EXECUTE FUNCTION "wallets_guard"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "wallet_transactions_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_transactions is append-only: % is not permitted; record a compensating transaction instead', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "wallet_transactions_append_only"
  BEFORE UPDATE OR DELETE ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION "wallet_transactions_reject_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "wallet_transactions_stamp"() RETURNS trigger AS $$
DECLARE
  prior record;
  prior_sequence integer := 0;
  prior_balance bigint := 0;
  prior_held bigint := 0;
  related record;
  settled bigint;
  next_balance bigint;
  next_held bigint;
BEGIN
  -- Serialise every write to this wallet. A concurrent writer waits here and
  -- then reads the state this one leaves behind.
  PERFORM 1 FROM "wallets"
    WHERE "user_id" = NEW."user_id" AND "currency" = NEW."currency"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet_transactions: user % has no % wallet', NEW."user_id", NEW."currency"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The previous state, from the ledger itself. Earlier rows of the same
  -- statement are visible here, so a multi-row insert chains correctly.
  SELECT "sequence", "balance_after", "held_after" INTO prior
    FROM "wallet_transactions"
    WHERE "user_id" = NEW."user_id" AND "currency" = NEW."currency"
    ORDER BY "sequence" DESC
    LIMIT 1;
  IF FOUND THEN
    prior_sequence := prior."sequence";
    prior_balance := prior."balance_after";
    prior_held := prior."held_after";
  END IF;

  -- Only the four settling and compensating types name another transaction;
  -- any other type that names one is refused by 0033's CHECK.
  IF NEW."related_transaction_id" IS NOT NULL AND NEW."entry_type" IN ('capture', 'release', 'refund', 'reversal') THEN
    SELECT * INTO related FROM "wallet_transactions" WHERE "id" = NEW."related_transaction_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wallet_transactions: related transaction % does not exist', NEW."related_transaction_id"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF related."user_id" <> NEW."user_id" OR related."currency" <> NEW."currency" THEN
      RAISE EXCEPTION 'wallet_transactions: a % must name a transaction in the same wallet', NEW."entry_type"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."entry_type" IN ('capture', 'release') THEN
      IF related."entry_type" <> 'hold' THEN
        RAISE EXCEPTION 'wallet_transactions: a % settles a hold, not a %', NEW."entry_type", related."entry_type"
          USING ERRCODE = 'check_violation';
      END IF;
      IF related."credit_class" <> NEW."credit_class" THEN
        RAISE EXCEPTION 'wallet_transactions: a % settles the % Credits its hold reserved, not %',
          NEW."entry_type", related."credit_class", NEW."credit_class" USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum("amount"), 0) INTO settled FROM "wallet_transactions"
        WHERE "related_transaction_id" = related."id" AND "entry_type" IN ('capture', 'release');
      IF settled + NEW."amount" > related."amount" THEN
        RAISE EXCEPTION 'wallet_transactions: would settle % of a hold of % (already settled %)',
          settled + NEW."amount", related."amount", settled USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW."entry_type" = 'refund' AND related."entry_type" NOT IN ('paid_action', 'capture') THEN
        RAISE EXCEPTION 'wallet_transactions: a refund returns Credits charged by a paid action or a capture, not a %',
          related."entry_type" USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."entry_type" = 'reversal' AND related."entry_type" IN ('hold', 'release') THEN
        RAISE EXCEPTION 'wallet_transactions: a % is settled by a capture or release, not reversed', related."entry_type"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."direction" = related."direction" THEN
        RAISE EXCEPTION 'wallet_transactions: a % runs opposite to the % it compensates', NEW."entry_type", related."direction"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum("amount"), 0) INTO settled FROM "wallet_transactions"
        WHERE "related_transaction_id" = related."id" AND "entry_type" IN ('refund', 'reversal');
      IF settled + NEW."amount" > related."amount" THEN
        RAISE EXCEPTION 'wallet_transactions: would compensate % of a transaction of % (already compensated %)',
          settled + NEW."amount", related."amount", settled USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."entry_type" = 'hold' THEN
    next_balance := prior_balance - NEW."amount";
    next_held := prior_held + NEW."amount";
  ELSIF NEW."entry_type" = 'capture' THEN
    next_balance := prior_balance;
    next_held := prior_held - NEW."amount";
  ELSIF NEW."entry_type" = 'release' THEN
    next_balance := prior_balance + NEW."amount";
    next_held := prior_held - NEW."amount";
  ELSIF NEW."direction" = 'credit' THEN
    next_balance := prior_balance + NEW."amount";
    next_held := prior_held;
  ELSE
    next_balance := prior_balance - NEW."amount";
    next_held := prior_held;
  END IF;

  IF next_balance < 0 OR next_held < 0 THEN
    RAISE EXCEPTION 'wallet_transactions: a % of % would take the % wallet below zero (balance %, held %)',
      NEW."entry_type", NEW."amount", NEW."currency", prior_balance, prior_held USING ERRCODE = 'check_violation';
  END IF;

  NEW."sequence" := prior_sequence + 1;
  NEW."balance_after" := next_balance;
  NEW."held_after" := next_held;
  NEW."created_at" := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "wallet_transactions_stamp"
  BEFORE INSERT ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION "wallet_transactions_stamp"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "wallet_transactions_apply"() RETURNS trigger AS $$
BEGIN
  UPDATE "wallets"
    SET "balance" = NEW."balance_after",
        "held" = NEW."held_after",
        "version" = NEW."sequence",
        "updated_at" = now()
    WHERE "user_id" = NEW."user_id" AND "currency" = NEW."currency" AND "version" = NEW."sequence" - 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet_transactions: the % wallet of user % is not at version %; its cache is out of step with its ledger',
      NEW."currency", NEW."user_id", NEW."sequence" - 1 USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "wallet_transactions_apply"
  AFTER INSERT ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION "wallet_transactions_apply"();
