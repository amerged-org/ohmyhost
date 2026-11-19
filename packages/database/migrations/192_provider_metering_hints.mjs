// W24 P-D: durable discovery of provider usage sources (Neon and R2). Every raw observation table
// gets one typed, coalesced HINT table: one row per provider source key (the raw primary key
// without observed_at) that says "re-evaluate the CURRENT latest raw observation of this key".
// A hint stores NO amount, quantity, selected price, rate card or selected Neon meter, and it is
// never authorization to charge: the financial adapter re-reads the canonical raw rows, the
// activation, the billing epoch and the existing valuations under the shared financial locks.
// Nothing here prices, posts, locks a wallet, calls a provider or retires a raw row.
//
// Pointer. latest_observed_at is the ABSOLUTE latest raw observed_at of the key, exactly to the
// microsecond, even when it lies after the business clock (eligibility is decided later, as the
// existing settlers do). It only advances: an older or duplicate observation changes nothing, a
// newer one moves the pointer, advances revision by exactly one, routes the hint to the raw row's
// organization (NULL for platform or unattributed facts, which never make an organization eligible),
// clears obsolete failure scheduling and wakes it now. A hint that already waits keeps its earlier
// due time, so repeated fresh observations cannot postpone it indefinitely.
//
// Triggers. AFTER INSERT ... FOR EACH ROW on both raw tables (ENABLE ALWAYS) create or advance the
// hint in the SAME transaction as the raw row, so a hint is never visible before its observation
// commits and a rollback leaves neither. The trigger function is SECURITY DEFINER with a fixed
// search_path; it is bound to the actual schema and the exact source OID NOW, never to a caller path,
// a trigger argument or a GUC, and it checks the firing relation, operation, timing and level before
// it touches anything. It seeds organization_metering_work (migration 183) with INSERT ... ON
// CONFLICT DO NOTHING BEFORE the hint, so the hint's foreign key holds and an existing organization
// row is never updated. It takes no wallet (C0), no owner row, no organization claim and no source
// advisory lock; it may briefly wait for ONE hint row. Lock order of a raw writer: its own existing
// source advisory lock, then the organization row (insert only), then the hint row. A financial
// transaction takes canonical C0 NO KEY UPDATE first and the hint row last. A raw Neon insert
// already FK-locks its mapping KEY SHARE; legacy FOR UPDATE mapping writers are incompatible and
// must be drained before bootstrap activation. Multi-key metadata producers may deadlock with a
// reverse-order bootstrap page; only their rolled-back metadata transaction can be retried.
//
// Bootstrap. One durable job per raw table scans the raw primary key (including the exact
// observed_at, microseconds kept) in pages of at most 128 RAW rows, probes the actual latest row of
// each distinct source of the page once by primary key and upserts with the same monotonic rule.
// The cursor is the last RAW row scanned, also when its hint already existed. Why it is complete
// (same argument as migrations 184 and 186): LOCK TABLE ... SHARE ROW EXCLUSIVE on both raw tables
// waits out every writer that already inserted and blocks new ones until this transaction commits.
// A raw row is therefore either committed before the triggers exist (the bootstrap scans it by key,
// whatever its commit order was) or inserted after they exist (its trigger covers it, whatever its
// key is, even below the cursor). A sequence, MAX(observed_at) or commit-order watermark would prove
// neither.
//
// Legacy compatibility. Until the full cutover is verified, a released binary can still settle a
// Neon or R2 source with the old functions and post a valuation after a hint was evaluated as
// no-charge. AFTER INSERT on usage_credit_valuations therefore wakes ONLY the exact provider hint(s)
// of that valuation: revision + 1 and due now, pointer, route and failure state untouched. The match
// is the derived column financial_source_reference, the legacy source_reference computed from the
// TYPED key with the exact existing millisecond serialization (filled by a BEFORE INSERT guard, never
// by a caller, and never parsed from the opaque composite). The typed raw key stays the identity.
// Several raw keys can map to one financial reference (timeframe_start differing in microseconds):
// all of them (at most 16, in key order, by index) are woken. A seventeenth match raises a retryable
// source conflict and rolls back the entire posting, preserving every hint and financial fact; no
// arbitrary sibling can silently miss its wake. The wake runs inside the poster's transaction, which already holds
// C0; it takes no second wallet.
//
// Nothing is retired: the downgrade drops derived hint rows and leaves every raw observation and
// valuation untouched. A migration runner may apply several migrations in one transaction.

