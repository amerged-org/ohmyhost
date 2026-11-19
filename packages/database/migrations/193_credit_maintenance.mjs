// W24 M-D: durable, quiet-organization credit maintenance FOUNDATION. One credit_maintenance_due row
// per organization says "this organization's allowance, balance, grace or expiry may need another
// look at due_at" and carries a monotonic source_revision that every actual change of an input of
// that evaluation bumps in the SAME transaction as the change. Nothing here issues a credit, posts
// usage, locks a wallet or releases a financial claim; the unified runner (a later unit) evaluates
// under the common financial guard and completes the state with an expected-revision compare.
//
// Two invalidation paths, split by audited lock ownership (a fake event per minute or per movement
// is never recorded):
//
//  - WAKE (class A, credit_maintenance_wake_source): grants, grant adjustments, credit movements and
//    credit resolutions. Every production writer takes wallet lock C0 (the mapping row, then the
//    wallet row; released binaries take the mapping row FOR UPDATE) before its first write:
//    grantOrganizationCredits, ensureMonthlyCredits, recordStripePaymentReversals,
//    recordRechargeReversals, reserve/settle/releaseOrganizationCredits and postMeasuredUsage all call
//    lockCreditOrganization first. The trigger therefore coalesces the exact due row directly:
//    revision + 1 and, for a scheduled row, due now. It never reads or locks the wallet, the mapping,
//    the organization claim row or the owner row, and it creates a missing due row WITHOUT any
//    foreign key or organization seed, so it can neither wait on an organization lane row nor close
//    a cycle with a released writer that holds the mapping row FOR UPDATE. A resolution's
//    organization is the exact reservation primary key lookup (the resolution table has no
//    organization column). An uncoordinated operator statement without C0 has the same lock-graph
//    caveat migration 187 documents for its state row; this trigger fires right after 187's (its
//    name sorts later), so the two rows are always taken in the same order.
//  - NOTICE (class N, credit_maintenance_append_notice): low-volume facts whose writers are NOT all
//    proven C0-first or that have no runtime writer at all. The mapping state, project ownership
//    organization/state (serving membership) and the remaining migration-187 expiry-policy
//    dependencies (preserved expirations, payments, subscription ends, access events, current
//    access, checkout and recharge metadata) append one cheap, typed, immutable notice per affected
//    organization, OLD and NEW alike on a scope change. The trigger holds no foreign key and reads
//    nothing, so the source writer never waits for a scheduling row. A bounded consumer later turns
//    notices into revision bumps (owner SHARE, organization lane row, due row; never C0).
//
// Why this is complete, in the same two halves as migrations 184 and 186: LOCK TABLE ... SHARE ROW
// EXCLUSIVE on every trigger-bearing source waits out the writers that already changed one and blocks
// new ones until this transaction commits. A row is therefore committed before the triggers exist
// (the bounded mapping-key bootstrap schedules its organization) or written after (a trigger covers
// it, whatever its key or commit order is). A sequence or a timestamp watermark would prove neither.
//
// Boundary completeness is a SEPARATE obligation from mutation completeness: the indexes below make
// every "next future time" probe a bounded index lookup (migration 187 has none), and the lot-expiry
// extraction reads the 187 cache only when its revision, generation and policy are ready. No object
// here edits migration 187.
//
// Every SECURITY DEFINER or trigger function is created through the same wrapper migration 187 uses:
// the relations are qualified by the schema of the organization mappings, the function's own
// search_path is only pg_catalog (then pg_temp last), and the attached relation is checked against
// the actual schema, name and TG_RELID, so neither a caller's search_path, a hostile temporary
// table nor a trigger attached to some other relation can redirect a write. All new objects are
// derived scheduling metadata: the downgrade drops them without a retention guard and no ledger,
// payment or evidence row is touched.

/**
 * Class A: a C0-first writer coalesces the due row directly. [table, columns whose real change fires
 * the UPDATE trigger]; INSERT and DELETE always fire.
 * @type {ReadonlyArray<readonly [string, readonly string[]]>}
 */
