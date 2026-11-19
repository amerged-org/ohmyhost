// W24 U194: the unified organization financial runner. The organization row of migration 183 stays
// the ONE financial claim, lease and fairness record and now serves four typed work families (exact
// cohort tasks, routed lifetime hints of 186, routed provider hints of 192 and quiet-organization
// maintenance of 193) in a fixed ring: cohort -> lifetime -> provider -> maintenance -> cohort. This
// migration adds only what that needs; it creates no table, function, trigger or sequence, prices
// nothing, locks no wallet and does not touch a ledger, hint or due row.
//
// 1. last_family (NOT NULL, closed, initially 'maintenance' so the first family served is cohort).
//    The claim writes it in the same statement as token, epoch, generation and lease, so a failed or
//    abandoned claim also consumes its fairness turn; while claim_token is set it IS the family of
//    that claim, so no second claim_family column exists. Release and handoff never reset it. Every
//    fetch, finalization and deferral compares it besides owner, epoch, token, generation and the
//    lease.
//
// 2. ONE bounded last-successful-completion marker per organization (no per-claim history): the
//    completed claim token, owner epoch, generation and family, the SHA-256 of the typed identity and
//    revision of the selection that claim served, the closed outcome and the time. Only a successful
//    guarded completion writes it (in the same statement as the final lease compare-and-swap, so it
//    is atomic with every ledger and metadata effect of the transaction); an idle or deferral
//    release never does, and a later successful claim overwrites it. A reader that finds its own
//    marker knows its COMMIT happened; an overwritten marker proves nothing and reads as unresolved.
//
// 3. One partial index on the lifetime day hints: due time first, so that the claim's lifetime
//    eligibility is driven from the due rows (the provider hints and the maintenance rows already
//    have such an index, the cohort lookup keeps its measured plan). A sleeping or covered hint is
//    not indexed.
//
// 4. Narrow runtime grants for the family adapters, only for roles that exist (as migrations 183 to
//    193): the new lane columns, the INSERT that enqueueing a task and seeding a routed organization
//    need (migration 188 reset it for metering_runtime), the lifetime hint columns the adapter
//    updates, and SELECT on the source tables the lifetime and provider evaluators and the
//    maintenance plan read that migration 188 does not already grant. No wildcard, no future-table
//    default, no grant option, no function EXECUTE and no owner right. The base inventory of 188
//    (organization-credits reads of the expiry cache, runtime activation and the full feature grant)
//    belongs to the composed runtime and is not adjusted here.

const FAMILIES = ["cohort", "lifetime", "provider", "maintenance"];
const OUTCOMES = ["posted", "replayed", "evaluated", "wait", "rerouted", "maintenance"];

/** @param {readonly string[]} values */
const list = (values) => values.map((value) => `'${value}'`).join(", ");

// The columns this migration adds to organization_metering_work.
const LANE_COLUMNS = [
  "last_family",
  "completed_claim_token",
  "completed_owner_epoch",
  "completed_generation",
  "completed_family",
  "completed_outcome",
  "completed_selection_sha256",
  "completed_at",
];

// The columns of lifetime_day_hints the family adapter updates (identity, hint_id, evaluated_*
// and the resource-level discovery state stay with migration 186's discovery).
const HINT_UPDATE_COLUMNS = [
  "status",
  "revision",
  "routed_organization_id",
  "routed_project_id",
  "routed_billing_epoch_id",
  "available_at",
  "attempts",
  "last_served_at",
  "last_failure_code",
  "covered_valuation_id",
  "covered_at",
];

// Source tables read by the lifetime evaluator (resource-lifetime-usage.ts), the Neon and R2
// candidate evaluators (neon-consumption.ts, r2-consumption.ts) and the maintenance plan that
// migration 188 does not grant metering_runtime. billing_epochs, environments, the ledger tables,
// published_credit_rate_cards, the Stripe and paid-access tables are already in the 188 base policy.
const SOURCE_SELECT_TABLES = [
  "wfp_candidate_receipts",
  "wfp_candidate_cleanup_receipts",
  "product_command_intents",
  "run_cleanup_attempts",
  "run_resource_inventory",
  "paid_project_domains",
  "project_powered_by_flag_periods",
  "usage_meter_activations",
  "neon_consumption_observations",
  "neon_project_placement_receipts",
  "project_database_compute_changes",
  "operations",
  "r2_consumption_observations",
  "projects",
  "project_ownerships",
];