const FAILURE_CODES = [
  "lock_not_available",
  "statement_canceled",
  "idle_in_transaction_timeout",
  "transaction_timeout",
  "deadlock",
  "read_only_violation",
  "budget_unsupported",
  "connection",
  "invalid_measurement",
  "measurement_conflict",
  "attribution_unresolved",
  "rate_unresolved",
  "activation_unresolved",
  "compute_unresolved",
  "epoch_unresolved",
  "source_ambiguous",
  "unknown",
];
const FAILURE_LIST = FAILURE_CODES.map((code) => `'${code}'`).join(", ");

// The legacy financial reference serializes instants with exactly this form (to_char truncates to
// milliseconds): changing it would change every source identity ever valued.
/** @param {string} expression */
const milliseconds = (expression) =>
  `pg_catalog.to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * @typedef {object} Provider
 * @property {"neon" | "r2"} name
 * @property {string} raw The append-only raw observation table.
 * @property {string} hint The typed hint table.
 * @property {readonly string[]} key Raw primary key columns without observed_at, in key order.
 * @property {string} keyDdl Column definitions of the key; at most as strict as the raw table.
 * @property {(row: string) => string[]} reference Parts of the legacy financial source reference.
 */

/** @type {Provider} */
const NEON = {
  name: "neon",
  raw: "neon_consumption_observations",
  hint: "neon_metering_source_hints",
  key: [
    "provider_organization_id",
    "provider_project_id",
    "period_id",
    "timeframe_start",
    "metric",
  ],
  keyDdl: `provider_organization_id text NOT NULL CHECK (provider_organization_id ~ '^org-[a-z0-9-]{1,56}$'),
      provider_project_id text NOT NULL CHECK (provider_project_id ~ '^[a-z0-9-]{1,60}$'),
      period_id uuid NOT NULL,
      timeframe_start timestamptz NOT NULL,
      metric text NOT NULL CHECK (metric IN ('compute_unit_seconds','root_branch_bytes_month','child_branch_bytes_month','instant_restore_bytes_month','snapshot_storage_bytes_month','public_network_transfer_bytes','private_network_transfer_bytes','extra_branches_month'))`,
  reference: (row) => [
    `${row}.provider_organization_id`,
    `${row}.provider_project_id`,
    `${row}.period_id::text`,
    milliseconds(`${row}.timeframe_start`),
    `${row}.metric`,
  ],
};

/** @type {Provider} */
const R2 = {
  name: "r2",
  raw: "r2_consumption_observations",
  hint: "r2_metering_source_hints",
  key: ["account_id", "bucket_name", "jurisdiction", "timeframe_start", "meter"],
  keyDdl: `account_id text NOT NULL CHECK (account_id ~ '^[0-9a-f]{32}$'),
      bucket_name text NOT NULL CHECK (length(bucket_name) BETWEEN 1 AND 128),
      jurisdiction text NOT NULL CHECK (jurisdiction IN ('eu','us')),
      timeframe_start timestamptz NOT NULL,
      meter text NOT NULL CHECK (meter IN ('r2.storage.standard','r2.storage.observed','r2.class_a','r2.class_b'))`,
  // The legacy R2 reference puts the jurisdiction BEFORE the bucket, unlike the primary key.
  reference: (row) => [
    `${row}.account_id`,
    `${row}.jurisdiction`,
    `${row}.bucket_name`,
    milliseconds(`${row}.timeframe_start`),
    `${row}.meter`,
  ],
};

const PROVIDERS = [NEON, R2];
const BOOTSTRAP = "provider_hint_bootstrap";
const GUARD_FUNCTIONS = [
  "guard_neon_metering_source_hint()",
  "guard_r2_metering_source_hint()",
  "guard_provider_hint_bootstrap_update()",
];
const DEFINER_FUNCTIONS = [
  "record_neon_metering_source_hint()",
  "record_r2_metering_source_hint()",
  "wake_provider_metering_hints()",
];
const HINT_TABLES = PROVIDERS.map((provider) => provider.hint);

// The bootstrap cursor of each job: the raw primary key including observed_at, typed.
const CURSORS = {
  neon: [
    "cursor_provider_organization_id",
    "cursor_provider_project_id",
    "cursor_period_id",
    "cursor_timeframe_start",
    "cursor_metric",
    "cursor_observed_at",
  ],
  r2: [
    "cursor_account_id",
    "cursor_bucket_name",
    "cursor_jurisdiction",
    "cursor_timeframe_start",
    "cursor_meter",
    "cursor_observed_at",
  ],
};

/**
 * @param {Provider} provider
 * @param {string} row
 */
const referenceSql = (provider, row) => provider.reference(row).join(" || '/' || ");

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  // Each pgm.sql is a separate driver query. Arm the limits before any lock is requested, and
  // restore the prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_provider_hint_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_provider_hint_migration_timeouts;
           DROP TABLE pg_temp.w24_provider_hint_migration_timeouts;`);
}