const WAKE_SOURCES = [
  [
    "organization_credit_grants",
    [
      "organization_id",
      "grant_id",
      "kind",
      "source_reference",
      "amount_micros",
      "granted_at",
      "expires_at",
    ],
  ],
  [
    "organization_credit_grant_adjustments",
    ["organization_id", "grant_id", "amount_micros", "occurred_at"],
  ],
  [
    "organization_credit_movements",
    ["organization_id", "reservation_id", "grant_id", "phase", "reserved_micros", "spent_micros"],
  ],
  [
    "organization_credit_resolutions",
    ["reservation_id", "outcome", "charge_micros", "funded_micros"],
  ],
];

/**
 * Class N: a typed notice per affected organization. The columns of the migration-187 matrix are
 * reused verbatim; ownership adds its serving columns. INSERT and DELETE always fire.
 * @type {ReadonlyArray<readonly [string, readonly string[]]>}
 */
const NOTICE_SOURCES = [
  ["organization_credit_grant_expirations", ["organization_id", "grant_id", "expires_at"]],
  [
    "stripe_credit_payments",
    [
      "organization_id",
      "grant_id",
      "offer",
      "account_id",
      "mode",
      "subscription_id",
      "invoice_id",
      "period_start",
      "period_end",
      "paid_at",
      "confirmed_at",
      "credited_micros",
      "checkout_id",
    ],
  ],
  [
    "stripe_subscription_ends",
    ["organization_id", "account_id", "mode", "subscription_id", "ended_at"],
  ],
  [
    "organization_paid_access_events",
    ["organization_id", "event_id", "occurred_at", "enabled", "paid_until"],
  ],
  ["organization_paid_access", ["organization_id", "enabled", "updated_at", "paid_until"]],
  ["stripe_checkout_requests", ["organization_id", "checkout_id", "created_at"]],
  ["stripe_recharge_attempts", ["organization_id", "grant_id", "created_at"]],
  ["project_ownerships", ["organization_id", "state"]],
];

const MAPPINGS = "workos_organization_mappings";
const MAPPING_COLUMNS = ["organization_id", "state"];

const ALL_TRIGGER_TABLES = [
  MAPPINGS,
  ...WAKE_SOURCES.map(([table]) => table),
  ...NOTICE_SOURCES.map(([table]) => table),
].sort();

const PRIVATE_FUNCTIONS = [
  "credit_maintenance_wake_source()",
  "credit_maintenance_append_notice()",
  "guard_credit_maintenance_due_update()",
  "guard_credit_maintenance_notice_update()",
  "guard_credit_maintenance_bootstrap_update()",
];

const TABLES = [
  "credit_maintenance_due",
  "credit_maintenance_notices",
  "credit_maintenance_bootstrap",
];

// Indexes on existing tables that bound every exact "next future time" probe and the serving
// predicate. [name, table, definition after the table name]. Each is built under the fence and the
// statement budget of this migration, so a table too large for one fails the whole migration
// cleanly (55P03 / 57014) and rolls everything back, never half of it.
const INDEXES = [
  [
    "organization_credit_grants_org_granted_idx",
    "organization_credit_grants",
    "(organization_id, granted_at)",
  ],
  [
    "credit_adjustments_org_occurred_idx",
    "organization_credit_grant_adjustments",
    "(organization_id, occurred_at)",
  ],
  [
    "stripe_paid_org_start_idx",
    "stripe_credit_payments",
    "(organization_id, period_start) WHERE offer = 'paid'",
  ],
  [
    "stripe_paid_org_paid_at_idx",
    "stripe_credit_payments",
    "(organization_id, paid_at) WHERE offer = 'paid' AND paid_at IS NOT NULL",
  ],
  [
    "stripe_paid_org_confirmed_idx",
    "stripe_credit_payments",
    "(organization_id, confirmed_at) WHERE offer = 'paid'",
  ],
  [
    "stripe_subscription_ends_org_ended_idx",
    "stripe_subscription_ends",
    "(organization_id, ended_at)",
  ],
  [
    "organization_paid_access_events_org_occurred_idx",
    "organization_paid_access_events",
    "(organization_id, occurred_at)",
  ],
  [
    "organization_paid_access_events_org_until_idx",
    "organization_paid_access_events",
    "(organization_id, paid_until) WHERE paid_until IS NOT NULL",
  ],
  [
    "credit_expiry_lots_expiry_idx",
    "credit_expiry_lots",
    "(organization_id, generation, expires_at) WHERE expires_at IS NOT NULL",
  ],
  [
    "project_ownerships_active_org_idx",
    "project_ownerships",
    "(organization_id) WHERE state = 'active'",
  ],
];

