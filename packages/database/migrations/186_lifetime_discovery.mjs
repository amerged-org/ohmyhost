// W24 D3a: incremental, resource-first discovery of lifetime usage (wfp.script and
// domain.custom_hostname). Five new tables hold NONFINANCIAL scheduling metadata only; no quantity,
// price, wallet or ledger fact is stored here and nothing in this migration backfills a day.
//
//  - lifetime_dirty_notices: one cheap, typed, immutable-identity row per input change, appended by
//    SECURITY DEFINER AFTER triggers on the nine source tables. A trigger names the changed source and
//    never reads history, takes a financial lock or touches another derived row, so a legacy
//    ingestion or provider role needs no privilege on any table below.
//  - lifetime_resource_sources: derived routing index, one record per physical source identity, so a
//    cleanup, refresh, flag or epoch notice finds its logical resources by index and never rescans a
//    project's history. It is never evidence: the canonical query reads the authoritative tables.
//  - lifetime_resource_work: one row per logical resource (source_kind, resource_reference) with the
//    forward-progress cursor, a separate dirty range, a revision and a short NONFINANCIAL claim.
//  - lifetime_day_hints: one row per resource/UTC day with a stable hint_id, routing hints and
//    status. Never a quantity, a price or a frozen measurement.
//  - lifetime_discovery_bootstrap: two fixed jobs with typed keyset cursors over the immutable
//    candidate receipts and the paid-domain primary key.
//
// Why the cursors make the bootstrap complete (same argument as migration 184): LOCK TABLE ... SHARE
// ROW EXCLUSIVE waits out every writer that already changed a source table and blocks new ones until
// this transaction commits. A row is therefore either committed before the triggers exist (the
// bootstrap scans it by key, whatever the commit order was) or written after they exist (the trigger
// covers it, whatever its key is). Mutable domain rows are covered by the same two halves.
//
// Five indexes on existing tables bound the exact per-resource lookups (candidate receipts by script
// name, wfp removal attempts by project/hash, paid domains by hostname, billing epochs by project and
// start, deployment intents by operation): they are built under the same lock and statement budget,
// so a table too large for one fails this migration cleanly and rolls everything back, never half of
// it. Each blocks writers of its table for the duration of its build.

const SOURCE_TABLES = [
  "billing_epochs",
  "paid_project_domains",
  "product_command_intents",
  "project_powered_by_flag_periods",
  "run_cleanup_attempts",
  "run_resource_inventory",
  "usage_meter_activations",
  "wfp_candidate_cleanup_receipts",
  "wfp_candidate_receipts",
];

// [trigger name, table, timing/event clause, optional WHEN condition]
const TRIGGERS = [
  ["wfp_candidate_receipts_lifetime_notice", "wfp_candidate_receipts", "AFTER INSERT", null],
  [
    "wfp_candidate_cleanup_receipts_lifetime_notice",
    "wfp_candidate_cleanup_receipts",
    "AFTER INSERT",
    null,
  ],
  [
    "run_cleanup_attempts_lifetime_notice",
    "run_cleanup_attempts",
    "AFTER INSERT",
    "NEW.resource_kind = 'wfp-script' AND NEW.outcome IN ('removed', 'not_found')",
  ],
  [
    "run_resource_inventory_lifetime_notice",
    "run_resource_inventory",
    "AFTER INSERT",
    "NEW.provider = 'cloudflare' AND NEW.resource_kind = 'wfp-script'",
  ],
  [
    "product_command_intents_lifetime_notice",
    "product_command_intents",
    "AFTER INSERT",
    "NEW.binding_refresh_snapshot IS NOT NULL",
  ],
  [
    "paid_project_domains_lifetime_notice",
    "paid_project_domains",
    "AFTER INSERT",
    "NEW.custom_hostname_receipt IS NOT NULL",
  ],
  [
    "paid_project_domains_lifetime_notice_update",
    "paid_project_domains",
    "AFTER UPDATE",
    `(OLD.custom_hostname_receipt IS NOT NULL OR NEW.custom_hostname_receipt IS NOT NULL)
      AND (OLD.hostname IS DISTINCT FROM NEW.hostname
        OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
        OR OLD.project_id IS DISTINCT FROM NEW.project_id
        OR OLD.provisioning_started_at IS DISTINCT FROM NEW.provisioning_started_at
        OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
        OR (OLD.custom_hostname_receipt IS NULL) IS DISTINCT FROM (NEW.custom_hostname_receipt IS NULL))`,
  ],
  [
    "project_powered_by_flag_periods_lifetime_notice",
    "project_powered_by_flag_periods",
    "AFTER INSERT",
    null,
  ],
  [
    "project_powered_by_flag_periods_lifetime_notice_update",
    "project_powered_by_flag_periods",
    "AFTER UPDATE",
    "OLD.disabled_at IS DISTINCT FROM NEW.disabled_at",
  ],
  ["billing_epochs_lifetime_notice", "billing_epochs", "AFTER INSERT", null],
  [
    "billing_epochs_lifetime_notice_update",
    "billing_epochs",
    "AFTER UPDATE",
    `OLD.ended_at IS DISTINCT FROM NEW.ended_at OR OLD.started_at IS DISTINCT FROM NEW.started_at
      OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
      OR OLD.project_id IS DISTINCT FROM NEW.project_id`,
  ],
  [
    "usage_meter_activations_lifetime_notice",
    "usage_meter_activations",
    "AFTER INSERT",
    "NEW.meter IN ('wfp.script', 'domain.custom_hostname')",
  ],
];