/** @param {Provider} provider */
function hintTableSql(provider) {
  const keys = provider.key.join(", ");
  return `
    CREATE TABLE ${provider.hint} (
      ${provider.keyDdl},
      financial_source_reference text NOT NULL,
      latest_observed_at timestamptz NOT NULL,
      revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
      routed_organization_id ulid REFERENCES organization_metering_work(organization_id),
      available_at timestamptz,
      last_served_at timestamptz,
      attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_failure_code text CHECK (last_failure_code IN (${FAILURE_LIST})),
      evaluated_revision bigint NOT NULL DEFAULT 0 CHECK (evaluated_revision >= 0),
      last_completed_work_id ulid,
      last_completed_valuation_id ulid REFERENCES usage_credit_valuations(valuation_id),
      CONSTRAINT ${provider.hint}_pkey PRIMARY KEY (${keys}),
      -- Bookkeeping can never get ahead of the facts it evaluated.
      CONSTRAINT ${provider.hint}_evaluated_shape CHECK (evaluated_revision <= revision),
      -- Due work exists exactly for a routed hint whose current revision is not yet evaluated:
      -- unrouted facts and evaluated revisions have no schedule.
      CONSTRAINT ${provider.hint}_schedule_shape CHECK (
        (routed_organization_id IS NOT NULL AND evaluated_revision < revision)
        = (available_at IS NOT NULL))
    );
    -- Global due order, oldest first: the sparse-queue probe never walks evaluated history.
    CREATE INDEX ${provider.hint}_due_idx
      ON ${provider.hint} (available_at, routed_organization_id, ${keys})
      WHERE available_at IS NOT NULL;
    -- Fair order of one organization's pending hints (readProviderHint, LIMIT 1).
    CREATE INDEX ${provider.hint}_organization_idx
      ON ${provider.hint} (routed_organization_id, available_at, ${keys})
      WHERE available_at IS NOT NULL;
    -- Exact wake of the legacy valuation trigger: the derived financial reference, in key order.
    CREATE INDEX ${provider.hint}_financial_idx
      ON ${provider.hint} (financial_source_reference, ${keys})
      WHERE routed_organization_id IS NOT NULL;
  `;
}

/**
 * Invoker rights, fixed search_path, no table reference. INSERT derives the financial reference
 * from the typed key (a caller value is overwritten). UPDATE keeps identity immutable, the pointer
 * monotonic and the revision a counter that grows by exactly one per pointer or route change.
 * @param {Provider} provider
 */
