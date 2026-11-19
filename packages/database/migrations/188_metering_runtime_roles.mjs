// W24 188: the narrow base grants of the metering_runtime login and the durable, receipted owner
// handoff of the financial lane. No statement here creates or alters a role, a password or a
// membership (the grants only check whether the role exists), and nothing prices, posts or locks a
// wallet.
//
// 1. Base grants (metering-runtime-base/v1). The policy is closed and lists every object by name:
//    ledger appends, the grace lifecycle, row locks that need an UPDATE privilege on one column
//    only, and read access to the facts the ledger functions read. The direct rights of
//    metering_runtime on exactly these objects, and on the unused 184/186/187 discovery and expiry
//    objects, are reset first and then granted again from this list. control_runtime, PUBLIC,
//    default privileges and every object outside the lists are untouched; there is no wildcard,
//    no GRANT ... ALL TABLES, no membership and no grant option. The migration follows the
//    convention of 183-187: an absent role is skipped, which makes the schema usable but means
//    "unprovisioned", never ready. The role is created and verified by the provisioning step
//    BEFORE the full W24 suffix is applied; a role created afterwards owns none of these rights.
//    Function EXECUTE is never granted here: trigger functions run without the writer's EXECUTE
//    right, and the projection, expiry and discovery entry points belong to the additive grant
//    migration of the final composed runtime.
//
//    The 187 expiry cache is part of the base's authoritative balance and lot reads. Its three
//    tables retain SELECT only; expiry build/publish entry points stay withheld until the composed
//    maintenance policy explicitly grants them.
//
// 2. A BEFORE UPDATE guard on the real mapping table rejects every actual UPDATE when current_user
//    OR session_user is metering_runtime (also through a definer function), for owner-created
//    broken fixtures as much as for ordinary organizations. A row lock does not fire it.
//
// 3. metering_owner_activation_receipts and activate_metering_owner(): one owner-only, append-only
//    receipt per successful control->metering or metering->control transition, written atomically
//    with the compare-and-swap of the owner row. The receipt ATTESTS evidence that the authenticated
//    owner connection supplied (artifact digests, readiness observation, CI receipt digests). The
//    database never contacts Cloudflare or CI and does not claim that any provider fact is true; a
//    release script verifies those facts before it opens the transaction.
//
// Errors are closed: message metering_owner_<code>, fixed SQLSTATE MO4xx/MO5xx.

export const METERING_RUNTIME_BASE_POLICY_VERSION = "metering-runtime-base/v1";
export const METERING_OWNER_EVIDENCE_SCHEMA = "metering-owner-activation-evidence/v1";
/** A new operation needs readiness evidence that is at most this old and at most 5 s ahead. */
export const METERING_OWNER_EVIDENCE_MAX_AGE_SECONDS = 120;
export const METERING_OWNER_EVIDENCE_FUTURE_SKEW_SECONDS = 5;

/** Closed failure codes of the owner operation and their SQLSTATE. */
export const METERING_OWNER_ACTIVATION_FAILURES = Object.freeze({
  invalid_request: "MO400",
  invalid_evidence: "MO401",
  authority_required: "MO403",
  owner_conflict: "MO409",
  operation_conflict: "MO410",
  epoch_overflow: "MO411",
  evidence_oversize: "MO413",
  evidence_stale: "MO422",
  evidence_mismatch: "MO423",
  budget_required: "MO428",
  owner_unavailable: "MO500",
});

/** @param {keyof typeof METERING_OWNER_ACTIVATION_FAILURES} code */
const raise = (code) =>
  `RAISE EXCEPTION 'metering_owner_${code}' USING ERRCODE = '${METERING_OWNER_ACTIVATION_FAILURES[code]}';`;

const RUNTIME_ROLE = "metering_runtime";

/** @param {readonly string[]} values */
const list = (values) => values.map((value) => `'${value}'`).join(", ");

const APPEND_ONLY_TABLES = [
  "organization_credit_grants",
  "organization_credit_grant_adjustments",
  "organization_credit_movements",
  "organization_credit_reservations",
  "organization_credit_resolutions",
  "usage_credit_valuations",
];

const GRACE_TABLE = "organization_credit_grace_periods";

