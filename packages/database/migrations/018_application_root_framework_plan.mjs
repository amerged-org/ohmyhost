const CONSTRAINT = "deployment_plans_framework_plan_check";
const SCHEMA_VERSION = "ohmyhost.framework-plan/v2";
const BASE_KEYS = ["adapter", "runtime", "installCommand", "buildCommand", "outputDirectory"];
const EDGE_KEYS = [
  ...BASE_KEYS,
  "serverOutputDirectory",
  "serverEntryPoint",
  "serverConfigPath",
  "compatibilityDate",
  "compatibilityFlags",
];
const CURRENT_BASE_KEYS = [...BASE_KEYS, "schemaVersion", "applicationRoot"];
const CURRENT_EDGE_KEYS = [...EDGE_KEYS, "schemaVersion", "applicationRoot"];

const exactKeys = (keys) => `framework_plan ?& ARRAY[${keys.map((key) => `'${key}'`).join(",")}]
  AND framework_plan - ARRAY[${keys.map((key) => `'${key}'`).join(",")}]='{}'::jsonb`;

const applicationRootCheck = `(
  jsonb_typeof(framework_plan->'applicationRoot')='string'
  AND octet_length(framework_plan->>'applicationRoot')<=64
  AND framework_plan->>'applicationRoot'~'^(\\.|[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*)$'
  AND (framework_plan->>'applicationRoot'='.'
    OR cardinality(string_to_array(framework_plan->>'applicationRoot','/'))<=8)
  AND framework_plan->>'applicationRoot'!~'(^|/)[A-Za-z0-9][A-Za-z0-9._-]{63}($|/)'
)`;

const versionCheck = `(
  jsonb_typeof(framework_plan->'schemaVersion')='string'
  AND framework_plan->>'schemaVersion'='${SCHEMA_VERSION}'
  AND ${applicationRootCheck}
)`;

const staticShape = (keys) => `(
  ${exactKeys(keys)}
  AND framework_plan->>'adapter' IN ('vite-static','tanstack-start')
  AND framework_plan->>'runtime'='static'
  AND length(btrim(framework_plan->>'installCommand'))>0
  AND length(btrim(framework_plan->>'buildCommand'))>0
  AND ((framework_plan->>'adapter'='vite-static' AND framework_plan->>'outputDirectory'='dist')
    OR (framework_plan->>'adapter'='tanstack-start' AND framework_plan->>'outputDirectory'='dist/client'))
)`;

const tanStackEdgeShape = (keys) => `(
  ${exactKeys(keys)}
  AND framework_plan->>'adapter'='tanstack-start'
  AND framework_plan->>'runtime'='edge'
  AND runtime='cloudflare_workers_edge_ssr'
  AND length(btrim(framework_plan->>'installCommand'))>0
  AND length(btrim(framework_plan->>'buildCommand'))>0
  AND framework_plan->>'outputDirectory'='dist/client'
  AND framework_plan->>'serverOutputDirectory'='dist/server'
  AND framework_plan->>'serverEntryPoint'='dist/server/index.js'
  AND framework_plan->>'serverConfigPath'='dist/server/wrangler.json'
  AND framework_plan->>'compatibilityDate'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND framework_plan->>'compatibilityDate'>='2025-04-01'
  AND framework_plan->'compatibilityFlags'='["nodejs_compat"]'::jsonb
)`;

const nextJsEdgeShape = (keys) => `(
  ${exactKeys(keys)}
  AND framework_plan->>'adapter'='nextjs'
  AND framework_plan->>'runtime'='edge'
  AND runtime='cloudflare_workers_edge_ssr'
  AND framework_plan->>'installCommand'='pnpm install --frozen-lockfile'
  AND framework_plan->>'buildCommand'='pnpm build:cloudflare'
  AND framework_plan->>'outputDirectory'='.open-next/assets'
  AND framework_plan->>'serverOutputDirectory'='.ohmyhost-worker'
  AND framework_plan->>'serverEntryPoint'='.ohmyhost-worker/worker.js'
  AND framework_plan->>'serverConfigPath'='wrangler.jsonc'
  AND framework_plan->>'compatibilityDate'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND framework_plan->>'compatibilityDate'>='2024-09-23'
  AND framework_plan->'compatibilityFlags'='["nodejs_compat"]'::jsonb
)`;

const legacyCheck = `(${staticShape(BASE_KEYS)} OR ${tanStackEdgeShape(EDGE_KEYS)} OR ${nextJsEdgeShape(EDGE_KEYS)})`;
const currentCheck = `(${versionCheck} AND (${staticShape(CURRENT_BASE_KEYS)} OR ${tanStackEdgeShape(CURRENT_EDGE_KEYS)} OR ${nextJsEdgeShape(CURRENT_EDGE_KEYS)}))`;