function guardFunctionSql(provider) {
  const identity = [...provider.key, "financial_source_reference"]
    .map((column) => `NEW.${column} IS DISTINCT FROM OLD.${column}`)
    .join("\n        OR ");
  return `
    CREATE FUNCTION guard_${provider.name}_metering_source_hint() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.financial_source_reference := ${referenceSql(provider, "NEW")};
        RETURN NEW;
      END IF;
      IF ${identity} THEN
        RAISE EXCEPTION 'Provider source hint identity is immutable' USING ERRCODE = '55000';
      END IF;
      IF NEW.latest_observed_at < OLD.latest_observed_at THEN
        RAISE EXCEPTION 'The provider hint pointer only advances' USING ERRCODE = '55000';
      END IF;
      IF NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1
        OR (NEW.latest_observed_at > OLD.latest_observed_at AND NEW.revision = OLD.revision)
        OR (NEW.routed_organization_id IS DISTINCT FROM OLD.routed_organization_id
          AND NEW.revision = OLD.revision) THEN
        RAISE EXCEPTION 'The provider hint revision grows by one with every pointer or route change'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.evaluated_revision < OLD.evaluated_revision THEN
        RAISE EXCEPTION 'The evaluated provider hint revision never decreases'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ${provider.hint}_guard BEFORE INSERT OR UPDATE ON ${provider.hint}
      FOR EACH ROW EXECUTE FUNCTION guard_${provider.name}_metering_source_hint();
    ALTER TABLE ${provider.hint} ENABLE ALWAYS TRIGGER ${provider.hint}_guard;
  `;
}

/** @param {"neon" | "r2"} job */
function bootstrapRow(job) {
  const own = CURSORS[job];
  const other = CURSORS[job === "neon" ? "r2" : "neon"].filter((column) => !own.includes(column));
  const unset = own.map((column) => `${column} IS NULL`).join(" AND ");
  const set = own.map((column) => `${column} IS NOT NULL`).join(" AND ");
  const foreign = other.map((column) => `${column} IS NULL`).join(" AND ");
  return `(job = '${job}' AND ${foreign} AND ((${unset}) OR (${set})))`;
}

/**
 * @param {"neon" | "r2"} job
 * @param {string} prefix
 */
function cursorRow(job, prefix) {
  return `ROW(${CURSORS[job].map((column) => `${prefix}.${column}`).join(", ")})`;
}

/**
 * The format() template of one raw-table trigger function: %1$I is the schema, %2$s the exact
 * source OID. The body holds no percent sign.
 * @param {Provider} provider
 */
function recordFunctionTemplate(provider) {
  const keys = provider.key.join(", ");
  const values = provider.key.map((column) => `NEW.${column}`).join(", ");
  return `
        CREATE FUNCTION %1$I.record_${provider.name}_metering_source_hint() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
        DECLARE
          v_now timestamptz := pg_catalog.clock_timestamp();
        BEGIN
          IF TG_RELID IS DISTINCT FROM %2$s::pg_catalog.oid
            OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
            RAISE EXCEPTION 'Invalid provider hint trigger source' USING ERRCODE = '55000';
          END IF;
          IF NEW.organization_id IS NOT NULL THEN
            INSERT INTO %1$I.organization_metering_work(organization_id)
              VALUES (NEW.organization_id) ON CONFLICT (organization_id) DO NOTHING;
          END IF;
          INSERT INTO %1$I.${provider.hint} AS hint(${keys}, latest_observed_at,
              routed_organization_id, available_at)
            VALUES (${values}, NEW.observed_at, NEW.organization_id,
              CASE WHEN NEW.organization_id IS NULL THEN NULL ELSE v_now END)
            ON CONFLICT (${keys}) DO UPDATE SET
              latest_observed_at = EXCLUDED.latest_observed_at,
              revision = hint.revision + 1,
              routed_organization_id = EXCLUDED.routed_organization_id,
              available_at = CASE WHEN EXCLUDED.routed_organization_id IS NULL THEN NULL
                ELSE LEAST(COALESCE(hint.available_at, EXCLUDED.available_at), EXCLUDED.available_at) END,
              attempts = 0,
              last_failure_code = NULL
            WHERE hint.latest_observed_at < EXCLUDED.latest_observed_at;
          RETURN NULL;
        END;
        $body$;
      `;
}

