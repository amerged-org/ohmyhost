// W24 D1: durable discovery of WFP usage batches. Every batch gets one nonfinancial discovery row
// (state, schedule, short claim) that an AFTER INSERT trigger creates in the transaction that
// inserts the batch, so unchanged ingestion binaries are covered and a hint is never visible before
// its events commit. One named bootstrap job covers the batches that existed before the trigger.
// Nothing here prices, posts, locks a wallet or touches a ledger: discovery only materializes exact
// metering work (migration 183) and records what it found.
//
// Why a source-key cursor is a complete bootstrap: LOCK TABLE ... SHARE ROW EXCLUSIVE on the batch
// table waits out every writer that already inserted a batch, and blocks new ones until this
// transaction commits. A row is therefore either committed before the trigger exists (the bootstrap
// scans it, by primary key, whatever the commit order was) or inserted after it (the trigger covers
// it, whatever its key is). A committed sequence or commit-order watermark would prove neither.
//
// The index on wfp_usage_events(dispatch_namespace, first_batch_sha256) is the prerequisite of every
// exact-batch query. It is built under the same bounded lock and statement budget as the
// rest: a table too large for it fails this migration cleanly and rolls everything back, never half
// of it. The existing candidate identity key (dispatch_namespace, immutable_script_name, tag) already
// serves the script lookup, so no script index is added.
//
// One complete attribution snapshot freezes the measurement plan of a batch. The header columns
// plan_* of the discovery row and the rows of wfp_discovery_cohort_plan are written by ONE SQL
// statement from one snapshot, or not at all; the measurements, their root and their counts are
// immutable from then on and only plan_covered_count grows, by one bounded page at a time, while
// covered rows are removed. The plan is a set of exact measurements and their canonical source
// hashes, never a price: the hash card is audit metadata, and postMeasuredUsage still chooses the
// applicable meter price at its first post. A batch is complete only when every plan row is covered
// by a canonical metering task or an already posted legacy receipt with the same facts.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // Each pgm.sql is a separate driver query. Arm the limits before any lock is requested, and
  // restore the prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_discovery_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';");
  pgm.sql(`
    -- Pre-trigger writers finish first; later ones wait for the commit. Failing here (55P03) leaves
    -- nothing installed.
    LOCK TABLE wfp_usage_batches IN SHARE ROW EXCLUSIVE MODE;

    -- One row per batch. A pending row is due at next_attempt_at; completion is terminal and only
    -- follows an explicit classification of every event the batch owns. There is no attempt limit
    -- and no parked state: a batch that cannot be resolved stays pending behind a capped backoff.
    -- claim_* is a short NONFINANCIAL claim on this row; it never owns a wallet.
    CREATE TABLE wfp_batch_discovery (
      dispatch_namespace text NOT NULL,
      batch_sha256 bytea NOT NULL,
      discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      last_served_at timestamptz,
      claim_owner text CHECK (claim_owner IN ('control','metering')),
      claim_token ulid,
      claim_epoch bigint CHECK (claim_epoch > 0),
      claimed_at timestamptz,
      lease_until timestamptz,
      last_failure_stage text CHECK (last_failure_stage IN ('discovery','classification')),
      last_failure_code text CHECK (last_failure_code IN (
        'lock_not_available','statement_canceled','idle_in_transaction_timeout',
        'transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection',
        'invalid_measurement','measurement_conflict','attribution_unresolved','rate_unresolved',
        'unknown')),
      completed_at timestamptz,
      -- The frozen measurement plan: all NULL until the single freeze statement sets them together.
      -- plan_root is an internal integrity digest over the ordered measurement facts, not a
      -- financial source hash. plan_covered_count is the only field that changes afterwards.
      plan_version smallint CHECK (plan_version = 1),
      plan_frozen_at timestamptz,
      plan_business_as_of timestamptz,
      plan_root bytea CHECK (octet_length(plan_root) = 32),
      plan_owned_events integer CHECK (plan_owned_events BETWEEN 0 AND 5000),
      plan_excluded_events integer CHECK (plan_excluded_events BETWEEN 0 AND 5000),
      plan_cohort_count integer CHECK (plan_cohort_count BETWEEN 0 AND 10000),
      plan_covered_count integer NOT NULL DEFAULT 0 CHECK (plan_covered_count >= 0),
      CONSTRAINT wfp_batch_discovery_pkey PRIMARY KEY (dispatch_namespace, batch_sha256),
      CONSTRAINT wfp_batch_discovery_batch_fkey FOREIGN KEY (dispatch_namespace, batch_sha256)
        REFERENCES wfp_usage_batches(dispatch_namespace, batch_sha256),
      CONSTRAINT wfp_batch_discovery_claim_shape CHECK (
        (claim_owner IS NULL AND claim_token IS NULL AND claim_epoch IS NULL
          AND claimed_at IS NULL AND lease_until IS NULL)
        OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL
          AND claimed_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until > claimed_at
          AND generation > 0 AND completed_at IS NULL)),
      CONSTRAINT wfp_batch_discovery_failure_shape
        CHECK ((last_failure_stage IS NULL) = (last_failure_code IS NULL)),
      CONSTRAINT wfp_batch_discovery_plan_shape CHECK (
        (plan_version IS NULL AND plan_frozen_at IS NULL AND plan_business_as_of IS NULL
          AND plan_root IS NULL AND plan_owned_events IS NULL AND plan_excluded_events IS NULL
          AND plan_cohort_count IS NULL AND plan_covered_count = 0)
        OR (plan_version IS NOT NULL AND plan_frozen_at IS NOT NULL
          AND plan_business_as_of IS NOT NULL AND plan_root IS NOT NULL
          AND plan_owned_events IS NOT NULL AND plan_excluded_events IS NOT NULL
          AND plan_cohort_count IS NOT NULL AND plan_excluded_events <= plan_owned_events
          AND plan_cohort_count <= 2 * plan_owned_events
          AND plan_covered_count <= plan_cohort_count)),
      -- A completed batch has a plan and every cohort of it is covered: no empty result completes.
      CONSTRAINT wfp_batch_discovery_completion_shape CHECK (
        completed_at IS NULL
        OR (plan_frozen_at IS NOT NULL AND plan_covered_count = plan_cohort_count))
    );
    -- Due work in fair order: oldest due first, a claimed, deferred or re-queued row sorts behind
    -- every row that has waited longer. Completed rows are not indexed.
    CREATE INDEX wfp_batch_discovery_due_idx
      ON wfp_batch_discovery (next_attempt_at, dispatch_namespace, batch_sha256)
      WHERE completed_at IS NULL;

    -- The frozen measurements of a batch, one row per positive-quantity cohort: exactly the facts
    -- of a metering task plus the global hash card the legacy source hash was built with (audit
    -- metadata, NOT a price instruction). Rows are inserted once, by the freeze statement, never
    -- changed, and removed only after a canonical metering task or a posted legacy receipt with
    -- the same facts covers them. The primary key is the paging and lookup index. No wallet, no
    -- organization lane and no source-history foreign key.
    CREATE TABLE wfp_discovery_cohort_plan (
      dispatch_namespace text NOT NULL,
      batch_sha256 bytea NOT NULL,
      source_reference text NOT NULL CHECK (source_reference ~ '^[0-9a-f]{64}$'),
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      environment_id ulid,
      billing_epoch_id ulid NOT NULL,
      meter text NOT NULL CHECK (meter ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
      unit text NOT NULL CHECK (unit ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$'),
      quantity bigint NOT NULL CHECK (quantity > 0),
      event_time timestamptz NOT NULL,
      observed_at timestamptz NOT NULL,
      rate_card_id text NOT NULL CHECK (length(rate_card_id) BETWEEN 1 AND 128),
      CONSTRAINT wfp_discovery_cohort_plan_pkey
        PRIMARY KEY (dispatch_namespace, batch_sha256, source_reference),
      CONSTRAINT wfp_discovery_cohort_plan_batch_fkey FOREIGN KEY (dispatch_namespace, batch_sha256)
        REFERENCES wfp_batch_discovery(dispatch_namespace, batch_sha256),
      CONSTRAINT wfp_discovery_cohort_plan_chronology CHECK (event_time <= observed_at)
    );

    -- Named bootstrap jobs. A page is ONE transaction under this row's lock, so a crashed page
    -- leaves no state and needs no lease; the cursor is the last source key scanned.
    CREATE TABLE metering_discovery_backfills (
      backfill_name text PRIMARY KEY CHECK (backfill_name = 'wfp-batches'),
      cursor_dispatch_namespace text,
      cursor_batch_sha256 bytea CHECK (octet_length(cursor_batch_sha256) = 32),
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      scanned_batches bigint NOT NULL DEFAULT 0 CHECK (scanned_batches >= 0),
      last_served_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT metering_discovery_backfills_cursor_shape
        CHECK ((cursor_dispatch_namespace IS NULL) = (cursor_batch_sha256 IS NULL))
    );
    INSERT INTO metering_discovery_backfills(backfill_name) VALUES ('wfp-batches');

    -- Source identity and completion never change; scheduling fields stay mutable until
    -- completion, which is terminal. Once the plan is frozen its identity, root and counts are
    -- immutable, it cannot be unfrozen or replaced, and its coverage only grows, by at most one
    -- 256-row page per update. Invoker rights and a fixed search_path.
    CREATE FUNCTION guard_wfp_batch_discovery_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF OLD.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Completed WFP batch discovery is terminal' USING ERRCODE = '55000';
      END IF;
      IF NEW.dispatch_namespace IS DISTINCT FROM OLD.dispatch_namespace
        OR NEW.batch_sha256 IS DISTINCT FROM OLD.batch_sha256
        OR NEW.discovered_at IS DISTINCT FROM OLD.discovered_at THEN
        RAISE EXCEPTION 'WFP batch discovery identity is immutable' USING ERRCODE = '55000';
      END IF;
      IF OLD.plan_frozen_at IS NOT NULL AND (
        NEW.plan_version IS DISTINCT FROM OLD.plan_version
        OR NEW.plan_frozen_at IS DISTINCT FROM OLD.plan_frozen_at
        OR NEW.plan_business_as_of IS DISTINCT FROM OLD.plan_business_as_of
        OR NEW.plan_root IS DISTINCT FROM OLD.plan_root
        OR NEW.plan_owned_events IS DISTINCT FROM OLD.plan_owned_events
        OR NEW.plan_excluded_events IS DISTINCT FROM OLD.plan_excluded_events
        OR NEW.plan_cohort_count IS DISTINCT FROM OLD.plan_cohort_count) THEN
        RAISE EXCEPTION 'The frozen WFP discovery plan is immutable' USING ERRCODE = '55000';
      END IF;
      IF NEW.plan_covered_count < OLD.plan_covered_count
        OR NEW.plan_covered_count - OLD.plan_covered_count > 256
        OR (OLD.plan_frozen_at IS NULL AND NEW.plan_covered_count <> 0) THEN
        RAISE EXCEPTION 'WFP discovery plan coverage grows by one bounded page' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER wfp_batch_discovery_guard BEFORE UPDATE ON wfp_batch_discovery
      FOR EACH ROW EXECUTE FUNCTION guard_wfp_batch_discovery_update();

    CREATE FUNCTION reject_wfp_discovery_cohort_plan_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      RAISE EXCEPTION 'WFP discovery cohort plan rows are immutable' USING ERRCODE = '55000';
    END;
    $$;
    CREATE TRIGGER wfp_discovery_cohort_plan_immutable BEFORE UPDATE ON wfp_discovery_cohort_plan
      FOR EACH ROW EXECUTE FUNCTION reject_wfp_discovery_cohort_plan_update();

    CREATE FUNCTION guard_metering_discovery_backfill_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF OLD.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'A completed discovery bootstrap is terminal' USING ERRCODE = '55000';
      END IF;
      IF NEW.backfill_name IS DISTINCT FROM OLD.backfill_name THEN
        RAISE EXCEPTION 'Discovery bootstrap identity is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER metering_discovery_backfills_guard BEFORE UPDATE ON metering_discovery_backfills
      FOR EACH ROW EXECUTE FUNCTION guard_metering_discovery_backfill_update();

    -- Old ingestion roles need only their original source-table privileges. Bind the definer's
    -- source and target to the actual schema NOW, never to a caller path or trigger argument.
    -- A qualified regclass literal survives dump/restore, unlike an embedded numeric source OID.
    DO $install$
    DECLARE source_schema text; source_namespace oid;
    BEGIN
      SELECT namespace.nspname, relation.relnamespace
        INTO STRICT source_schema, source_namespace
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'wfp_usage_batches'::pg_catalog.regclass;
      IF source_namespace IS DISTINCT FROM (
        SELECT relnamespace FROM pg_catalog.pg_class
        WHERE oid = 'wfp_batch_discovery'::pg_catalog.regclass
      ) THEN
        RAISE EXCEPTION 'WFP discovery must live in the source batch schema';
      END IF;
      EXECUTE pg_catalog.format($definition$
        CREATE FUNCTION %1$I.enqueue_wfp_batch_discovery() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
        BEGIN
          IF TG_RELID IS DISTINCT FROM %2$L::pg_catalog.regclass
            OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
            RAISE EXCEPTION 'Invalid WFP discovery trigger source' USING ERRCODE = '55000';
          END IF;
          INSERT INTO %1$I.wfp_batch_discovery(dispatch_namespace, batch_sha256)
            VALUES(NEW.dispatch_namespace, NEW.batch_sha256) ON CONFLICT DO NOTHING;
          RETURN NULL;
        END;
        $body$;
      $definition$, source_schema, pg_catalog.format('%I.wfp_usage_batches', source_schema));
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %I.enqueue_wfp_batch_discovery() FROM PUBLIC', source_schema);
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER wfp_usage_batches_discovery AFTER INSERT ON %1$I.wfp_usage_batches
         FOR EACH ROW EXECUTE FUNCTION %1$I.enqueue_wfp_batch_discovery()', source_schema);
      -- A restore or replication session must not skip it either.
      EXECUTE pg_catalog.format(
        'ALTER TABLE %I.wfp_usage_batches ENABLE ALWAYS TRIGGER wfp_usage_batches_discovery',
        source_schema);
    END $install$;

    -- Exact-batch lookups: the events a batch first owns, by index.
    CREATE INDEX wfp_usage_events_first_batch_idx
      ON wfp_usage_events (dispatch_namespace, first_batch_sha256);

    -- Default privileges may already grant a runtime role more than it needs: start from nothing.
    -- No TRUNCATE or DDL. UPDATE also serves row locks. The backfill row is seeded above. Only the
    -- plan table is ever deleted from (bounded cleanup of covered rows) and never updated.
    DO $grant$
    DECLARE role_name text;
    BEGIN
      FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
          EXECUTE format(
            'REVOKE ALL ON FUNCTION enqueue_wfp_batch_discovery() FROM %I', role_name);
          EXECUTE format(
            'REVOKE ALL ON wfp_batch_discovery, metering_discovery_backfills, wfp_discovery_cohort_plan FROM %I',
            role_name);
          EXECUTE format('GRANT SELECT, INSERT, UPDATE ON wfp_batch_discovery TO %I', role_name);
          EXECUTE format('GRANT SELECT, UPDATE ON metering_discovery_backfills TO %I', role_name);
          EXECUTE format(
            'GRANT SELECT, INSERT, DELETE ON wfp_discovery_cohort_plan TO %I', role_name);
        END IF;
      END LOOP;
    END $grant$;
  `);
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_discovery_migration_timeouts;
           DROP TABLE pg_temp.w24_discovery_migration_timeouts;`);
}

/**
 * Discovery rows are derived scheduling state: the bootstrap and the trigger rebuild them, and no
 * financial fact lives here, so the downgrade drops them without a retention guard.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
export function down(pgm) {
  pgm.sql(`
    DROP TRIGGER wfp_usage_batches_discovery ON wfp_usage_batches;
    DROP FUNCTION enqueue_wfp_batch_discovery();
    DROP INDEX wfp_usage_events_first_batch_idx;
    DROP TABLE metering_discovery_backfills;
    DROP TABLE wfp_discovery_cohort_plan;
    DROP TABLE wfp_batch_discovery;
    DROP FUNCTION guard_metering_discovery_backfill_update();
    DROP FUNCTION reject_wfp_discovery_cohort_plan_update();
    DROP FUNCTION guard_wfp_batch_discovery_update();
  `);
}
