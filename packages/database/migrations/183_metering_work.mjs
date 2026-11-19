// W24 F04a: durable organization settlement work. One financial lane across every source: a
// singleton owner row (which engine may claim and finalize), one work row per organization (the
// claim, lease and fairness state) and one immutable cohort measurement per source observation. The
// tables are new and unused by released binaries; nothing here computes a price or touches a ledger,
// wallet or evidence table. Lock modes are chosen so independent foreign-key inserts (enqueue) never
// wait for a claim or a financial transaction: organization rows are locked FOR NO KEY UPDATE.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  // Each pgm.sql is a separate driver query. Arm the statement limit before executing DDL (creating
  // the foreign keys briefly locks the referenced ledger tables), and restore prior settings
  // because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_metering_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';");
  pgm.sql(`
    CREATE TABLE metering_lane_owner (
      lane text PRIMARY KEY CHECK (lane = 'financial'),
      owner text NOT NULL CHECK (owner IN ('control','metering')),
      epoch bigint NOT NULL CHECK (epoch > 0)
    );
    -- Control owns the lane until an operator hands it over; no environment variable is authority.
    INSERT INTO metering_lane_owner(lane, owner, epoch) VALUES ('financial', 'control', 1);

    -- Runtime roles receive UPDATE only because PostgreSQL requires it for SELECT ... FOR SHARE.
    -- This guard (invoker rights, fixed search_path, no caller-set setting as authority) rejects
    -- every actual row update unless the session user is the table owner. A row-lock SELECT does
    -- not fire it, and an UPDATE that matches no row never reaches it.
    CREATE FUNCTION reject_metering_lane_owner_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation.relowner
        WHERE relation.oid = TG_RELID AND owner_role.rolname = current_user
      ) THEN
        RAISE EXCEPTION 'Only the schema owner may change metering lane ownership'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER metering_lane_owner_operator_only BEFORE UPDATE ON metering_lane_owner
      FOR EACH ROW EXECUTE FUNCTION reject_metering_lane_owner_update();
    ALTER TABLE metering_lane_owner ENABLE ALWAYS TRIGGER metering_lane_owner_operator_only;

    -- Claim state of one organization across all sources. The generation persists when a claim is
    -- released and grows with every new claim; last_served_at is set at claim time so a hot
    -- organization rotates behind waiting ones, also after an abandoned claim.
    CREATE TABLE organization_metering_work (
      organization_id ulid PRIMARY KEY REFERENCES workos_organization_mappings(organization_id),
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      last_served_at timestamptz,
      claim_owner text CHECK (claim_owner IN ('control','metering')),
      claim_token ulid,
      claim_epoch bigint CHECK (claim_epoch > 0),
      claimed_at timestamptz,
      lease_until timestamptz,
      CONSTRAINT organization_metering_work_claim_shape CHECK (
        (claim_owner IS NULL AND claim_token IS NULL AND claim_epoch IS NULL
          AND claimed_at IS NULL AND lease_until IS NULL)
        OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL
          AND claimed_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until > claimed_at
          AND generation > 0))
    );
    CREATE INDEX organization_metering_work_served_idx
      ON organization_metering_work (last_served_at NULLS FIRST, organization_id);

    -- One exact, already-discovered measurement per source observation. The labels are what
    -- postMeasuredUsage accepts and the ledger can store, so a task that could never post is
    -- refused at enqueue. Nothing is archived, expired or parked here.
    CREATE TABLE metering_cohort_work (
      work_id ulid PRIMARY KEY,
      source_kind text NOT NULL CHECK (source_kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
      source_reference text NOT NULL
        CHECK (source_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$'),
      observation_reference text NOT NULL
        CHECK (observation_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$'),
      organization_id ulid NOT NULL REFERENCES organization_metering_work(organization_id),
      project_id ulid NOT NULL,
      environment_id ulid,
      billing_epoch_id ulid NOT NULL,
      meter text NOT NULL CHECK (meter ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
      unit text NOT NULL CHECK (unit ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$'),
      quantity bigint NOT NULL CHECK (quantity >= 0),
      event_time timestamptz NOT NULL,
      observed_at timestamptz NOT NULL,
      available_at timestamptz NOT NULL,
      attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_failure_stage text CHECK (last_failure_stage IN ('discovery','posting','finalize')),
      last_failure_code text CHECK (last_failure_code IN (
        'lock_not_available','statement_canceled','idle_in_transaction_timeout',
        'transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection',
        'invalid_measurement','measurement_conflict','unknown')),
      completed_at timestamptz,
      completed_valuation_id ulid REFERENCES usage_credit_valuations(valuation_id),
      CONSTRAINT metering_cohort_work_identity_key
        UNIQUE (source_kind, source_reference, observation_reference),
      CONSTRAINT metering_cohort_work_chronology CHECK (event_time <= observed_at),
      CONSTRAINT metering_cohort_work_failure_shape
        CHECK ((last_failure_stage IS NULL) = (last_failure_code IS NULL)),
      CONSTRAINT metering_cohort_work_completion_shape
        CHECK ((completed_at IS NULL) = (completed_valuation_id IS NULL)),
      CONSTRAINT metering_cohort_work_environment_fk FOREIGN KEY (organization_id, project_id, environment_id)
        REFERENCES environments(organization_id, project_id, environment_id),
      CONSTRAINT metering_cohort_work_billing_epoch_fk FOREIGN KEY (billing_epoch_id, project_id, organization_id)
        REFERENCES billing_epochs(billing_epoch_id, project_id, organization_id)
    );
    -- Due-work lookup and fetch order for one organization; completed history is not indexed.
    CREATE INDEX metering_cohort_work_pending_idx
      ON metering_cohort_work (organization_id, available_at, event_time, work_id)
      WHERE completed_at IS NULL;

    -- Identity and measurement never change; scheduling fields stay mutable until completion,
    -- which is terminal. This is deliberately not an append-only table.
    CREATE FUNCTION guard_metering_cohort_work_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF OLD.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Completed metering work is terminal' USING ERRCODE = '55000';
      END IF;
      IF NEW.work_id IS DISTINCT FROM OLD.work_id
        OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
        OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
        OR NEW.observation_reference IS DISTINCT FROM OLD.observation_reference
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
        OR NEW.billing_epoch_id IS DISTINCT FROM OLD.billing_epoch_id
        OR NEW.meter IS DISTINCT FROM OLD.meter
        OR NEW.unit IS DISTINCT FROM OLD.unit
        OR NEW.quantity IS DISTINCT FROM OLD.quantity
        OR NEW.event_time IS DISTINCT FROM OLD.event_time
        OR NEW.observed_at IS DISTINCT FROM OLD.observed_at THEN
        RAISE EXCEPTION 'Metering work identity and measurement are immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER metering_cohort_work_guard BEFORE UPDATE ON metering_cohort_work
      FOR EACH ROW EXECUTE FUNCTION guard_metering_cohort_work_update();

    -- Default privileges may already grant a runtime role more than it needs: start from nothing.
    -- The owner table is writable by nobody but its owner (see the guard); UPDATE exists only for
    -- row locks. Work rows are never deleted or truncated, and no role receives DDL or ledger rights.
    DO $grant$
    DECLARE role_name text;
    BEGIN
      FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
          EXECUTE format(
            'REVOKE ALL ON metering_lane_owner, organization_metering_work, metering_cohort_work FROM %I',
            role_name);
          EXECUTE format('GRANT SELECT, UPDATE ON metering_lane_owner TO %I', role_name);
          EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE ON organization_metering_work, metering_cohort_work TO %I',
            role_name);
        END IF;
      END LOOP;
    END $grant$;
  `);
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_metering_migration_timeouts;
           DROP TABLE pg_temp.w24_metering_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM organization_metering_work)
        OR EXISTS (SELECT 1 FROM metering_cohort_work)
        OR (SELECT count(*) FROM metering_lane_owner) <> 1
        OR NOT EXISTS (SELECT 1 FROM metering_lane_owner
          WHERE lane = 'financial' AND owner = 'control' AND epoch = 1) THEN
        RAISE EXCEPTION 'Metering work and lane ownership must be retained before downgrade';
      END IF;
    END $$;
    DROP TABLE metering_cohort_work;
    DROP TABLE organization_metering_work;
    DROP TABLE metering_lane_owner;
    DROP FUNCTION guard_metering_cohort_work_update();
    DROP FUNCTION reject_metering_lane_owner_update();
  `);
}