/**
 * One bounded statement per provider: lock at most 17 matching hints in key order. Wake all of them
 * only when there are at most 16; otherwise reject the entire financial transaction explicitly.
 * @param {Provider} provider
 */
function wakeStatement(provider) {
  const keys = provider.key.join(", ");
  const matches = provider.key.map((column) => `hint.${column} = matched.${column}`).join(" AND ");
  return `
            WITH matched AS MATERIALIZED (
              SELECT ${keys} FROM %1$I.${provider.hint}
              WHERE financial_source_reference = NEW.source_reference
                AND routed_organization_id IS NOT NULL
              ORDER BY ${keys}
              LIMIT 17
              FOR NO KEY UPDATE
            ), woken AS (
            UPDATE %1$I.${provider.hint} AS hint
              SET revision = hint.revision + 1,
                available_at = LEAST(COALESCE(hint.available_at, v_now), v_now)
              FROM matched WHERE ${matches} AND (SELECT count(*) FROM matched) <= 16
              RETURNING 1
            )
            SELECT count(*) INTO v_matching FROM matched;
            IF v_matching > 16 THEN
              RAISE EXCEPTION 'Provider financial source matches too many raw source keys'
                USING ERRCODE = '40001';
            END IF;`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);

  // The definer functions qualify every relation by one schema, so the sources, the work table,
  // the hints and the valuations must share it.
  pgm.sql(`DO $check$ BEGIN
    IF (SELECT count(DISTINCT relation.relnamespace) FROM pg_catalog.pg_class relation
        WHERE relation.oid IN (
          'neon_consumption_observations'::pg_catalog.regclass,
          'r2_consumption_observations'::pg_catalog.regclass,
          'usage_credit_valuations'::pg_catalog.regclass,
          'organization_metering_work'::pg_catalog.regclass)) <> 1 THEN
      RAISE EXCEPTION 'Provider metering hints require every source table in one schema';
    END IF;
  END $check$;`);

  for (const provider of PROVIDERS) pgm.sql(hintTableSql(provider));

  pgm.sql(`
    -- One durable fixed job per raw table. A page is ONE transaction under this row's lock, so a
    -- crashed page leaves no state and needs no lease; the cursor is the last RAW key scanned.
    CREATE TABLE ${BOOTSTRAP} (
      job text PRIMARY KEY CHECK (job IN ('neon', 'r2')),
      cursor_provider_organization_id text,
      cursor_provider_project_id text,
      cursor_period_id uuid,
      cursor_account_id text,
      cursor_bucket_name text,
      cursor_jurisdiction text,
      cursor_timeframe_start timestamptz,
      cursor_metric text,
      cursor_meter text,
      cursor_observed_at timestamptz,
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      scanned bigint NOT NULL DEFAULT 0 CHECK (scanned >= 0),
      last_served_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT ${BOOTSTRAP}_cursor_shape CHECK (${bootstrapRow("neon")} OR ${bootstrapRow("r2")})
    );
    INSERT INTO ${BOOTSTRAP}(job) VALUES ('neon'), ('r2');

    -- Completion is terminal, the identity never changes, counters never decrease and the cursor
    -- only moves forward in raw primary-key order. Invoker rights and a fixed search_path.
    CREATE FUNCTION guard_provider_hint_bootstrap_update() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF OLD.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'A completed provider hint bootstrap is terminal' USING ERRCODE = '55000';
      END IF;
      IF NEW.job IS DISTINCT FROM OLD.job THEN
        RAISE EXCEPTION 'Provider hint bootstrap identity is immutable' USING ERRCODE = '55000';
      END IF;
      IF NEW.generation < OLD.generation OR NEW.scanned < OLD.scanned THEN
        RAISE EXCEPTION 'Provider hint bootstrap counters never decrease' USING ERRCODE = '55000';
      END IF;
      IF OLD.cursor_observed_at IS NOT NULL AND (NEW.cursor_observed_at IS NULL
        OR CASE OLD.job
          WHEN 'neon' THEN ${cursorRow("neon", "NEW")} < ${cursorRow("neon", "OLD")}
          ELSE ${cursorRow("r2", "NEW")} < ${cursorRow("r2", "OLD")} END) THEN
        RAISE EXCEPTION 'The provider hint bootstrap cursor only moves forward'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ${BOOTSTRAP}_guard BEFORE UPDATE ON ${BOOTSTRAP}
      FOR EACH ROW EXECUTE FUNCTION guard_provider_hint_bootstrap_update();
    ALTER TABLE ${BOOTSTRAP} ENABLE ALWAYS TRIGGER ${BOOTSTRAP}_guard;
  `);

  for (const provider of PROVIDERS) pgm.sql(guardFunctionSql(provider));

  // Fence every raw and valuation writer first: pre-trigger writes finish (or this migration fails
  // within the budget with 55P03 and installs nothing), later ones wait for the commit.
  pgm.sql(
    `LOCK TABLE ${NEON.raw}, ${R2.raw}, usage_credit_valuations IN SHARE ROW EXCLUSIVE MODE;`,
  );

  // The only writers of hints besides the bootstrap. Definer rights let an old collector or
  // settlement role fire them without any privilege on a hint table; the source and the target are
  // bound to the actual schema and exact source OIDs NOW. A trigger attached to any other relation
  // fails the source check before touching a hint.
  pgm.sql(`
    DO $install$
    DECLARE
      source_schema text;
      neon_oid oid := 'neon_consumption_observations'::pg_catalog.regclass::pg_catalog.oid;
      r2_oid oid := 'r2_consumption_observations'::pg_catalog.regclass::pg_catalog.oid;
      valuation_oid oid := 'usage_credit_valuations'::pg_catalog.regclass::pg_catalog.oid;
    BEGIN
      SELECT namespace.nspname INTO STRICT source_schema
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE relation.oid = neon_oid;
      EXECUTE pg_catalog.format($definition$${recordFunctionTemplate(NEON)}$definition$,
        source_schema, neon_oid);
      EXECUTE pg_catalog.format($definition$${recordFunctionTemplate(R2)}$definition$,
        source_schema, r2_oid);
      EXECUTE pg_catalog.format($definition$
        CREATE FUNCTION %1$I.wake_provider_metering_hints() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
        DECLARE
          v_now timestamptz := pg_catalog.clock_timestamp();
          v_matching integer;
        BEGIN
          IF TG_RELID IS DISTINCT FROM %2$s::pg_catalog.oid
            OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
            RAISE EXCEPTION 'Invalid provider hint wake trigger source' USING ERRCODE = '55000';
          END IF;
          IF NEW.source_kind = 'neon' THEN${wakeStatement(NEON)}
          ELSIF NEW.source_kind = 'r2' THEN${wakeStatement(R2)}
          END IF;
          RETURN NULL;
        END;
        $body$;
      $definition$, source_schema, valuation_oid);
    END $install$;
  `);

  // Every trigger fires for a restore or replication session too (ENABLE ALWAYS), exactly like
  // migrations 184 and 186. The existing append-only BEFORE triggers are untouched: a row they
  // reject never reaches these AFTER triggers.
  for (const provider of PROVIDERS) {
    pgm.sql(`
      CREATE TRIGGER ${provider.raw}_metering_hint AFTER INSERT ON ${provider.raw}
        FOR EACH ROW EXECUTE FUNCTION record_${provider.name}_metering_source_hint();
      ALTER TABLE ${provider.raw} ENABLE ALWAYS TRIGGER ${provider.raw}_metering_hint;
    `);
  }
  pgm.sql(`
    CREATE TRIGGER usage_credit_valuations_provider_hint_wake AFTER INSERT ON usage_credit_valuations
      FOR EACH ROW WHEN (NEW.source_kind IN ('neon', 'r2'))
      EXECUTE FUNCTION wake_provider_metering_hints();
    ALTER TABLE usage_credit_valuations
      ENABLE ALWAYS TRIGGER usage_credit_valuations_provider_hint_wake;
  `);

  // Default privileges may already grant any role more than it needs, independently of PUBLIC:
  // strip EVERY non-owner grant of the new objects, then grant the metadata API explicitly to the
  // runtime roles that exist. The initial operator-provisioned roles may not exist yet; the future
  // baseline must grant the same set. No DELETE, TRUNCATE, DDL or function EXECUTE for a runtime
  // role: UPDATE also serves row locks, hints are inserted by the definer triggers and the
  // bootstrap, and the definer functions run only as triggers.
  pgm.sql(`
    DO $acl$
    DECLARE
      object_name text;
      holder text;
      role_name text;
    BEGIN
      FOREACH object_name IN ARRAY ARRAY[${[...HINT_TABLES, BOOTSTRAP].map((table) => `'${table}'`).join(", ")}] LOOP
        FOR holder IN
          SELECT DISTINCT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
          FROM pg_catalog.pg_class relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) AS acl
          WHERE relation.oid = pg_catalog.to_regclass(object_name)::pg_catalog.oid
            AND acl.grantee <> relation.relowner
        LOOP
          EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I FROM %s', object_name, holder);
        END LOOP;
      END LOOP;
      FOREACH object_name IN ARRAY ARRAY[${[...GUARD_FUNCTIONS, ...DEFINER_FUNCTIONS].map((signature) => `'${signature}'`).join(", ")}] LOOP
        FOR holder IN
          SELECT DISTINCT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
          FROM pg_catalog.pg_proc routine
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) AS acl
          WHERE routine.oid = pg_catalog.to_regprocedure(object_name)::pg_catalog.oid
            AND acl.grantee <> routine.proowner
        LOOP
          EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s', object_name, holder);
        END LOOP;
      END LOOP;
      FOREACH role_name IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
          EXECUTE pg_catalog.format('GRANT SELECT, INSERT, UPDATE ON TABLE %I, %I TO %I',
            '${NEON.hint}', '${R2.hint}', role_name);
          EXECUTE pg_catalog.format('GRANT SELECT, UPDATE ON TABLE %I TO %I', '${BOOTSTRAP}', role_name);
        END IF;
      END LOOP;
    END $acl$;
  `);

  restoreBounds(pgm);
}