// [table, the only columns on which UPDATE is granted]. PostgreSQL requires UPDATE on at least one
// column for SELECT ... FOR [NO KEY] UPDATE/SHARE; no table-level UPDATE is granted anywhere.
/** @type {ReadonlyArray<readonly [string, readonly string[]]>} */
const ROW_LOCK_TABLES = [
  ["metering_lane_owner", ["lane"]],
  ["workos_organization_mappings", ["organization_id"]],
  ["organization_credit_wallets", ["organization_id"]],
  [
    "organization_metering_work",
    [
      "generation",
      "last_served_at",
      "claim_owner",
      "claim_token",
      "claim_epoch",
      "claimed_at",
      "lease_until",
    ],
  ],
  [
    "metering_cohort_work",
    [
      "available_at",
      "attempts",
      "last_failure_stage",
      "last_failure_code",
      "completed_at",
      "completed_valuation_id",
    ],
  ],
];

const READ_ONLY_TABLES = [
  "published_credit_rate_cards",
  "billing_epochs",
  "environments",
  "stripe_credit_payments",
  "stripe_subscription_ends",
  "stripe_checkout_requests",
  "stripe_recharge_attempts",
  "organization_paid_access",
  "organization_paid_access_events",
  "organization_credit_grant_expirations",
  "credit_projection_state",
  "credit_projection_builds",
  "credit_lot_totals",
  "credit_org_exposure",
  "credit_project_outstanding",
  "credit_project_period_totals",
  "credit_expiry_state",
  "credit_expiry_builds",
  "credit_expiry_lots",
];

// Reset and never granted: the build markers of a projection generation.
const WITHHELD_TABLES = ["credit_projection_build_applied"];

// Capabilities that 184, 186 and 187 gave metering_runtime when it existed: unused by the base.
const UNUSED_TABLES = [
  "wfp_batch_discovery",
  "metering_discovery_backfills",
  "wfp_discovery_cohort_plan",
  "lifetime_resource_work",
  "lifetime_resource_sources",
  "lifetime_day_hints",
  "lifetime_dirty_notices",
  "lifetime_discovery_bootstrap",
];

const ALL_TABLES = [
  ...APPEND_ONLY_TABLES,
  GRACE_TABLE,
  ...ROW_LOCK_TABLES.map(([table]) => table),
  ...READ_ONLY_TABLES,
  ...WITHHELD_TABLES,
  ...UNUSED_TABLES,
];

// No application function EXECUTE for the base. These are the 182-187 functions whose direct
// metering_runtime rights are reset: guards and producers (run by their triggers without any
// EXECUTE right), the private 185 and 187 helpers and the entry points of 185 and 187.
const DENIED_FUNCTIONS = [
  "create_organization_credit_wallet()",
  "reject_metering_lane_owner_update()",
  "guard_metering_cohort_work_update()",
  "enqueue_wfp_batch_discovery()",
  "guard_wfp_batch_discovery_update()",
  "reject_wfp_discovery_cohort_plan_update()",
  "guard_metering_discovery_backfill_update()",
  "credit_projection_cleanup(text,text,integer)",
  "credit_projection_activate(text,text,text)",
  "credit_projection_advance(text,text,integer)",
  "credit_projection_start(text,text,text)",
  "credit_projection_create_state()",
  "credit_projection_apply_source()",
  "credit_projection_lock_source()",
  "credit_projection_contribute(text,text,text,text,boolean)",
  "credit_projection_lock_organization(text)",
  "append_lifetime_notice()",
  "guard_lifetime_dirty_notice_update()",
  "guard_lifetime_day_hint_update()",
  "guard_lifetime_discovery_bootstrap_update()",
  "guard_lifetime_resource_work_update()",
  "guard_lifetime_resource_source_update()",
  "credit_expiry_start(text,text,text)",
  "credit_expiry_advance(text,text,integer)",
  "credit_expiry_publish(text,text,text)",
  "credit_expiry_cleanup(text,text,integer)",
  "credit_expiry_lock_organization(text)",
  "credit_expiry_invalidate_source()",
  "credit_expiry_create_state()",
  "credit_expiry_guard_state()",
  "credit_expiry_guard_build()",
];

// The functions this migration creates: private to the owner, revoked from PUBLIC and both runtimes.
const OWN_FUNCTIONS = [
  "reject_metering_runtime_mapping_update()",
  "reject_metering_owner_activation_receipt_change()",
  "read_metering_owner_activation(uuid)",
  "activate_metering_owner(uuid,text,bigint,text,jsonb)",
];