const FUNCTIONS = [
  "append_lifetime_notice()",
  "guard_lifetime_dirty_notice_update()",
  "guard_lifetime_day_hint_update()",
  "guard_lifetime_discovery_bootstrap_update()",
  "guard_lifetime_resource_work_update()",
  "guard_lifetime_resource_source_update()",
];

const DERIVED_TABLES = [
  "lifetime_resource_work",
  "lifetime_resource_sources",
  "lifetime_day_hints",
  "lifetime_dirty_notices",
  "lifetime_discovery_bootstrap",
];

// The closed failure classes of src/database-failure.ts plus "unknown".
const FAILURE_CODES = `'lock_not_available','statement_canceled','idle_in_transaction_timeout',
  'transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','unknown'`;

const CLAIM_SHAPE = `(claim_owner IS NULL AND claim_token IS NULL AND claim_epoch IS NULL
    AND claimed_at IS NULL AND lease_until IS NULL)
  OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL
    AND claimed_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until > claimed_at
    AND generation > 0)`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  // Each pgm.sql is a separate driver query. Arm the limits before any lock is requested, and restore
  // the prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_lifetime_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_lifetime_migration_timeouts;
           DROP TABLE pg_temp.w24_lifetime_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);

  // The definer function qualifies every relation by the schema of the sources, so they and the
  // notice table must share one.
  pgm.sql(`DO $check$ BEGIN
    IF (SELECT count(DISTINCT relation.relnamespace) FROM pg_catalog.pg_class relation
        WHERE relation.oid IN (${SOURCE_TABLES.map((table) => `'${table}'::pg_catalog.regclass`).join(", ")})) <> 1 THEN
      RAISE EXCEPTION 'Lifetime discovery requires every source table in one schema';
    END IF;
  END $check$;`);

  pgm.sql(`
    -- Scheduling state of one logical resource. Dirty ranges are bounded on both sides by
    -- construction (a notice is clipped below the forward cursor, so it never needs an open end) and
    -- are separate from forward progress: a rewind never destroys unrelated forward discovery.
    CREATE TABLE lifetime_resource_work (
      source_kind text NOT NULL CHECK (source_kind IN ('wfp-script', 'custom-hostname')),
      resource_reference text NOT NULL CHECK (length(resource_reference) BETWEEN 1 AND 253),
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      next_forward_day date,
      dirty_from_day date,
      dirty_through_day date,
      next_due_at timestamptz,
      last_served_at timestamptz,
      claim_owner text CHECK (claim_owner IN ('control', 'metering')),
      claim_token ulid,
      claim_epoch bigint CHECK (claim_epoch > 0),
      claimed_at timestamptz,
      lease_until timestamptz,
      attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_failure_code text CHECK (last_failure_code IN (${FAILURE_CODES})),
      registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT lifetime_resource_work_pkey PRIMARY KEY (source_kind, resource_reference),
      CONSTRAINT lifetime_resource_work_claim_shape CHECK (${CLAIM_SHAPE}),
      CONSTRAINT lifetime_resource_work_dirty_shape CHECK (
        (dirty_from_day IS NULL AND dirty_through_day IS NULL)
        OR (dirty_from_day IS NOT NULL AND dirty_through_day IS NOT NULL
          AND dirty_through_day >= dirty_from_day))
    );
    -- Due work, oldest due first. A claim and every completion move next_due_at behind everything
    -- that waited longer; a sleeping resource has no due time and is not indexed.
    CREATE INDEX lifetime_resource_work_due_idx
      ON lifetime_resource_work (next_due_at, source_kind, resource_reference)
      WHERE next_due_at IS NOT NULL;

    -- One bounded record per physical source identity. source_id is the candidate receipt for a
    -- script and the project for a domain row (whose identity is the organization/project key); the
    -- organization is part of the key because a project can be re-owned under the same hostname.
    CREATE TABLE lifetime_resource_sources (
      source_kind text NOT NULL CHECK (source_kind IN ('wfp-script', 'custom-hostname')),
      resource_reference text NOT NULL CHECK (length(resource_reference) BETWEEN 1 AND 253),
      organization_id ulid NOT NULL,
      source_id ulid NOT NULL,
      project_id ulid NOT NULL,
      operation_id ulid,
      cleanup_hash bytea CHECK (cleanup_hash IS NULL OR octet_length(cleanup_hash) = 32),
      first_at timestamptz NOT NULL,
      registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT lifetime_resource_sources_pkey
        PRIMARY KEY (source_kind, resource_reference, organization_id, source_id),
      CONSTRAINT lifetime_resource_sources_shape CHECK (
        (source_kind = 'wfp-script' AND operation_id IS NOT NULL AND cleanup_hash IS NOT NULL)
        OR (source_kind = 'custom-hostname' AND operation_id IS NULL AND cleanup_hash IS NULL
          AND source_id = project_id))
    );
    -- Flag and epoch notices: the resources of a project, in key order for keyset pages.
    CREATE INDEX lifetime_resource_sources_project_idx
      ON lifetime_resource_sources (project_id, source_kind, resource_reference);
    -- Cleanup notices: scripts whose own canonical hash was removed.
    CREATE INDEX lifetime_resource_sources_cleanup_idx
      ON lifetime_resource_sources (organization_id, project_id, cleanup_hash, source_kind, resource_reference)
      WHERE cleanup_hash IS NOT NULL;
    -- Refresh, inventory and intent notices: the candidates of one operation, and those whose
    -- snapshot points at the removed source script.
    CREATE INDEX lifetime_resource_sources_operation_idx
      ON lifetime_resource_sources (organization_id, project_id, operation_id, source_kind, resource_reference)
      WHERE operation_id IS NOT NULL;

    -- Routing hints and status of one resource/day. hint_id is allocated once and survives every
    -- retry (the logical key is unique); a covered hint is a real valuation and is terminal.
    CREATE TABLE lifetime_day_hints (
      source_kind text NOT NULL CHECK (source_kind IN ('wfp-script', 'custom-hostname')),
      resource_reference text NOT NULL CHECK (length(resource_reference) BETWEEN 1 AND 253),
      day date NOT NULL,
      hint_id ulid NOT NULL,
      status text NOT NULL
        CHECK (status IN ('pending', 'evaluated_no_charge', 'unresolved_route', 'covered')),
      revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
      evaluated_revision bigint NOT NULL CHECK (evaluated_revision >= 0),
      evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      routed_organization_id ulid,
      routed_project_id ulid,
      routed_billing_epoch_id ulid,
      available_at timestamptz NOT NULL,
      attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_served_at timestamptz,
      last_failure_code text CHECK (last_failure_code IN (${FAILURE_CODES})),
      covered_valuation_id ulid REFERENCES usage_credit_valuations(valuation_id),
      covered_at timestamptz,
      CONSTRAINT lifetime_day_hints_pkey PRIMARY KEY (source_kind, resource_reference, day),
      CONSTRAINT lifetime_day_hints_hint_id_key UNIQUE (hint_id),
      CONSTRAINT lifetime_day_hints_route_shape CHECK (
        (routed_organization_id IS NULL) = (routed_project_id IS NULL)
        AND (routed_project_id IS NULL) = (routed_billing_epoch_id IS NULL)),
      CONSTRAINT lifetime_day_hints_status_shape CHECK (
        (status = 'pending' AND routed_organization_id IS NOT NULL
          AND covered_valuation_id IS NULL AND covered_at IS NULL)
        OR (status = 'covered' AND covered_valuation_id IS NOT NULL AND covered_at IS NOT NULL)
        OR (status IN ('evaluated_no_charge', 'unresolved_route') AND routed_organization_id IS NULL
          AND covered_valuation_id IS NULL AND covered_at IS NULL))
    );
    -- Unvalued pending work of one routed organization, in due order (the logical key is the PK).
    CREATE INDEX lifetime_day_hints_due_idx
      ON lifetime_day_hints (routed_organization_id, available_at, day, hint_id)
      WHERE status = 'pending';
    -- Automatic retries of one resource's unresolved routes.
    CREATE INDEX lifetime_day_hints_unresolved_idx
      ON lifetime_day_hints (source_kind, resource_reference, available_at, day)
      WHERE status = 'unresolved_route';

    -- Typed, cheap notices. The target columns and the earliest affected range are immutable; the
    -- cursor, schedule and claim are the mutable processing state. A pending row is consumed by
    -- its own state, never by an allocated-id high-water mark. No foreign keys: a source write must
    -- never wait for a scheduling row.
    CREATE TABLE lifetime_dirty_notices (
      notice_id bigint GENERATED ALWAYS AS IDENTITY,
      target_kind text NOT NULL
        CHECK (target_kind IN ('candidate', 'resource', 'cleanup', 'operation', 'project', 'meter')),
      reason text NOT NULL CHECK (reason IN ('candidate_receipt', 'candidate_cleanup',
        'cleanup_attempt', 'inventory', 'refresh_intent', 'domain', 'flag_period', 'billing_epoch',
        'meter_activation')),
      from_at timestamptz NOT NULL,
      to_at timestamptz,
      source_kind text CHECK (source_kind IN ('wfp-script', 'custom-hostname')),
      resource_reference text,
      organization_id ulid,
      project_id ulid,
      operation_id ulid,
      candidate_receipt_id ulid,
      external_ref_hash bytea CHECK (external_ref_hash IS NULL OR octet_length(external_ref_hash) = 32),
      provider text,
      meter text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      claim_owner text CHECK (claim_owner IN ('control', 'metering')),
      claim_token ulid,
      claim_epoch bigint CHECK (claim_epoch > 0),
      claimed_at timestamptz,
      lease_until timestamptz,
      cursor_source_kind text,
      cursor_resource_reference text,
      processed_at timestamptz,
      last_failure_code text CHECK (last_failure_code IN (${FAILURE_CODES})),
      CONSTRAINT lifetime_dirty_notices_pkey PRIMARY KEY (notice_id),
      CONSTRAINT lifetime_dirty_notices_range CHECK (to_at IS NULL OR to_at >= from_at),
      CONSTRAINT lifetime_dirty_notices_claim_shape CHECK (${CLAIM_SHAPE}),
      CONSTRAINT lifetime_dirty_notices_cursor_shape
        CHECK ((cursor_source_kind IS NULL) = (cursor_resource_reference IS NULL)),
      CONSTRAINT lifetime_dirty_notices_target_shape CHECK (
        (target_kind = 'candidate' AND candidate_receipt_id IS NOT NULL
          AND organization_id IS NOT NULL AND project_id IS NOT NULL
          AND reason IN ('candidate_receipt', 'candidate_cleanup'))
        OR (target_kind = 'resource' AND source_kind IS NOT NULL AND resource_reference IS NOT NULL
          AND (organization_id IS NULL) = (project_id IS NULL) AND reason = 'domain')
        OR (target_kind = 'cleanup' AND organization_id IS NOT NULL AND project_id IS NOT NULL
          AND operation_id IS NOT NULL AND external_ref_hash IS NOT NULL AND provider IS NOT NULL
          AND reason IN ('cleanup_attempt', 'inventory'))
        OR (target_kind = 'operation' AND organization_id IS NOT NULL AND project_id IS NOT NULL
          AND operation_id IS NOT NULL AND reason = 'refresh_intent')
        OR (target_kind = 'project' AND project_id IS NOT NULL
          AND reason IN ('flag_period', 'billing_epoch'))
        OR (target_kind = 'meter' AND meter IS NOT NULL AND reason = 'meter_activation'))
    );
    -- Pending notices that are due, oldest first. Processed rows are not indexed.
    CREATE INDEX lifetime_dirty_notices_due_idx
      ON lifetime_dirty_notices (next_attempt_at, notice_id) WHERE processed_at IS NULL;

    -- Named bootstrap jobs. A page is ONE transaction under its row's lock, so a crashed page leaves
    -- nothing behind and needs no lease; the cursor is the last SOURCE key scanned.
    CREATE TABLE lifetime_discovery_bootstrap (
      job text PRIMARY KEY CHECK (job IN ('candidate-receipts', 'paid-domains')),
      cursor_candidate_receipt_id ulid,
      cursor_organization_id ulid,
      cursor_project_id ulid,
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      scanned bigint NOT NULL DEFAULT 0 CHECK (scanned >= 0),
      last_served_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT lifetime_discovery_bootstrap_cursor_shape CHECK (
        (job = 'candidate-receipts' AND cursor_organization_id IS NULL AND cursor_project_id IS NULL)
        OR (job = 'paid-domains' AND cursor_candidate_receipt_id IS NULL
          AND (cursor_organization_id IS NULL) = (cursor_project_id IS NULL)))
    );
    INSERT INTO lifetime_discovery_bootstrap(job) VALUES ('candidate-receipts'), ('paid-domains');
  `);

  // Identity never changes; the rest is mutable scheduling state. Invoker rights, a fixed search
  // path, no table reference: correct in any schema and under any caller search_path.
  pgm.sql(`
    CREATE FUNCTION guard_lifetime_resource_work_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF NEW.source_kind IS DISTINCT FROM OLD.source_kind
        OR NEW.resource_reference IS DISTINCT FROM OLD.resource_reference
        OR NEW.registered_at IS DISTINCT FROM OLD.registered_at THEN
        RAISE EXCEPTION 'Lifetime resource identity is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER lifetime_resource_work_guard BEFORE UPDATE ON lifetime_resource_work
      FOR EACH ROW EXECUTE FUNCTION guard_lifetime_resource_work_update();

    CREATE FUNCTION guard_lifetime_resource_source_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF NEW.source_kind IS DISTINCT FROM OLD.source_kind
        OR NEW.resource_reference IS DISTINCT FROM OLD.resource_reference
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.source_id IS DISTINCT FROM OLD.source_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.cleanup_hash IS DISTINCT FROM OLD.cleanup_hash
        OR NEW.registered_at IS DISTINCT FROM OLD.registered_at THEN
        RAISE EXCEPTION 'Lifetime source identity is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER lifetime_resource_sources_guard BEFORE UPDATE ON lifetime_resource_sources
      FOR EACH ROW EXECUTE FUNCTION guard_lifetime_resource_source_update();

    -- A covered hint is a real valuation: terminal, and it never returns to pending billing.
    CREATE FUNCTION guard_lifetime_day_hint_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF NEW.source_kind IS DISTINCT FROM OLD.source_kind
        OR NEW.resource_reference IS DISTINCT FROM OLD.resource_reference
        OR NEW.day IS DISTINCT FROM OLD.day
        OR NEW.hint_id IS DISTINCT FROM OLD.hint_id THEN
        RAISE EXCEPTION 'Lifetime hint identity is immutable' USING ERRCODE = '55000';
      END IF;
      IF OLD.status = 'covered' AND (NEW.status IS DISTINCT FROM OLD.status
        OR NEW.covered_valuation_id IS DISTINCT FROM OLD.covered_valuation_id
        OR NEW.covered_at IS DISTINCT FROM OLD.covered_at) THEN
        RAISE EXCEPTION 'A covered lifetime hint is terminal' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER lifetime_day_hints_guard BEFORE UPDATE ON lifetime_day_hints
      FOR EACH ROW EXECUTE FUNCTION guard_lifetime_day_hint_update();

    -- Not append-only: the processing state moves. Identity is immutable and a processed notice is
    -- terminal.
    CREATE FUNCTION guard_lifetime_dirty_notice_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF OLD.processed_at IS NOT NULL THEN
        RAISE EXCEPTION 'A processed lifetime notice is terminal' USING ERRCODE = '55000';
      END IF;
      IF NEW.notice_id IS DISTINCT FROM OLD.notice_id
        OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
        OR NEW.reason IS DISTINCT FROM OLD.reason
        OR NEW.from_at IS DISTINCT FROM OLD.from_at
        OR NEW.to_at IS DISTINCT FROM OLD.to_at
        OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
        OR NEW.resource_reference IS DISTINCT FROM OLD.resource_reference
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.candidate_receipt_id IS DISTINCT FROM OLD.candidate_receipt_id
        OR NEW.external_ref_hash IS DISTINCT FROM OLD.external_ref_hash
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.meter IS DISTINCT FROM OLD.meter
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Lifetime notice identity is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER lifetime_dirty_notices_guard BEFORE UPDATE ON lifetime_dirty_notices
      FOR EACH ROW EXECUTE FUNCTION guard_lifetime_dirty_notice_update();

    CREATE FUNCTION guard_lifetime_discovery_bootstrap_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF OLD.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'A completed lifetime bootstrap is terminal' USING ERRCODE = '55000';
      END IF;
      IF NEW.job IS DISTINCT FROM OLD.job THEN
        RAISE EXCEPTION 'Lifetime bootstrap identity is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER lifetime_discovery_bootstrap_guard BEFORE UPDATE ON lifetime_discovery_bootstrap
      FOR EACH ROW EXECUTE FUNCTION guard_lifetime_discovery_bootstrap_update();
  `);

  // Fence every source writer first: pre-trigger writes finish (or this migration fails within the
  // budget with 55P03 and installs nothing), later ones wait for the commit. The order is fixed.
  pgm.sql(`LOCK TABLE ${SOURCE_TABLES.join(", ")} IN SHARE ROW EXCLUSIVE MODE;`);

  // Bounded exact lookups on authoritative tables. A table too large for one of them fails this
  // migration within the statement budget; nothing is left half installed.
  pgm.sql(`
    -- All receipts of one logical script, whatever the namespace or project.
    CREATE INDEX wfp_candidate_receipts_script_idx ON wfp_candidate_receipts (immutable_script_name);
    -- Removal evidence of one project's script hash (the legacy query ignores the provider).
    CREATE INDEX run_cleanup_attempts_wfp_removal_idx
      ON run_cleanup_attempts (organization_id, project_id, external_ref_hash)
      WHERE resource_kind = 'wfp-script' AND outcome IN ('removed', 'not_found');
    -- Every row of one hostname, live or deleted (the live-hostname index skips deleted rows).
    CREATE INDEX paid_project_domains_hostname_idx ON paid_project_domains (hostname)
      WHERE custom_hostname_receipt IS NOT NULL;
    -- The epochs of one project around an instant.
    CREATE INDEX billing_epochs_project_started_idx ON billing_epochs (project_id, started_at);
    -- The intent of one operation (the primary key leads with the environment).
    CREATE INDEX product_command_intents_operation_idx
      ON product_command_intents (organization_id, project_id, operation_id);
  `);

  // The only writer of notices. Definer rights let an old ingestion or provider role fire it
  // without any privilege on the notice table; the source and the target are bound to the actual
  // schema NOW, never to a caller path or a trigger argument. A trigger attached to any other
  // relation fails the source check before inserting a notice. The body holds no percent sign
  // because it is a format() template.
  pgm.sql(`
    DO $install$
    DECLARE source_schema text; source_oids text;
    BEGIN
      SELECT namespace.nspname INTO STRICT source_schema
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'wfp_candidate_receipts'::pg_catalog.regclass;
      IF (SELECT relnamespace FROM pg_catalog.pg_class
          WHERE oid = 'lifetime_dirty_notices'::pg_catalog.regclass)
        IS DISTINCT FROM (SELECT relnamespace FROM pg_catalog.pg_class
          WHERE oid = 'wfp_candidate_receipts'::pg_catalog.regclass) THEN
        RAISE EXCEPTION 'Lifetime discovery must live in the source schema';
      END IF;
      SELECT string_agg(relation.oid::text, ',' ORDER BY relation.oid) INTO STRICT source_oids
        FROM pg_catalog.pg_class relation
        WHERE relation.oid IN (${SOURCE_TABLES.map((table) => `'${table}'::pg_catalog.regclass`).join(", ")});
      EXECUTE pg_catalog.format($definition$
        CREATE FUNCTION %1$I.append_lifetime_notice() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
        DECLARE
          v_from timestamptz;
          v_old_start timestamptz;
          v_new_start timestamptz;
          v_identity boolean;
        BEGIN
          IF TG_TABLE_SCHEMA IS DISTINCT FROM %1$L OR TG_RELID NOT IN (%2$s)
            OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
            RAISE EXCEPTION 'Invalid lifetime notice trigger source' USING ERRCODE = '55000';
          END IF;
          IF TG_TABLE_NAME = 'wfp_candidate_receipts' AND TG_OP = 'INSERT' THEN
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at,
              candidate_receipt_id, organization_id, project_id, operation_id)
            VALUES ('candidate', 'candidate_receipt', NEW.staged_at,
              NEW.candidate_receipt_id, NEW.organization_id, NEW.project_id, NEW.operation_id);
          ELSIF TG_TABLE_NAME = 'wfp_candidate_cleanup_receipts' AND TG_OP = 'INSERT' THEN
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at,
              candidate_receipt_id, organization_id, project_id)
            VALUES ('candidate', 'candidate_cleanup', NEW.observed_at,
              NEW.candidate_receipt_id, NEW.organization_id, NEW.project_id);
          ELSIF TG_TABLE_NAME = 'run_cleanup_attempts' AND TG_OP = 'INSERT' THEN
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at,
              organization_id, project_id, operation_id, external_ref_hash, provider)
            VALUES ('cleanup', 'cleanup_attempt', NEW.attempted_at,
              NEW.organization_id, NEW.project_id, NEW.operation_id, NEW.external_ref_hash,
              NEW.provider);
          ELSIF TG_TABLE_NAME = 'run_resource_inventory' AND TG_OP = 'INSERT' THEN
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at,
              organization_id, project_id, operation_id, external_ref_hash, provider)
            VALUES ('cleanup', 'inventory', NEW.recorded_at,
              NEW.organization_id, NEW.project_id, NEW.operation_id, NEW.external_ref_hash,
              NEW.provider);
          ELSIF TG_TABLE_NAME = 'product_command_intents' AND TG_OP = 'INSERT' THEN
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at,
              organization_id, project_id, operation_id)
            VALUES ('operation', 'refresh_intent', NEW.created_at,
              NEW.organization_id, NEW.project_id, NEW.operation_id);
          ELSIF TG_TABLE_NAME = 'paid_project_domains' AND TG_OP = 'INSERT' THEN
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at,
              source_kind, resource_reference, organization_id, project_id)
            VALUES ('resource', 'domain',
              COALESCE(NEW.provisioning_started_at, NEW.created_at),
              'custom-hostname', NEW.hostname, NEW.organization_id, NEW.project_id);
          ELSIF TG_TABLE_NAME = 'paid_project_domains' AND TG_OP = 'UPDATE' THEN
            v_old_start := COALESCE(OLD.provisioning_started_at, OLD.created_at);
            v_new_start := COALESCE(NEW.provisioning_started_at, NEW.created_at);
            v_identity := OLD.hostname IS DISTINCT FROM NEW.hostname
              OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
              OR OLD.project_id IS DISTINCT FROM NEW.project_id
              OR (OLD.custom_hostname_receipt IS NULL) IS DISTINCT FROM (NEW.custom_hostname_receipt IS NULL);
            -- The earliest instant at which the hostname's lifetime inputs changed. A start that
            -- moved or was reset takes both the old and the new bound; LEAST ignores a missing end.
            v_from := LEAST(
              CASE WHEN v_identity THEN v_new_start END,
              CASE WHEN OLD.provisioning_started_at IS DISTINCT FROM NEW.provisioning_started_at
                THEN LEAST(v_old_start, v_new_start) END,
              CASE WHEN OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
                THEN LEAST(OLD.deleted_at, NEW.deleted_at) END);
            IF NEW.custom_hostname_receipt IS NOT NULL THEN
              INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at,
                source_kind, resource_reference, organization_id, project_id)
              VALUES ('resource', 'domain', COALESCE(v_from, v_new_start),
                'custom-hostname', NEW.hostname, NEW.organization_id, NEW.project_id);
            END IF;
            IF OLD.custom_hostname_receipt IS NOT NULL AND v_identity THEN
              INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at,
                source_kind, resource_reference, organization_id, project_id)
              VALUES ('resource', 'domain', v_old_start,
                'custom-hostname', OLD.hostname, OLD.organization_id, OLD.project_id);
            END IF;
          ELSIF TG_TABLE_NAME = 'project_powered_by_flag_periods' AND TG_OP = 'INSERT' THEN
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at, to_at,
              project_id, organization_id)
            VALUES ('project', 'flag_period', NEW.enabled_at, NEW.disabled_at,
              NEW.project_id, NEW.organization_id);
          ELSIF TG_TABLE_NAME = 'project_powered_by_flag_periods' AND TG_OP = 'UPDATE' THEN
            -- Closing the open range changes coverage from the new end onward, not from its start.
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at,
              project_id, organization_id)
            VALUES ('project', 'flag_period', NEW.disabled_at, NEW.project_id, NEW.organization_id);
          ELSIF TG_TABLE_NAME = 'billing_epochs' AND TG_OP = 'INSERT' THEN
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at, to_at, project_id)
            VALUES ('project', 'billing_epoch', NEW.started_at, NEW.ended_at, NEW.project_id);
          ELSIF TG_TABLE_NAME = 'billing_epochs' AND TG_OP = 'UPDATE' THEN
            IF OLD.started_at IS DISTINCT FROM NEW.started_at
              OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
              OR OLD.project_id IS DISTINCT FROM NEW.project_id THEN
              -- A legal change of start or ownership: both scopes, from the earliest affected start.
              INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at, project_id)
              VALUES ('project', 'billing_epoch', LEAST(OLD.started_at, NEW.started_at), NEW.project_id);
              IF OLD.project_id IS DISTINCT FROM NEW.project_id THEN
                INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at, project_id)
                VALUES ('project', 'billing_epoch', LEAST(OLD.started_at, NEW.started_at), OLD.project_id);
              END IF;
            ELSE
              -- The end moved: from the earlier end (an open end counts as later).
              INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at, project_id)
              VALUES ('project', 'billing_epoch', LEAST(OLD.ended_at, NEW.ended_at), NEW.project_id);
            END IF;
          ELSIF TG_TABLE_NAME = 'usage_meter_activations' AND TG_OP = 'INSERT' THEN
            INSERT INTO %1$I.lifetime_dirty_notices(target_kind, reason, from_at, meter)
            VALUES ('meter', 'meter_activation', NEW.starts_at, NEW.meter);
          ELSE
            RAISE EXCEPTION 'Invalid lifetime notice trigger source' USING ERRCODE = '55000';
          END IF;
          RETURN NULL;
        END;
        $body$;
      $definition$, source_schema, source_oids);
    END $install$;
  `);

  // Every trigger fires for a restore or replication session too (ENABLE ALWAYS), exactly like
  // migration 184. The existing append-only and integrity BEFORE triggers are untouched: a row they
  // reject never reaches these AFTER triggers.
  for (const [name, table, event, when] of TRIGGERS) {
    pgm.sql(`
      CREATE TRIGGER ${name} ${event} ON ${table} FOR EACH ROW
        ${when === null ? "" : `WHEN (${when})`}
        EXECUTE FUNCTION append_lifetime_notice();
      ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${name};
    `);
  }

  // Default privileges may already grant a runtime role more than it needs, independently of
  // PUBLIC: start from nothing on every new function and table, then grant the metadata API only.
  // No DELETE, TRUNCATE or DDL; UPDATE also serves row locks. Notices are inserted by the definer
  // trigger alone, so no role receives INSERT on them.
  for (const signature of FUNCTIONS) {
    pgm.sql(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
  }
  pgm.sql(`REVOKE ALL ON ${DERIVED_TABLES.join(", ")} FROM PUBLIC;`);
  pgm.sql(`DO $grant$
  DECLARE role_name text; function_signature text;
  BEGIN
    FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        FOREACH function_signature IN ARRAY ARRAY[${FUNCTIONS.map((signature) => `'${signature}'`).join(", ")}] LOOP
          EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', function_signature, role_name);
        END LOOP;
        EXECUTE format('REVOKE ALL ON ${DERIVED_TABLES.join(", ")} FROM %I', role_name);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON lifetime_resource_work,
          lifetime_resource_sources, lifetime_day_hints TO %I', role_name);
        EXECUTE format('GRANT SELECT, UPDATE ON lifetime_dirty_notices,
          lifetime_discovery_bootstrap TO %I', role_name);
      END IF;
    END LOOP;
  END $grant$;`);

  restoreBounds(pgm);
}