/**
 * Hints and bootstrap rows are derived scheduling metadata that the triggers and the bootstrap
 * rebuild; no financial fact lives in them. The downgrade drops them without a retention guard and
 * leaves every raw observation, valuation and ledger entry untouched.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
export function down(pgm) {
  boundDdl(pgm);
  pgm.sql(
    `LOCK TABLE ${NEON.raw}, ${R2.raw}, usage_credit_valuations IN SHARE ROW EXCLUSIVE MODE;`,
  );
  pgm.sql(`
    DROP TRIGGER usage_credit_valuations_provider_hint_wake ON usage_credit_valuations;
    DROP TRIGGER ${NEON.raw}_metering_hint ON ${NEON.raw};
    DROP TRIGGER ${R2.raw}_metering_hint ON ${R2.raw};
    DROP FUNCTION wake_provider_metering_hints();
    DROP FUNCTION record_neon_metering_source_hint();
    DROP FUNCTION record_r2_metering_source_hint();
    DROP TABLE ${NEON.hint};
    DROP TABLE ${R2.hint};
    DROP TABLE ${BOOTSTRAP};
    DROP FUNCTION guard_neon_metering_source_hint();
    DROP FUNCTION guard_r2_metering_source_hint();
    DROP FUNCTION guard_provider_hint_bootstrap_update();
  `);
  restoreBounds(pgm);
}
