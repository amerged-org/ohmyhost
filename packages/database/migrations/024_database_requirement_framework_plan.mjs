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
const PREVIOUS_BASE_KEYS = [...BASE_KEYS, "schemaVersion", "applicationRoot", "runtimePolicy"];
const PREVIOUS_EDGE_KEYS = [...EDGE_KEYS, "schemaVersion", "applicationRoot", "runtimePolicy"];
const CURRENT_BASE_KEYS = [...PREVIOUS_BASE_KEYS, "database"];
const CURRENT_EDGE_KEYS = [...PREVIOUS_EDGE_KEYS, "database"];

const exactKeys = (keys) => `framework_plan ?& ARRAY[${keys.map((key) => `'${key}'`).join(",")}]
  AND framework_plan - ARRAY[${keys.map((key) => `'${key}'`).join(",")}]='{}'::jsonb`;
const staticShape = (
  keys,
) => `(${exactKeys(keys)} AND framework_plan->>'adapter' IN ('vite-static','tanstack-start')
  AND framework_plan->>'runtime'='static' AND length(btrim(framework_plan->>'installCommand'))>0
  AND length(btrim(framework_plan->>'buildCommand'))>0
  AND ((framework_plan->>'adapter'='vite-static' AND framework_plan->>'outputDirectory'='dist')
    OR (framework_plan->>'adapter'='tanstack-start' AND framework_plan->>'outputDirectory'='dist/client')))`;
const edgeShape = (
  adapter,
  keys,
) => `(${exactKeys(keys)} AND framework_plan->>'adapter'='${adapter}'
  AND framework_plan->>'runtime'='edge' AND runtime='cloudflare_workers_edge_ssr'
  AND framework_plan->>'installCommand'='pnpm install --frozen-lockfile'
  AND framework_plan->>'buildCommand'${adapter === "nextjs" ? "='pnpm build:cloudflare'" : "<>''"}
  AND framework_plan->>'outputDirectory'='${adapter === "nextjs" ? ".open-next/assets" : "dist/client"}'
  AND framework_plan->>'serverOutputDirectory'='${adapter === "nextjs" ? ".ohmyhost-worker" : "dist/server"}'
  AND framework_plan->>'serverEntryPoint'='${adapter === "nextjs" ? ".ohmyhost-worker/worker.js" : "dist/server/index.js"}'
  AND framework_plan->>'serverConfigPath'='${adapter === "nextjs" ? "wrangler.jsonc" : "dist/server/wrangler.json"}'
  AND framework_plan->>'compatibilityDate'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND framework_plan->>'compatibilityDate'>='${adapter === "nextjs" ? "2024-09-23" : "2025-04-01"}'
  AND framework_plan->'compatibilityFlags'='["nodejs_compat"]'::jsonb)`;
const applicationRootCheck = `(jsonb_typeof(framework_plan->'applicationRoot')='string'
  AND octet_length(framework_plan->>'applicationRoot')<=64
  AND framework_plan->>'applicationRoot'~'^(\\.|[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*)$'
  AND (framework_plan->>'applicationRoot'='.' OR cardinality(string_to_array(framework_plan->>'applicationRoot','/'))<=8)
  AND framework_plan->>'applicationRoot'!~'(^|/)[A-Za-z0-9][A-Za-z0-9._-]{63}($|/)')`;
const legacyCheck = `(${staticShape(BASE_KEYS)} OR ${edgeShape("tanstack-start", EDGE_KEYS)} OR ${edgeShape("nextjs", EDGE_KEYS)})`;
const currentCheck = (
  baseKeys,
  edgeKeys,
  database,
) => `(framework_plan->>'schemaVersion'='${SCHEMA_VERSION}'
  AND ${applicationRootCheck} AND valid_runtime_policy(framework_plan->'runtimePolicy')
  ${database ? "AND valid_database_requirement(framework_plan->'database')" : ""}
  AND (${staticShape(baseKeys)} OR ${edgeShape("tanstack-start", edgeKeys)} OR ${edgeShape("nextjs", edgeKeys)}))`;