// The closed evidence envelope (version 1): the key set of every object and the pattern of every
// string. "$" is the root object. Digests are lowercase SHA-256 hex; identifiers are safe names.
const HEX64 = "^[0-9a-f]{64}$";
const IDENTIFIER = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
// Versioned name of a policy, such as metering-runtime-base/v1.
const POLICY_VERSION = "^[a-z][a-z0-9.-]{0,31}/v[0-9]{1,3}$";
const INSTANT = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$";
const ARTIFACT_KEYS = ["name", "version", "artifact_sha256"];

const EVIDENCE_KEYS = {
  $: [
    "schema",
    "environment",
    "source_commit",
    "release_manifest_sha256",
    "schema_prerequisite_sha256",
    "permission_policy",
    "executor",
    "scheduler",
    "control",
    "readiness",
    "ci",
  ],
  permission_policy: ["version", "sha256"],
  executor: ARTIFACT_KEYS,
  scheduler: ARTIFACT_KEYS,
  control: ARTIFACT_KEYS,
  readiness: ["status", "role", "database", "owner", "observation_sha256", "checked_at"],
  ci: ["source_receipt_sha256", "acceptance_receipt_sha256"],
};

/**
 * @param {string} part
 * @returns {Array<readonly [readonly string[], string]>}
 */
const artifactFields = (part) => [
  [[part, "name"], IDENTIFIER],
  [[part, "version"], IDENTIFIER],
  [[part, "artifact_sha256"], HEX64],
];

/** @type {ReadonlyArray<readonly [readonly string[], string]>} */
const EVIDENCE_FIELDS = [
  [["schema"], `^${METERING_OWNER_EVIDENCE_SCHEMA}$`],
  [["environment"], "^(development|production)$"],
  [["source_commit"], "^[0-9a-f]{40}$"],
  [["release_manifest_sha256"], HEX64],
  [["schema_prerequisite_sha256"], HEX64],
  [["permission_policy", "version"], POLICY_VERSION],
  [["permission_policy", "sha256"], HEX64],
  ...artifactFields("executor"),
  ...artifactFields("scheduler"),
  ...artifactFields("control"),
  [["readiness", "status"], "^ready$"],
  [["readiness", "role"], "^metering_runtime$"],
  [["readiness", "database"], IDENTIFIER],
  [["readiness", "owner"], "^(control|metering)$"],
  [["readiness", "observation_sha256"], HEX64],
  [["readiness", "checked_at"], INSTANT],
  [["ci", "source_receipt_sha256"], HEX64],
  [["ci", "acceptance_receipt_sha256"], HEX64],
];

const FIELD_ROWS = EVIDENCE_FIELDS.map(
  ([path, pattern]) => "('{" + path.join(",") + "}'::text[], '" + pattern + "'::text)",
).join(",\n        ");

// Every SECURITY INVOKER function and trigger is created through this wrapper. @S@ becomes the
// quoted schema the migration runner selected (never a caller-shadowable name) and @L@ the same
// name as a literal: every relation in a body is qualified by it and the function's own search_path
// is only pg_catalog (then pg_temp last), so neither the caller's search_path nor a temporary table
// can substitute anything, in public or in a test schema.
const TRUSTED_SCHEMA = "pg_catalog.current_schema()";

/** @param {string} definition */
const inTrustedSchema = (definition) => `DO $install$ BEGIN
  EXECUTE replace(replace($definition$${definition}$definition$,
    '@S@', quote_ident(${TRUSTED_SCHEMA})), '@L@', quote_literal(${TRUSTED_SCHEMA}));
END $install$;`;

const FIXED_PATH = "SET search_path = pg_catalog, pg_temp";

const PREREQUISITES = `DO $prerequisites$
DECLARE
  v_schema text := pg_catalog.current_schema();
  v_name text;
  v_signature text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[${list(ALL_TABLES)}] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class relation
      WHERE relation.oid = pg_catalog.to_regclass(pg_catalog.format('%I.%I', v_schema, v_name))
        AND relation.relkind IN ('r', 'p')
    ) THEN
      RAISE EXCEPTION 'The metering runtime base requires the W24 tables in the migration schema';
    END IF;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[${list(DENIED_FUNCTIONS)}] LOOP
    IF pg_catalog.to_regprocedure(pg_catalog.format('%I.%s', v_schema, v_signature)) IS NULL THEN
      RAISE EXCEPTION 'The metering runtime base requires the W24 functions in the migration schema';
    END IF;
  END LOOP;
END $prerequisites$;`;