// The closed failure classes of src/database-failure.ts plus "unknown" (as migration 186).
const FAILURE_CODES = `'lock_not_available','statement_canceled','idle_in_transaction_timeout',
  'transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','unknown'`;

const NOTICE_REASONS = `'mapping_state','project_ownership','credit_expiration','stripe_payment',
  'stripe_subscription_end','paid_access_event','paid_access','stripe_checkout','stripe_recharge'`;

// Every SECURITY DEFINER or trigger function is created through this wrapper. @S@ becomes the quoted
// schema that holds the organization mappings and @L@ the same name as a string literal.
const TRUSTED_SCHEMA = `(SELECT n.nspname FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'workos_organization_mappings' AND c.relkind = 'r'
    AND n.nspname = pg_catalog.current_schema())`;

/** @param {string} definition */
const inTrustedSchema = (definition) => `DO $install$ BEGIN
  EXECUTE replace(replace($definition$${definition}$definition$,
    '@S@', quote_ident(${TRUSTED_SCHEMA})), '@L@', quote_literal(${TRUSTED_SCHEMA}));
END $install$;`;

const FIXED_PATH = "SET search_path = pg_catalog, pg_temp";

/**
 * The trigger-source check shared by both trigger functions.
 * @param {readonly string[]} tables
 * @param {"AFTER" | "BEFORE"} [when]
 */
const sourceCheck = (
  tables,
  when = "AFTER",
) => `IF TG_WHEN <> '${when}' OR TG_LEVEL <> 'ROW' OR TG_NARGS <> 0
        OR TG_TABLE_SCHEMA::text <> @L@
        OR TG_TABLE_NAME::text <> ALL (ARRAY[${tables.map((table) => `'${table}'`).join(", ")}]::text[])
        OR TG_RELID IS DISTINCT FROM
          (quote_ident(TG_TABLE_SCHEMA::text) || '.' || quote_ident(TG_TABLE_NAME::text))::pg_catalog.regclass THEN
        RAISE EXCEPTION 'Invalid credit maintenance trigger source' USING ERRCODE = '55000';
      END IF;`;

/**
 * @param {string} table
 * @param {readonly string[]} columns
 * @param {string} fn
 * @param {boolean} withDelete
 */