export function up(pgm) {
  pgm.sql(`CREATE FUNCTION valid_database_requirement(requirement jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
      IF jsonb_typeof(requirement)<>'object' THEN RETURN false; END IF;
      IF requirement='{"enabled":false}'::jsonb THEN RETURN true; END IF;
      RETURN requirement ?& ARRAY['enabled','migrations']
        AND requirement-ARRAY['enabled','migrations']='{}'::jsonb
        AND requirement->'enabled'='true'::jsonb
        AND jsonb_typeof(requirement->'migrations')='string'
        AND length(requirement->>'migrations') BETWEEN 1 AND 512
        AND requirement->>'migrations'!~'^/' AND requirement->>'migrations'!~'[\\:]'
        AND NOT (string_to_array(requirement->>'migrations','/') && ARRAY['..']);
    EXCEPTION WHEN OTHERS THEN RETURN false; END $$`);
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: `framework_plan IS NULL OR (jsonb_typeof(framework_plan)='object' AND (${legacyCheck} OR ${currentCheck(CURRENT_BASE_KEYS, CURRENT_EDGE_KEYS, true)}))`,
  });
  pgm.sql(`CREATE OR REPLACE FUNCTION require_v2_deployment_plan_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.framework_plan IS NOT NULL AND NOT (NEW.framework_plan->>'schemaVersion'='${SCHEMA_VERSION}'
      AND NEW.framework_plan ? 'applicationRoot' AND valid_runtime_policy(NEW.framework_plan->'runtimePolicy')
      AND valid_database_requirement(NEW.framework_plan->'database')) THEN
      RAISE EXCEPTION 'new deployment plans require a v2 framework plan with runtime policy and database requirement'
        USING ERRCODE='23514', CONSTRAINT='deployment_plans_framework_plan_insert_v2'; END IF;
    RETURN NEW; END $$`);
  pgm.dropConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
  );
  pgm.addConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
    {
      check: `attempt_number BETWEEN 0 AND 5
        AND observation_kind IN ('uncertainty','preflight','execution_failure')
        AND event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1')
        AND accepted_lifecycle_version>0 AND octet_length(evidence_sha256)=32
        AND hint_phase IN ('source','build','database','runtime-secrets','gateway','wfp')
        AND (expected_artifact_sha256 IS NULL OR octet_length(expected_artifact_sha256)=32)
        AND source_state IN ('unknown','absent','ready','succeeded','running','failed','cleanup_failable')
        AND build_state IN ('unknown','absent','ready','succeeded','running','failed','cleanup_failable')
        AND gateway_state IN ('unknown','absent','ready') AND wfp_state IN ('unknown','absent','ready')
        AND ((gateway_state='ready' AND gateway_provider_tag IS NOT NULL)
          OR (gateway_state='absent' AND gateway_provider_tag IS NULL) OR gateway_state='unknown')
        AND ((wfp_state='ready' AND wfp_provider_tag IS NOT NULL
              AND wfp_product_deployment_id IS NOT NULL AND octet_length(wfp_artifact_sha256)=32)
          OR (wfp_state='absent' AND wfp_provider_tag IS NULL
              AND wfp_product_deployment_id IS NULL AND wfp_artifact_sha256 IS NULL)
          OR wfp_state='unknown')
        AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
    },
  );
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM deployment_plans WHERE framework_plan ? 'database') THEN
    RAISE EXCEPTION 'database-requirement deployment plans prevent a lossless migration downgrade' USING ERRCODE='23514'; END IF; END $$`);
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.sql("DROP FUNCTION valid_database_requirement(jsonb)");
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: `framework_plan IS NULL OR (jsonb_typeof(framework_plan)='object' AND (${legacyCheck} OR ${currentCheck(PREVIOUS_BASE_KEYS, PREVIOUS_EDGE_KEYS, false)}))`,
  });
  pgm.sql(`CREATE OR REPLACE FUNCTION require_v2_deployment_plan_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.framework_plan IS NOT NULL AND NOT (NEW.framework_plan->>'schemaVersion'='${SCHEMA_VERSION}'
      AND NEW.framework_plan ? 'applicationRoot' AND valid_runtime_policy(NEW.framework_plan->'runtimePolicy')) THEN
      RAISE EXCEPTION 'new deployment plans require a v2 framework plan with runtime policy'
        USING ERRCODE='23514', CONSTRAINT='deployment_plans_framework_plan_insert_v2'; END IF;
    RETURN NEW; END $$`);
  pgm.dropConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
  );
  pgm.addConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
    {
      check: `attempt_number BETWEEN 0 AND 5
        AND observation_kind IN ('uncertainty','preflight','execution_failure')
        AND event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1')
        AND accepted_lifecycle_version>0 AND octet_length(evidence_sha256)=32
        AND hint_phase IN ('source','build','runtime-secrets','gateway','wfp')
        AND (expected_artifact_sha256 IS NULL OR octet_length(expected_artifact_sha256)=32)
        AND source_state IN ('unknown','absent','ready','succeeded','running','failed','cleanup_failable')
        AND build_state IN ('unknown','absent','ready','succeeded','running','failed','cleanup_failable')
        AND gateway_state IN ('unknown','absent','ready') AND wfp_state IN ('unknown','absent','ready')
        AND ((gateway_state='ready' AND gateway_provider_tag IS NOT NULL)
          OR (gateway_state='absent' AND gateway_provider_tag IS NULL) OR gateway_state='unknown')
        AND ((wfp_state='ready' AND wfp_provider_tag IS NOT NULL
              AND wfp_product_deployment_id IS NOT NULL AND octet_length(wfp_artifact_sha256)=32)
          OR (wfp_state='absent' AND wfp_provider_tag IS NULL
              AND wfp_product_deployment_id IS NULL AND wfp_artifact_sha256 IS NULL)
          OR wfp_state='unknown')
        AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
    },
  );
}