const RECEIPT_TABLE = `
    -- One immutable receipt per successful transition. Native typed columns; evidence is the
    -- complete small envelope and evidence_sha256 its digest, computed by the database over the
    -- canonical jsonb text, so the authoritative bytes are never discarded.
    CREATE TABLE @S@.metering_owner_activation_receipts (
      operation_id uuid NOT NULL,
      lane text NOT NULL,
      expected_owner text NOT NULL,
      expected_epoch bigint NOT NULL,
      next_owner text NOT NULL,
      next_epoch bigint NOT NULL,
      environment text NOT NULL,
      source_commit text NOT NULL,
      release_manifest_sha256 bytea NOT NULL,
      evidence jsonb NOT NULL,
      evidence_sha256 bytea NOT NULL,
      recorded_at timestamptz NOT NULL,
      actor_role text NOT NULL,
      CONSTRAINT metering_owner_activation_receipts_pkey PRIMARY KEY (operation_id),
      CONSTRAINT metering_owner_activation_receipts_operation_check
        CHECK (operation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
      CONSTRAINT metering_owner_activation_receipts_lane_check CHECK (lane = 'financial'),
      CONSTRAINT metering_owner_activation_receipts_owners_check CHECK (
        expected_owner IN ('control', 'metering') AND next_owner IN ('control', 'metering')
        AND expected_owner <> next_owner),
      CONSTRAINT metering_owner_activation_receipts_epoch_check
        CHECK (expected_epoch > 0 AND next_epoch = expected_epoch + 1),
      CONSTRAINT metering_owner_activation_receipts_environment_check
        CHECK (environment IN ('development', 'production')),
      CONSTRAINT metering_owner_activation_receipts_source_check
        CHECK (source_commit ~ '^[0-9a-f]{40}$'),
      CONSTRAINT metering_owner_activation_receipts_digest_check CHECK (
        octet_length(release_manifest_sha256) = 32 AND octet_length(evidence_sha256) = 32),
      CONSTRAINT metering_owner_activation_receipts_evidence_check CHECK (
        jsonb_typeof(evidence) = 'object'
        AND octet_length(convert_to(evidence::text, 'UTF8')) <= 16384
        AND evidence_sha256 = sha256(convert_to(evidence::text, 'UTF8'))),
      CONSTRAINT metering_owner_activation_receipts_actor_check
        CHECK (actor_role = btrim(actor_role) AND length(actor_role) BETWEEN 1 AND 63)
    );`;

// Rejects UPDATE, DELETE and TRUNCATE for every role including the owner. ENABLE ALWAYS keeps it in
// force for restore and replication sessions too.
const RECEIPT_GUARD = `
    CREATE FUNCTION @S@.reject_metering_owner_activation_receipt_change() RETURNS trigger
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      RAISE EXCEPTION 'metering_owner_activation_receipt_immutable' USING ERRCODE = '55000';
    END
    $body$;
    CREATE TRIGGER metering_owner_activation_receipts_immutable BEFORE UPDATE OR DELETE
      ON @S@.metering_owner_activation_receipts FOR EACH ROW
      EXECUTE FUNCTION @S@.reject_metering_owner_activation_receipt_change();
    CREATE TRIGGER metering_owner_activation_receipts_retain BEFORE TRUNCATE
      ON @S@.metering_owner_activation_receipts FOR EACH STATEMENT
      EXECUTE FUNCTION @S@.reject_metering_owner_activation_receipt_change();
    ALTER TABLE @S@.metering_owner_activation_receipts
      ENABLE ALWAYS TRIGGER metering_owner_activation_receipts_immutable;
    ALTER TABLE @S@.metering_owner_activation_receipts
      ENABLE ALWAYS TRIGGER metering_owner_activation_receipts_retain;`;

// One snapshot of the historical operation receipt and the current lane, both bound to this
// migration's persistent namespace. A temporary relation cannot forge the current owner observed
// by the TypeScript readback. The receipt member is NULL when the operation has no receipt.
// Invoker rights: only the owner has EXECUTE and SELECT on the private receipt table.
const READ_FUNCTION = `
    CREATE FUNCTION @S@.read_metering_owner_activation(p_operation_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE ${FIXED_PATH} AS $body$
      SELECT jsonb_build_object(
        'receipt', (SELECT jsonb_build_object(
        'operation_id', r.operation_id::text,
        'lane', r.lane,
        'expected_owner', r.expected_owner,
        'expected_epoch', r.expected_epoch::text,
        'next_owner', r.next_owner,
        'next_epoch', r.next_epoch::text,
        'environment', r.environment,
        'source_commit', r.source_commit,
        'release_manifest_sha256', encode(r.release_manifest_sha256, 'hex'),
        'evidence', r.evidence,
        'evidence_sha256', encode(r.evidence_sha256, 'hex'),
        'recorded_at', to_char(r.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'actor_role', r.actor_role)
      FROM @S@.metering_owner_activation_receipts r
      WHERE r.operation_id = p_operation_id),
        'current', jsonb_build_object('owner', owner_row.owner, 'epoch', owner_row.epoch::text))
      FROM @S@.metering_lane_owner owner_row WHERE owner_row.lane = 'financial'
    $body$;`;