function sourceTriggers(table, columns, fn, withDelete) {
  const changed = columns
    .map((column) => `OLD.${column} IS DISTINCT FROM NEW.${column}`)
    .join("\n        OR ");
  return `
    CREATE TRIGGER ${table}_credit_maintenance_insert AFTER INSERT ON @S@.${table}
      FOR EACH ROW EXECUTE FUNCTION @S@.${fn}();
    ALTER TABLE @S@.${table} ENABLE ALWAYS TRIGGER ${table}_credit_maintenance_insert;
    CREATE TRIGGER ${table}_credit_maintenance_update AFTER UPDATE ON @S@.${table}
      FOR EACH ROW WHEN (${changed})
      EXECUTE FUNCTION @S@.${fn}();
    ALTER TABLE @S@.${table} ENABLE ALWAYS TRIGGER ${table}_credit_maintenance_update;
    ${
      withDelete
        ? `CREATE TRIGGER ${table}_credit_maintenance_delete AFTER DELETE ON @S@.${table}
      FOR EACH ROW EXECUTE FUNCTION @S@.${fn}();
    ALTER TABLE @S@.${table} ENABLE ALWAYS TRIGGER ${table}_credit_maintenance_delete;`
        : ""
    }
  `;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  // Each pgm.sql is a separate driver query. Arm the lock and statement limits before any DDL, and
  // restore the prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_maintenance_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_maintenance_migration_timeouts;
           DROP TABLE pg_temp.w24_maintenance_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);
  /** @param {string} definition */
  const sql = (definition) => pgm.sql(inTrustedSchema(definition));

  // The generated functions qualify every relation by one schema, so the sources, the lane rows and
  // the new tables must share it.
  sql(`
    DO $check$ BEGIN
      IF (SELECT count(DISTINCT c.relnamespace) FROM pg_catalog.pg_class c
          WHERE c.oid IN (${[
            ...ALL_TRIGGER_TABLES,
            "organization_metering_work",
            "credit_expiry_lots",
            "organization_credit_reservations",
          ]
            .map((table) => `'@S@.${table}'::pg_catalog.regclass`)
            .join(", ")})) <> 1 THEN
        RAISE EXCEPTION 'Credit maintenance requires every source and lane table in the schema of the organization mappings';
      END IF;
    END $check$;
  `);

  sql(`
    -- One row per organization. due_at is the next time the organization needs another look and is
    -- always finite; NULL means "sleeping": the organization was found not serving, and a mapping or
    -- ownership notice (or a scheduled wake) is the only thing that wakes it again. A row is dirty
    -- while evaluated_revision < source_revision. source_revision and evaluated_revision only move
    -- forward. No lease or claim lives here: the organization lane row (migration 183) is the one
    -- financial authority. There is deliberately NO foreign key, neither to the lane row nor to the
    -- mapping: a trigger-created row must never wait for a lane insert, and a first-row insert must
    -- not queue for a KEY SHARE on a mapping row that a released binary holds FOR UPDATE while that
    -- binary's own trigger waits for this insert. Every writer derives the organization from a row
    -- that itself references the mapping. fillfactor leaves room for same-page (HOT) updates of a
    -- row that is bumped far more often than it is rescheduled.
    CREATE TABLE @S@.credit_maintenance_due (
      organization_id @S@.ulid PRIMARY KEY,
      source_revision bigint NOT NULL DEFAULT 1 CHECK (source_revision > 0),
      due_at timestamptz CHECK (due_at IS NULL OR isfinite(due_at)),
      evaluated_revision bigint NOT NULL DEFAULT 0 CHECK (evaluated_revision >= 0),
      evaluated_at timestamptz,
      attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_failure_code text CHECK (last_failure_code IN (${FAILURE_CODES})),
      CONSTRAINT credit_maintenance_due_evaluated_not_ahead
        CHECK (evaluated_revision <= source_revision),
      CONSTRAINT credit_maintenance_due_evaluated_shape
        CHECK ((evaluated_revision = 0) = (evaluated_at IS NULL))
    ) WITH (fillfactor = 70);
    -- Due work in fair order. A sleeping row is not indexed; a bump or a completion moves due_at
    -- behind everything that waited longer.
    CREATE INDEX credit_maintenance_due_idx
      ON @S@.credit_maintenance_due (due_at, organization_id) WHERE due_at IS NOT NULL;

    -- Typed, cheap, immutable-identity notices. The reason and organization never change; the
    -- schedule, claim and processed state are the mutable processing state. A pending row is
    -- consumed by its own state, never by an allocated-id or commit watermark. No foreign keys: a
    -- source write must never wait for a scheduling row, and a notice for an organization without a
    -- mapping is simply consumed unused (its later mapping insert has a notice of its own).
    CREATE TABLE @S@.credit_maintenance_notices (
      notice_id bigint GENERATED ALWAYS AS IDENTITY,
      organization_id @S@.ulid NOT NULL,
      reason text NOT NULL CHECK (reason IN (${NOTICE_REASONS})),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      claim_owner text CHECK (claim_owner IN ('control', 'metering')),
      claim_token @S@.ulid,
      claim_epoch bigint CHECK (claim_epoch > 0),
      claimed_at timestamptz,
      lease_until timestamptz,
      processed_at timestamptz,
      last_failure_code text CHECK (last_failure_code IN (${FAILURE_CODES})),
      CONSTRAINT credit_maintenance_notices_pkey PRIMARY KEY (notice_id),
      CONSTRAINT credit_maintenance_notices_claim_shape CHECK (
        (claim_owner IS NULL AND claim_token IS NULL AND claim_epoch IS NULL
          AND claimed_at IS NULL AND lease_until IS NULL)
        OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL
          AND claimed_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until > claimed_at
          AND processed_at IS NULL))
    );
    -- Pending notices that are due, oldest first. Processed rows are not indexed.
    CREATE INDEX credit_maintenance_notices_due_idx
      ON @S@.credit_maintenance_notices (next_attempt_at, notice_id) WHERE processed_at IS NULL;
    -- "Is any notice of this organization still unprocessed?" for the completion compare.
    CREATE INDEX credit_maintenance_notices_pending_org_idx
      ON @S@.credit_maintenance_notices (organization_id) WHERE processed_at IS NULL;

    -- One named bootstrap job over the mapping primary key. A page is ONE transaction under this
    -- row's lock, so a crashed page leaves nothing behind and needs no lease; the cursor is the last
    -- mapping key scanned.
    CREATE TABLE @S@.credit_maintenance_bootstrap (
      job text PRIMARY KEY CHECK (job = 'mappings'),
      cursor_organization_id @S@.ulid,
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      scanned bigint NOT NULL DEFAULT 0 CHECK (scanned >= 0),
      last_served_at timestamptz,
      completed_at timestamptz
    );
    INSERT INTO @S@.credit_maintenance_bootstrap(job) VALUES ('mappings');

    DO $placed$ BEGIN
      IF (SELECT count(DISTINCT c.relnamespace) FROM pg_catalog.pg_class c
          WHERE c.oid IN ('@S@.credit_maintenance_due'::pg_catalog.regclass,
            '@S@.credit_maintenance_notices'::pg_catalog.regclass,
            '@S@.credit_maintenance_bootstrap'::pg_catalog.regclass,
            '@S@.workos_organization_mappings'::pg_catalog.regclass)) <> 1 THEN
        RAISE EXCEPTION 'Credit maintenance tables must live in the schema of the organization mappings';
      END IF;
    END $placed$;
  `);

  // Identity never changes; revisions only move forward. Invoker rights, a fixed search_path and no
  // table reference: correct in any schema and under any caller search_path.
  sql(`
    CREATE FUNCTION @S@.guard_credit_maintenance_due_update() RETURNS trigger
    LANGUAGE plpgsql ${FIXED_PATH} AS $$
    BEGIN
      ${sourceCheck(["credit_maintenance_due"], "BEFORE")}
      IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'Invalid credit maintenance guard event' USING ERRCODE = '55000';
      END IF;
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        RAISE EXCEPTION 'Credit maintenance identity is immutable' USING ERRCODE = '55000';
      END IF;
      IF NEW.source_revision < OLD.source_revision OR NEW.evaluated_revision < OLD.evaluated_revision THEN
        RAISE EXCEPTION 'Credit maintenance revisions only move forward' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER credit_maintenance_due_guard BEFORE UPDATE ON @S@.credit_maintenance_due
      FOR EACH ROW EXECUTE FUNCTION @S@.guard_credit_maintenance_due_update();
    ALTER TABLE @S@.credit_maintenance_due ENABLE ALWAYS TRIGGER credit_maintenance_due_guard;

    -- Not append-only: the processing state moves. Identity is immutable and a processed notice is
    -- terminal.
    CREATE FUNCTION @S@.guard_credit_maintenance_notice_update() RETURNS trigger
    LANGUAGE plpgsql ${FIXED_PATH} AS $$
    BEGIN
      ${sourceCheck(["credit_maintenance_notices"], "BEFORE")}
      IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'Invalid credit maintenance guard event' USING ERRCODE = '55000';
      END IF;
      IF OLD.processed_at IS NOT NULL THEN
        RAISE EXCEPTION 'A processed credit maintenance notice is terminal' USING ERRCODE = '55000';
      END IF;
      IF NEW.notice_id IS DISTINCT FROM OLD.notice_id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.reason IS DISTINCT FROM OLD.reason
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Credit maintenance notice identity is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER credit_maintenance_notices_guard BEFORE UPDATE ON @S@.credit_maintenance_notices
      FOR EACH ROW EXECUTE FUNCTION @S@.guard_credit_maintenance_notice_update();
    ALTER TABLE @S@.credit_maintenance_notices ENABLE ALWAYS TRIGGER credit_maintenance_notices_guard;

    CREATE FUNCTION @S@.guard_credit_maintenance_bootstrap_update() RETURNS trigger
    LANGUAGE plpgsql ${FIXED_PATH} AS $$
    BEGIN
      ${sourceCheck(["credit_maintenance_bootstrap"], "BEFORE")}
      IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'Invalid credit maintenance guard event' USING ERRCODE = '55000';
      END IF;
      IF OLD.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'A completed credit maintenance bootstrap is terminal' USING ERRCODE = '55000';
      END IF;
      IF NEW.job IS DISTINCT FROM OLD.job THEN
        RAISE EXCEPTION 'Credit maintenance bootstrap identity is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER credit_maintenance_bootstrap_guard BEFORE UPDATE ON @S@.credit_maintenance_bootstrap
      FOR EACH ROW EXECUTE FUNCTION @S@.guard_credit_maintenance_bootstrap_update();
    ALTER TABLE @S@.credit_maintenance_bootstrap ENABLE ALWAYS TRIGGER credit_maintenance_bootstrap_guard;
  `);

  // Fence every trigger-bearing source first, in one fixed order: pre-trigger writes finish (or
  // this migration fails within the budget with 55P03 and installs nothing), later ones wait for
  // the commit.
  sql(
    `LOCK TABLE ${ALL_TRIGGER_TABLES.map((table) => `@S@.${table}`).join(", ")} IN SHARE ROW EXCLUSIVE MODE;`,
  );

  // Bounded exact lookups on authoritative tables.
  for (const [name, table, definition] of INDEXES) {
    sql(`CREATE INDEX ${name} ON @S@.${table} ${definition};`);
  }

  // Class A. Coalesces the exact due row of each affected organization (both on a scope change, in
  // key order). A missing row is created due now WITHOUT foreign key lookups or lane seeding: the
  // bootstrap and the consumer own those. A sleeping row (due_at NULL) is bumped but stays asleep:
  // an organization found not serving is woken by serving-membership notices alone. The comparison
  // against the clock keeps an already-due row's due_at unchanged, so a burst of movements is a
  // sequence of same-page updates.
  sql(`
    CREATE FUNCTION @S@.credit_maintenance_wake_source() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_old text;
      v_new text;
      v_organization_id text;
    BEGIN
      ${sourceCheck(WAKE_SOURCES.map(([table]) => table))}
      IF TG_TABLE_NAME::text = 'organization_credit_resolutions' THEN
        IF TG_OP <> 'DELETE' THEN
          SELECT r.organization_id INTO v_new FROM @S@.organization_credit_reservations r
            WHERE r.reservation_id = NEW.reservation_id;
        END IF;
        IF TG_OP <> 'INSERT' THEN
          SELECT r.organization_id INTO v_old FROM @S@.organization_credit_reservations r
            WHERE r.reservation_id = OLD.reservation_id;
        END IF;
      ELSIF TG_OP = 'INSERT' THEN
        v_new := NEW.organization_id;
      ELSIF TG_OP = 'DELETE' THEN
        v_old := OLD.organization_id;
      ELSE
        v_old := OLD.organization_id;
        v_new := NEW.organization_id;
      END IF;
      FOR v_organization_id IN
        SELECT DISTINCT t.org FROM unnest(ARRAY[v_old, v_new]) AS t(org)
        WHERE t.org IS NOT NULL ORDER BY t.org
      LOOP
        UPDATE @S@.credit_maintenance_due d SET
          source_revision = d.source_revision + 1,
          due_at = CASE WHEN d.due_at IS NULL THEN NULL
            WHEN d.due_at > clock_timestamp() THEN clock_timestamp() ELSE d.due_at END
          WHERE d.organization_id = v_organization_id;
        IF NOT FOUND THEN
          INSERT INTO @S@.credit_maintenance_due AS d(organization_id, source_revision, due_at)
            VALUES (v_organization_id, 1, clock_timestamp())
            ON CONFLICT (organization_id) DO UPDATE SET
              source_revision = d.source_revision + 1,
              due_at = CASE WHEN d.due_at IS NULL THEN NULL
                WHEN d.due_at > clock_timestamp() THEN clock_timestamp() ELSE d.due_at END;
        END IF;
      END LOOP;
      RETURN NULL;
    END
    $body$;`);

  // Class N. One typed notice per affected organization; reads nothing, takes no lock beyond its
  // own insert.
  sql(`
    CREATE FUNCTION @S@.credit_maintenance_append_notice() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER ${FIXED_PATH} AS $body$
    DECLARE
      v_old text;
      v_new text;
      v_reason text;
    BEGIN
      ${sourceCheck([MAPPINGS, ...NOTICE_SOURCES.map(([table]) => table)])}
      v_reason := CASE TG_TABLE_NAME::text
        WHEN 'workos_organization_mappings' THEN 'mapping_state'
        WHEN 'project_ownerships' THEN 'project_ownership'
        WHEN 'organization_credit_grant_expirations' THEN 'credit_expiration'
        WHEN 'stripe_credit_payments' THEN 'stripe_payment'
        WHEN 'stripe_subscription_ends' THEN 'stripe_subscription_end'
        WHEN 'organization_paid_access_events' THEN 'paid_access_event'
        WHEN 'organization_paid_access' THEN 'paid_access'
        WHEN 'stripe_checkout_requests' THEN 'stripe_checkout'
        WHEN 'stripe_recharge_attempts' THEN 'stripe_recharge'
      END;
      IF TG_OP = 'INSERT' THEN
        v_new := NEW.organization_id;
      ELSIF TG_OP = 'DELETE' THEN
        v_old := OLD.organization_id;
      ELSE
        v_old := OLD.organization_id;
        v_new := NEW.organization_id;
      END IF;
      INSERT INTO @S@.credit_maintenance_notices(organization_id, reason)
        SELECT t.org, v_reason FROM (
          SELECT DISTINCT x.org FROM unnest(ARRAY[v_old, v_new]) AS x(org) WHERE x.org IS NOT NULL
        ) t ORDER BY t.org;
      RETURN NULL;
    END
    $body$;`);

  // Every trigger fires for a restore or replication session too (ENABLE ALWAYS), exactly like
  // migrations 184 and 186. The existing append-only and integrity BEFORE triggers are untouched: a
  // row they reject never reaches these AFTER triggers.
  for (const [table, columns] of WAKE_SOURCES) {
    sql(sourceTriggers(table, columns, "credit_maintenance_wake_source", true));
  }
  for (const [table, columns] of NOTICE_SOURCES) {
    sql(sourceTriggers(table, columns, "credit_maintenance_append_notice", true));
  }
  sql(`
    CREATE TRIGGER ${MAPPINGS}_credit_maintenance_insert AFTER INSERT ON @S@.${MAPPINGS}
      FOR EACH ROW EXECUTE FUNCTION @S@.credit_maintenance_append_notice();
    ALTER TABLE @S@.${MAPPINGS} ENABLE ALWAYS TRIGGER ${MAPPINGS}_credit_maintenance_insert;
    CREATE TRIGGER ${MAPPINGS}_credit_maintenance_update AFTER UPDATE ON @S@.${MAPPINGS}
      FOR EACH ROW WHEN (${MAPPING_COLUMNS.map((column) => `OLD.${column} IS DISTINCT FROM NEW.${column}`).join(" OR ")})
      EXECUTE FUNCTION @S@.credit_maintenance_append_notice();
    ALTER TABLE @S@.${MAPPINGS} ENABLE ALWAYS TRIGGER ${MAPPINGS}_credit_maintenance_update;
  `);

  // Default privileges may already grant a runtime role more than it needs, independently of
  // PUBLIC: start from nothing on every new function, table and sequence, then grant the narrow
  // metadata operations only. No DELETE, TRUNCATE or DDL; UPDATE also serves row locks. Notices are
  // inserted by the definer triggers alone, so no role receives INSERT on them, and no role can
  // execute any function here (a trigger function does not check EXECUTE of the writing role).
  for (const signature of PRIVATE_FUNCTIONS) {
    sql(`REVOKE ALL ON FUNCTION @S@.${signature} FROM PUBLIC;`);
  }
  sql(`REVOKE ALL ON ${TABLES.map((table) => `@S@.${table}`).join(", ")} FROM PUBLIC;`);
  sql(
    `DO $sequence$ BEGIN
       EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC',
         pg_get_serial_sequence(format('%I.%I', @L@, 'credit_maintenance_notices'), 'notice_id'));
     END $sequence$;`,
  );
  sql(`DO $grants$
  DECLARE role_name text; function_signature text;
  BEGIN
    FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        FOREACH function_signature IN ARRAY ARRAY[${PRIVATE_FUNCTIONS.map((signature) => `'@S@.${signature}'`).join(", ")}] LOOP
          EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', function_signature, role_name);
        END LOOP;
        EXECUTE format('REVOKE ALL ON ${TABLES.map((table) => `@S@.${table}`).join(", ")} FROM %I', role_name);
        EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I',
          pg_get_serial_sequence(format('%I.%I', @L@, 'credit_maintenance_notices'), 'notice_id'), role_name);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON @S@.credit_maintenance_due TO %I', role_name);
        EXECUTE format('GRANT SELECT, UPDATE ON @S@.credit_maintenance_notices, @S@.credit_maintenance_bootstrap TO %I', role_name);
      END IF;
    END LOOP;
  END $grants$;`);

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
  /** @param {string} definition */
  const sql = (definition) => pgm.sql(inTrustedSchema(definition));
  sql(
    `LOCK TABLE ${ALL_TRIGGER_TABLES.map((table) => `@S@.${table}`).join(", ")} IN SHARE ROW EXCLUSIVE MODE;`,
  );
  sql(`
    DROP TRIGGER ${MAPPINGS}_credit_maintenance_update ON @S@.${MAPPINGS};
    DROP TRIGGER ${MAPPINGS}_credit_maintenance_insert ON @S@.${MAPPINGS};
  `);
  for (const [table] of [...NOTICE_SOURCES, ...WAKE_SOURCES]) {
    sql(`
      DROP TRIGGER ${table}_credit_maintenance_delete ON @S@.${table};
      DROP TRIGGER ${table}_credit_maintenance_update ON @S@.${table};
      DROP TRIGGER ${table}_credit_maintenance_insert ON @S@.${table};
    `);
  }
  sql(`
    DROP FUNCTION @S@.credit_maintenance_append_notice();
    DROP FUNCTION @S@.credit_maintenance_wake_source();
  `);
  for (const [name] of INDEXES) {
    sql(`DROP INDEX @S@.${name};`);
  }
  sql(`
    DROP TABLE @S@.credit_maintenance_bootstrap;
    DROP TABLE @S@.credit_maintenance_notices;
    DROP TABLE @S@.credit_maintenance_due;
    DROP FUNCTION @S@.guard_credit_maintenance_bootstrap_update();
    DROP FUNCTION @S@.guard_credit_maintenance_notice_update();
    DROP FUNCTION @S@.guard_credit_maintenance_due_update();
  `);
  restoreBounds(pgm);
}