/**
 * Everything here is derived scheduling metadata that the bootstrap and the triggers rebuild; no
 * financial fact lives in it. The downgrade drops it without a retention guard and leaves every
 * source row, receipt and ledger entry untouched.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
export function down(pgm) {
  boundDdl(pgm);
  pgm.sql(`LOCK TABLE ${SOURCE_TABLES.join(", ")} IN SHARE ROW EXCLUSIVE MODE;`);
  for (const [name, table] of TRIGGERS) {
    pgm.sql(`DROP TRIGGER ${name} ON ${table};`);
  }
  pgm.sql(`
    DROP FUNCTION append_lifetime_notice();
    DROP INDEX product_command_intents_operation_idx;
    DROP INDEX billing_epochs_project_started_idx;
    DROP INDEX paid_project_domains_hostname_idx;
    DROP INDEX run_cleanup_attempts_wfp_removal_idx;
    DROP INDEX wfp_candidate_receipts_script_idx;
    DROP TABLE lifetime_discovery_bootstrap;
    DROP TABLE lifetime_dirty_notices;
    DROP TABLE lifetime_day_hints;
    DROP TABLE lifetime_resource_sources;
    DROP TABLE lifetime_resource_work;
    DROP FUNCTION guard_lifetime_discovery_bootstrap_update();
    DROP FUNCTION guard_lifetime_dirty_notice_update();
    DROP FUNCTION guard_lifetime_day_hint_update();
    DROP FUNCTION guard_lifetime_resource_source_update();
    DROP FUNCTION guard_lifetime_resource_work_update();
  `);
  restoreBounds(pgm);
}