// ONE bounded transaction step with no remote call: the owner row lock, the receipt lookup, the
// compare-and-swap of owner and epoch and the receipt insert. It takes no wallet, mapping,
// organization or task lock. The caller must have armed finite lock, statement and transaction
// timeouts (checked below); a lock wait on a runtime's owner SHARE therefore ends in 55P03.
const ACTIVATE_FUNCTION = `
    CREATE FUNCTION @S@.activate_metering_owner(
      p_operation_id uuid, p_expected_owner text, p_expected_epoch bigint,
      p_next_owner text, p_evidence jsonb
    ) RETURNS jsonb
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    DECLARE
      v_authorized boolean;
      v_lock_ms bigint;
      v_statement_ms bigint;
      v_transaction_ms bigint;
      v_name text;
      v_path text[];
      v_pattern text;
      v_expected jsonb;
      v_keys text[];
      v_found text[];
      v_part jsonb;
      v_environment text;
      v_source_commit text;
      v_manifest text;
      v_checked_text text;
      v_checked_at timestamptz;
      v_digest bytea;
      v_owner text;
      v_epoch bigint;
      v_receipt @S@.metering_owner_activation_receipts%ROWTYPE;
      v_next_epoch bigint;
    BEGIN
      -- Authority: the authenticated session itself must own the lane table and the receipt table.
      -- Neither EXECUTE, a runtime membership nor a caller-set setting is proof of it.
      SELECT count(*) = 2 AND bool_and(holder.rolname = current_user) INTO v_authorized
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_roles holder ON holder.oid = relation.relowner
        WHERE relation.oid IN (
          pg_catalog.to_regclass(pg_catalog.format('%I.%I', @L@, 'metering_lane_owner'))::pg_catalog.oid,
          pg_catalog.to_regclass(pg_catalog.format('%I.%I', @L@, 'metering_owner_activation_receipts'))::pg_catalog.oid);
      IF v_authorized IS NOT TRUE OR session_user IS DISTINCT FROM current_user
        OR current_user IN ('metering_runtime', 'control_runtime') THEN
        ${raise("authority_required")}
      END IF;

      -- Finite budgets are a precondition, not a convention: PostgreSQL 18 and transaction_timeout.
      SELECT
        (SELECT s.setting::bigint FROM pg_catalog.pg_settings s WHERE s.name = 'lock_timeout'),
        (SELECT s.setting::bigint FROM pg_catalog.pg_settings s WHERE s.name = 'statement_timeout'),
        (SELECT s.setting::bigint FROM pg_catalog.pg_settings s WHERE s.name = 'transaction_timeout')
        INTO v_lock_ms, v_statement_ms, v_transaction_ms;
      IF pg_catalog.current_setting('server_version_num')::integer < 180000
        OR v_lock_ms IS NULL OR v_lock_ms < 1 OR v_lock_ms > 500
        OR v_statement_ms IS NULL OR v_statement_ms < 1 OR v_statement_ms > 2000
        OR v_transaction_ms IS NULL OR v_transaction_ms < 1 OR v_transaction_ms > 5000 THEN
        ${raise("budget_required")}
      END IF;

      IF p_operation_id IS NULL OR p_expected_owner IS NULL OR p_next_owner IS NULL
        OR p_expected_epoch IS NULL OR p_evidence IS NULL
        OR p_operation_id = '00000000-0000-0000-0000-000000000000'::uuid
        OR substr(p_operation_id::text, 15, 1) NOT IN ('4', '7')
        OR substr(p_operation_id::text, 20, 1) NOT IN ('8', '9', 'a', 'b')
        OR p_expected_owner NOT IN ('control', 'metering')
        OR p_next_owner NOT IN ('control', 'metering')
        OR p_expected_owner = p_next_owner
        OR p_expected_epoch < 1 THEN
        ${raise("invalid_request")}
      END IF;

      -- The closed evidence envelope: cardinality and bytes first, then every key set, then every
      -- string against its pattern. Nothing is echoed back.
      IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN
        ${raise("invalid_evidence")}
      END IF;
      IF pg_catalog.pg_column_size(p_evidence) > 32768
        OR pg_catalog.octet_length(pg_catalog.convert_to(p_evidence::text, 'UTF8')) > 16384 THEN
        ${raise("evidence_oversize")}
      END IF;
      FOR v_name, v_expected IN
        SELECT s.key, s.value FROM jsonb_each('${JSON.stringify(EVIDENCE_KEYS)}'::jsonb) AS s
      LOOP
        v_part := CASE WHEN v_name = '$' THEN p_evidence ELSE p_evidence -> v_name END;
        IF jsonb_typeof(v_part) IS DISTINCT FROM 'object' THEN
          ${raise("invalid_evidence")}
        END IF;
        v_keys := ARRAY(SELECT jsonb_array_elements_text(v_expected));
        v_found := ARRAY(SELECT jsonb_object_keys(v_part));
        IF pg_catalog.cardinality(v_found) <> pg_catalog.cardinality(v_keys)
          OR NOT (v_found <@ v_keys) THEN
          ${raise("invalid_evidence")}
        END IF;
      END LOOP;
      FOR v_path, v_pattern IN
        SELECT f.path, f.pattern FROM (VALUES
        ${FIELD_ROWS}
        ) AS f(path, pattern)
      LOOP
        IF jsonb_typeof(p_evidence #> v_path) IS DISTINCT FROM 'string'
          OR (p_evidence #>> v_path) !~ v_pattern THEN
          ${raise("invalid_evidence")}
        END IF;
      END LOOP;
      v_checked_text := p_evidence #>> '{readiness,checked_at}';
      BEGIN
        v_checked_at := v_checked_text::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        ${raise("invalid_evidence")}
      END;
      IF pg_catalog.to_char(v_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        <> v_checked_text THEN
        ${raise("invalid_evidence")}
      END IF;
      v_environment := p_evidence ->> 'environment';
      v_source_commit := p_evidence ->> 'source_commit';
      v_manifest := p_evidence ->> 'release_manifest_sha256';
      v_digest := pg_catalog.sha256(pg_catalog.convert_to(p_evidence::text, 'UTF8'));

      -- Serialize on the one owner row. A handoff waits for earlier owner mutations and for every
      -- financial transaction that holds the owner row FOR SHARE.
      SELECT o.owner, o.epoch INTO v_owner, v_epoch
        FROM @S@.metering_lane_owner o WHERE o.lane = 'financial' FOR UPDATE;
      IF NOT FOUND THEN
        ${raise("owner_unavailable")}
      END IF;

      -- The receipt comes first: an operation that already committed replays its ORIGINAL receipt,
      -- also past the freshness window and after a later handoff. Any changed field conflicts.
      SELECT * INTO v_receipt FROM @S@.metering_owner_activation_receipts r
        WHERE r.operation_id = p_operation_id;
      IF FOUND THEN
        IF v_receipt.expected_owner = p_expected_owner AND v_receipt.expected_epoch = p_expected_epoch
          AND v_receipt.next_owner = p_next_owner AND v_receipt.environment = v_environment
          AND v_receipt.source_commit = v_source_commit
          AND v_receipt.release_manifest_sha256 = pg_catalog.decode(v_manifest, 'hex')
          AND v_receipt.evidence = p_evidence AND v_receipt.evidence_sha256 = v_digest THEN
          RETURN jsonb_build_object(
            'replay', true,
            'receipt', @S@.read_metering_owner_activation(p_operation_id) -> 'receipt',
            'current', jsonb_build_object('owner', v_owner, 'epoch', v_epoch::text));
        END IF;
        ${raise("operation_conflict")}
      END IF;

      -- A new operation: fresh evidence about THIS database, then the exact owner and epoch.
      IF (p_evidence #>> '{readiness,owner}') <> p_expected_owner THEN
        ${raise("evidence_mismatch")}
      END IF;
      IF v_checked_at < clock_timestamp() - interval '${METERING_OWNER_EVIDENCE_MAX_AGE_SECONDS} seconds'
        OR v_checked_at > clock_timestamp() + interval '${METERING_OWNER_EVIDENCE_FUTURE_SKEW_SECONDS} seconds' THEN
        ${raise("evidence_stale")}
      END IF;
      IF (p_evidence #>> '{readiness,database}') IS DISTINCT FROM current_database()::text THEN
        ${raise("evidence_mismatch")}
      END IF;
      IF v_owner <> p_expected_owner OR v_epoch <> p_expected_epoch THEN
        ${raise("owner_conflict")}
      END IF;
      IF p_expected_epoch = 9223372036854775807 THEN
        ${raise("epoch_overflow")}
      END IF;

      UPDATE @S@.metering_lane_owner SET owner = p_next_owner, epoch = epoch + 1
        WHERE lane = 'financial' AND owner = p_expected_owner AND epoch = p_expected_epoch
        RETURNING epoch INTO v_next_epoch;
      IF NOT FOUND THEN
        ${raise("owner_conflict")}
      END IF;
      INSERT INTO @S@.metering_owner_activation_receipts(operation_id, lane, expected_owner,
        expected_epoch, next_owner, next_epoch, environment, source_commit, release_manifest_sha256,
        evidence, evidence_sha256, recorded_at, actor_role)
      VALUES (p_operation_id, 'financial', p_expected_owner, p_expected_epoch, p_next_owner,
        v_next_epoch, v_environment, v_source_commit, pg_catalog.decode(v_manifest, 'hex'),
        p_evidence, v_digest, clock_timestamp(), session_user::text);
      RETURN jsonb_build_object(
        'replay', false,
        'receipt', @S@.read_metering_owner_activation(p_operation_id) -> 'receipt',
        'current', jsonb_build_object('owner', p_next_owner, 'epoch', v_next_epoch::text));
    END
    $body$;`;