// Every relation the adapters name besides the ledger; all must exist in the migration schema.
const PREREQUISITE_TABLES = [
  "organization_metering_work",
  "metering_cohort_work",
  "lifetime_day_hints",
  "neon_metering_source_hints",
  "r2_metering_source_hints",
  "credit_maintenance_due",
  "credit_maintenance_notices",
  ...SOURCE_SELECT_TABLES,
];

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  // Each pgm.sql is a separate driver query. Arm the lock and statement limits before any DDL, and
  // restore the prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_unified_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_unified_migration_timeouts;
           DROP TABLE pg_temp.w24_unified_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);

  // Everything this migration extends or grants must already exist in the schema it runs in.
  pgm.sql(`DO $prerequisites$
  DECLARE v_name text;
  BEGIN
    FOREACH v_name IN ARRAY ARRAY[${list(PREREQUISITE_TABLES)}] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class relation
        WHERE relation.oid = pg_catalog.to_regclass(pg_catalog.format('%I.%I',
            pg_catalog.current_schema(), v_name))
          AND relation.relkind IN ('r', 'p')
      ) THEN
        RAISE EXCEPTION 'The unified metering families require the W24 tables of 183, 186, 192 and 193';
      END IF;
    END LOOP;
  END $prerequisites$;`);

  pgm.sql(`
    ALTER TABLE organization_metering_work
      ADD COLUMN last_family text NOT NULL DEFAULT 'maintenance',
      ADD COLUMN completed_claim_token ulid,
      ADD COLUMN completed_owner_epoch bigint,
      ADD COLUMN completed_generation bigint,
      ADD COLUMN completed_family text,
      ADD COLUMN completed_outcome text,
      ADD COLUMN completed_selection_sha256 bytea,
      ADD COLUMN completed_at timestamptz,
      ADD CONSTRAINT organization_metering_work_last_family_check
        CHECK (last_family IN (${list(FAMILIES)})),
      -- All or nothing: a marker is complete and bounded, never a partial record. The generation is
      -- the claim's own, so it can never be ahead of the row.
      ADD CONSTRAINT organization_metering_work_completion_shape CHECK (
        (completed_claim_token IS NULL AND completed_owner_epoch IS NULL
          AND completed_generation IS NULL AND completed_family IS NULL
          AND completed_outcome IS NULL AND completed_selection_sha256 IS NULL
          AND completed_at IS NULL)
        OR (completed_claim_token IS NOT NULL AND completed_owner_epoch IS NOT NULL
          AND completed_owner_epoch > 0 AND completed_generation IS NOT NULL
          AND completed_generation > 0 AND completed_generation <= generation
          AND completed_family IS NOT NULL AND completed_family IN (${list(FAMILIES)})
          AND completed_outcome IS NOT NULL AND completed_outcome IN (${list(OUTCOMES)})
          AND completed_selection_sha256 IS NOT NULL
          AND octet_length(completed_selection_sha256) = 32 AND completed_at IS NOT NULL));

    -- Due routed lifetime hints by due time: the claim's lifetime branch is a semijoin driven from
    -- here. Pending is the only status that is ever selected for financial work.
    CREATE INDEX lifetime_day_hints_due_global_idx
      ON lifetime_day_hints (available_at, routed_organization_id)
      WHERE status = 'pending';
  `);

  // Default privileges may already grant a role more than it needs, independently of PUBLIC; this
  // migration only ADDS the listed rights and never touches PUBLIC, other roles or other objects.
  // An absent role is skipped, which means "unprovisioned", never ready.
  pgm.sql(`DO $grants$
  DECLARE role_name text;
  BEGIN
    FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
        EXECUTE pg_catalog.format('GRANT SELECT ON TABLE ${SOURCE_SELECT_TABLES.join(", ")} TO %I',
          role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'metering_runtime') THEN
      -- Enqueueing the exact task of a hint attempt and seeding a rerouted owner insert rows (188
      -- reset the INSERT 183 had granted). The new lane columns are written column by column, like
      -- the other lane columns of 188; control_runtime's table-level rights already cover them.
      EXECUTE 'GRANT INSERT ON TABLE organization_metering_work, metering_cohort_work TO metering_runtime';
      EXECUTE 'GRANT UPDATE (${LANE_COLUMNS.join(", ")}) ON TABLE organization_metering_work TO metering_runtime';
      -- 188 reset the lifetime hint table as unused: the adapter reads it and updates only the
      -- columns of its own finalization and deferral.
      EXECUTE 'GRANT SELECT ON TABLE lifetime_day_hints TO metering_runtime';
      EXECUTE 'GRANT UPDATE (${HINT_UPDATE_COLUMNS.join(", ")}) ON TABLE lifetime_day_hints TO metering_runtime';
    END IF;
  END $grants$;`);

  restoreBounds(pgm);
}

/**
 * Everything here is derived scheduling metadata: the fairness position and the last-completion
 * marker are rebuilt by the next claims, and no financial fact lives in them. The downgrade drops
 * the columns, the constraints and the index, and takes back the metering_runtime grants this
 * migration added, in the state migration 188 left them (a SELECT that control_runtime holds on a
 * source table may predate this migration and stays); ledger, hint and due rows are untouched.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
export function down(pgm) {
  boundDdl(pgm);
  pgm.sql(`DO $revoke$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'metering_runtime') THEN
      EXECUTE 'REVOKE ALL ON TABLE lifetime_day_hints FROM metering_runtime';
      EXECUTE 'REVOKE INSERT ON TABLE organization_metering_work, metering_cohort_work FROM metering_runtime';
      EXECUTE 'REVOKE UPDATE (${LANE_COLUMNS.join(", ")}) ON TABLE organization_metering_work FROM metering_runtime';
      EXECUTE 'REVOKE SELECT ON TABLE ${SOURCE_SELECT_TABLES.join(", ")} FROM metering_runtime';
    END IF;
  END $revoke$;`);
  pgm.sql(`
    DROP INDEX lifetime_day_hints_due_global_idx;
    ALTER TABLE organization_metering_work
      DROP CONSTRAINT organization_metering_work_completion_shape,
      DROP CONSTRAINT organization_metering_work_last_family_check,
      ${LANE_COLUMNS.map((column) => `DROP COLUMN ${column}`).join(",\n      ")};
  `);
  restoreBounds(pgm);
}