export function up(pgm) {
  pgm.addColumn("aws_build_receipts", {
    input_fingerprint: { type: "bytea" },
    build_claim_id: { type: "text" },
  });
  pgm.addConstraint("aws_build_receipts", "aws_build_receipts_input_fingerprint_check", {
    check: `((input_fingerprint IS NULL AND build_claim_id IS NULL)
      OR (octet_length(input_fingerprint)=32
        AND build_claim_id~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))`,
  });
  pgm.createTable("aws_build_input_reservations", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    input_fingerprint: { type: "bytea", notNull: true },
    claim_id: { type: "text", notNull: true },
    claim_mode: { type: "text", notNull: true },
    claimed_at: { type: "timestamptz", notNull: true },
    lease_expires_at: { type: "timestamptz", notNull: true },
    attempt_number: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    start_allowed_until: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("aws_build_input_reservations", "aws_build_input_reservations_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint("aws_build_input_reservations", "aws_build_input_reservations_claim_id_key", {
    unique: ["claim_id"],
  });
  pgm.addConstraint(
    "aws_build_input_reservations",
    "aws_build_input_reservations_environment_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "environment_id"],
        references: "environments (organization_id, project_id, environment_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint("aws_build_input_reservations", "aws_build_input_reservations_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("aws_build_input_reservations", "aws_build_input_reservations_shape_check", {
    check: `octet_length(input_fingerprint)=32
      AND claim_id~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND claim_mode IN ('start','observe')
      AND attempt_number>0 AND claimed_at>=created_at
      AND lease_expires_at>claimed_at
      AND lease_expires_at<=claimed_at+interval '300 seconds'
      AND start_allowed_until=created_at+interval '4 minutes'
      AND (claim_mode='observe' OR claimed_at<start_allowed_until)`,
  });
  pgm.sql(`CREATE FUNCTION enforce_aws_build_input_reservation_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'aws_build_input_reservations is append-only'
          USING ERRCODE='55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM aws_build_receipts receipt
        WHERE receipt.organization_id=OLD.organization_id
          AND receipt.project_id=OLD.project_id
          AND receipt.environment_id=OLD.environment_id
          AND receipt.operation_id=OLD.operation_id
      ) OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.start_allowed_until IS DISTINCT FROM OLD.start_allowed_until
        OR NEW.claim_id=OLD.claim_id
        OR OLD.lease_expires_at>NEW.claimed_at
        OR NEW.claimed_at<=OLD.claimed_at
        OR NEW.lease_expires_at<=OLD.lease_expires_at
        OR NEW.attempt_number<>OLD.attempt_number+1
        OR (OLD.claim_mode='observe' AND NEW.claim_mode<>'observe')
        OR (NEW.claim_mode='start' AND NEW.claimed_at>=NEW.start_allowed_until) THEN
        RAISE EXCEPTION 'aws_build_input_reservations permits only expired claim renewal'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END
  $$`);
  pgm.createTrigger("aws_build_input_reservations", "aws_build_input_reservations_renewal_guard", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "enforce_aws_build_input_reservation_change",
  });
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: `framework_plan IS NULL OR (
      jsonb_typeof(framework_plan)='object'
      AND (${legacyCheck} OR ${currentCheck})
    )`,
  });
  pgm.sql(`CREATE FUNCTION require_v2_deployment_plan_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.framework_plan IS NOT NULL AND NOT (
        jsonb_typeof(NEW.framework_plan)='object'
        AND NEW.framework_plan->>'schemaVersion'='${SCHEMA_VERSION}'
        AND NEW.framework_plan ? 'applicationRoot'
      ) THEN
        RAISE EXCEPTION 'new deployment plans require a v2 framework plan'
          USING ERRCODE='23514', CONSTRAINT='deployment_plans_framework_plan_insert_v2';
      END IF;
      RETURN NEW;
    END
  $$`);
  pgm.sql(`CREATE TRIGGER deployment_plans_framework_plan_insert_v2
    BEFORE INSERT ON deployment_plans FOR EACH ROW
    EXECUTE FUNCTION require_v2_deployment_plan_insert()`);
}

export function down(pgm) {
  pgm.sql(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM deployment_plans
        WHERE framework_plan ? 'schemaVersion' OR framework_plan ? 'applicationRoot'
      ) THEN
        RAISE EXCEPTION 'v2 deployment plans prevent a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM aws_build_receipts WHERE input_fingerprint IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'fingerprinted AWS build receipts prevent a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
      IF EXISTS (SELECT 1 FROM aws_build_input_reservations) THEN
        RAISE EXCEPTION 'AWS build input reservations prevent a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
    END
  $$`);
  pgm.sql("DROP TRIGGER deployment_plans_framework_plan_insert_v2 ON deployment_plans");
  pgm.sql("DROP FUNCTION require_v2_deployment_plan_insert()");
  pgm.dropTable("aws_build_input_reservations");
  pgm.sql("DROP FUNCTION enforce_aws_build_input_reservation_change()");
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: `framework_plan IS NULL OR (
      jsonb_typeof(framework_plan)='object'
      AND ${legacyCheck}
    )`,
  });
  pgm.dropColumns("aws_build_receipts", ["input_fingerprint", "build_claim_id"]);
}