// The runtime login must never move a tenant identity. Row locks do not fire an UPDATE trigger, so
// the C0 lock protocol is unaffected; any actual UPDATE by the login, or by a definer function the
// login called, fails. The role name is the policy constant; no setting can switch the guard off.
const MAPPING_GUARD = `
    CREATE FUNCTION @S@.reject_metering_runtime_mapping_update() RETURNS trigger
    LANGUAGE plpgsql ${FIXED_PATH} AS $body$
    BEGIN
      IF current_user = 'metering_runtime' OR session_user = 'metering_runtime' THEN
        RAISE EXCEPTION 'metering_runtime_mapping_update_denied' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END
    $body$;
    CREATE TRIGGER workos_organization_mappings_metering_runtime_guard BEFORE UPDATE
      ON @S@.workos_organization_mappings FOR EACH ROW
      EXECUTE FUNCTION @S@.reject_metering_runtime_mapping_update();
    ALTER TABLE @S@.workos_organization_mappings
      ENABLE ALWAYS TRIGGER workos_organization_mappings_metering_runtime_guard;`;

// Default privileges may already grant PUBLIC or a runtime role more than it needs: the new private
// objects start from nothing for PUBLIC and for both known runtime roles.
const PRIVATE_OBJECTS = `DO $private$
DECLARE
  v_schema text := pg_catalog.current_schema();
  v_role text;
  v_signature text;
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON TABLE %I.metering_owner_activation_receipts FROM PUBLIC', v_schema);
  FOREACH v_signature IN ARRAY ARRAY[${list(OWN_FUNCTIONS)}] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', v_schema, v_signature);
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON TABLE %I.metering_owner_activation_receipts FROM %I', v_schema, v_role);
      FOREACH v_signature IN ARRAY ARRAY[${list(OWN_FUNCTIONS)}] LOOP
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.%s FROM %I',
          v_schema, v_signature, v_role);
      END LOOP;
    END IF;
  END LOOP;
END $private$;`;

// Reset, then grant: the direct rights of metering_runtime on the listed objects only. REVOKE ALL on
// a table also removes the direct column privileges and grant options of that role. PUBLIC grants,
// other roles and objects outside the lists are not touched, so the provisioning audit still has to
// look at effective privileges. An absent role is skipped: schema-only, unprovisioned.
const RUNTIME_GRANTS = `DO $grants$
DECLARE
  v_schema text := pg_catalog.current_schema();
  v_role constant text := '${RUNTIME_ROLE}';
  v_name text;
  v_signature text;
  v_sequence text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
    FOREACH v_name IN ARRAY ARRAY[${list(ALL_TABLES)}] LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I.%I FROM %I', v_schema, v_name, v_role);
    END LOOP;
    v_sequence := pg_catalog.pg_get_serial_sequence(
      pg_catalog.format('%I.%I', v_schema, 'lifetime_dirty_notices'), 'notice_id');
    IF v_sequence IS NOT NULL THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON SEQUENCE %s FROM %I', v_sequence, v_role);
    END IF;
    FOREACH v_signature IN ARRAY ARRAY[${list(DENIED_FUNCTIONS)}] LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.%s FROM %I', v_schema, v_signature, v_role);
    END LOOP;

    FOREACH v_name IN ARRAY ARRAY[${list(APPEND_ONLY_TABLES)}] LOOP
      EXECUTE pg_catalog.format('GRANT SELECT, INSERT ON TABLE %I.%I TO %I', v_schema, v_name, v_role);
    END LOOP;
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, DELETE ON TABLE %I.%I TO %I', v_schema, '${GRACE_TABLE}', v_role);
    FOREACH v_name IN ARRAY ARRAY[${list(READ_ONLY_TABLES)}] LOOP
      EXECUTE pg_catalog.format('GRANT SELECT ON TABLE %I.%I TO %I', v_schema, v_name, v_role);
    END LOOP;
${ROW_LOCK_TABLES.map(
  ([
    table,
    columns,
  ]) => `    EXECUTE pg_catalog.format('GRANT SELECT ON TABLE %I.%I TO %I', v_schema, '${table}', v_role);
    EXECUTE pg_catalog.format(
      'GRANT UPDATE (${columns.join(", ")}) ON TABLE %I.%I TO %I', v_schema, '${table}', v_role);`,
).join("\n")}
  END IF;
END $grants$;`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  // Each pgm.sql is a separate driver query. Arm the lock and statement limits before any DDL, and
  // restore the prior settings because a runner can apply several migrations in one transaction.
  pgm.sql(`CREATE TEMP TABLE w24_owner_migration_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout;`);
  pgm.sql("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';");
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
                 set_config('statement_timeout',statement_timeout,true)
           FROM pg_temp.w24_owner_migration_timeouts;
           DROP TABLE pg_temp.w24_owner_migration_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);
  pgm.sql(PREREQUISITES);
  pgm.sql(inTrustedSchema(RECEIPT_TABLE));
  pgm.sql(inTrustedSchema(RECEIPT_GUARD));
  pgm.sql(inTrustedSchema(READ_FUNCTION));
  pgm.sql(inTrustedSchema(ACTIVATE_FUNCTION));
  pgm.sql(inTrustedSchema(MAPPING_GUARD));
  pgm.sql(PRIVATE_OBJECTS);
  pgm.sql(RUNTIME_GRANTS);
  restoreBounds(pgm);
}

/**
 * Refuses once any receipt exists or the lane is not pristine (control, epoch 1): the receipts are
 * audit evidence and the lane is never rewound. The login is retained. The guard-dependent mapping
 * UPDATE column grant is revoked before its guard is removed; unrelated grants stay unchanged.
 * A reviewed forward migration is the recovery path after the handoff was used.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
export function down(pgm) {
  boundDdl(pgm);
  pgm.sql(
    inTrustedSchema(`
    DO $guard$ BEGIN
      IF EXISTS (SELECT 1 FROM @S@.metering_owner_activation_receipts)
        OR (SELECT count(*) FROM @S@.metering_lane_owner) <> 1
        OR NOT EXISTS (SELECT 1 FROM @S@.metering_lane_owner
          WHERE lane = 'financial' AND owner = 'control' AND epoch = 1) THEN
        RAISE EXCEPTION 'Metering owner activation receipts and the lane state must be retained before downgrade';
      END IF;
      -- Do not remove the identity guard while leaving its otherwise dangerous row-lock grant.
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'metering_runtime') THEN
        EXECUTE pg_catalog.format(
          'REVOKE UPDATE (organization_id) ON TABLE %I.workos_organization_mappings FROM metering_runtime', @L@);
      END IF;
    END $guard$;
    DROP TRIGGER workos_organization_mappings_metering_runtime_guard
      ON @S@.workos_organization_mappings;
    DROP FUNCTION @S@.reject_metering_runtime_mapping_update();
    DROP TABLE @S@.metering_owner_activation_receipts;
    DROP FUNCTION @S@.activate_metering_owner(uuid,text,bigint,text,jsonb);
    DROP FUNCTION @S@.read_metering_owner_activation(uuid);
    DROP FUNCTION @S@.reject_metering_owner_activation_receipt_change();`),
  );
  restoreBounds(pgm);
}
