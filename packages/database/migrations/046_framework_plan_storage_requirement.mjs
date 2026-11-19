const CONSTRAINT = "deployment_plans_framework_plan_check";
const V4 = "ohmyhost.framework-plan/v4";
const V5 = "ohmyhost.framework-plan/v5";
const BASE_KEYS = ["adapter", "runtime", "installCommand", "buildCommand", "outputDirectory"];
const EDGE_KEYS = [
  ...BASE_KEYS,
  "serverOutputDirectory",
  "serverEntryPoint",
  "serverConfigPath",
  "compatibilityDate",
  "compatibilityFlags",
];
const V4_BASE_KEYS = [
  ...BASE_KEYS,
  "schemaVersion",
  "applicationRoot",
  "runtimePolicy",
  "database",
  "auth",
  "mail",
];
const VERSIONED_KEYS = [
  "schemaVersion",
  "applicationRoot",
  "runtimePolicy",
  "database",
  "auth",
  "mail",
];
const V4_EDGE_KEYS = [...EDGE_KEYS, ...VERSIONED_KEYS];
const V4_CONTAINER_KEYS = [...V4_BASE_KEYS, "serverOutputDirectory", "serverEntryPoint"];
const V5_BASE_KEYS = [...V4_BASE_KEYS, "storage"];
const V5_EDGE_KEYS = [...V4_EDGE_KEYS, "storage"];
const V5_CONTAINER_KEYS = [...V5_BASE_KEYS, "serverOutputDirectory", "serverEntryPoint"];

const exactKeys = (keys) => `framework_plan ?& ARRAY[${keys.map((key) => `'${key}'`).join(",")}]
  AND framework_plan - ARRAY[${keys.map((key) => `'${key}'`).join(",")}]='{}'::jsonb`;
const applicationRootCheck = `(jsonb_typeof(framework_plan->'applicationRoot')='string'
  AND octet_length(framework_plan->>'applicationRoot')<=64
  AND framework_plan->>'applicationRoot'~'^(\\.|[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*)$'
  AND (framework_plan->>'applicationRoot'='.' OR cardinality(string_to_array(framework_plan->>'applicationRoot','/'))<=8)
  AND framework_plan->>'applicationRoot'!~'(^|/)[A-Za-z0-9][A-Za-z0-9._-]{63}($|/)')`;
const staticShape = (keys, storage) => `(${exactKeys(keys)}
  AND framework_plan->>'adapter' IN ('vite-static','tanstack-start')
  AND framework_plan->>'runtime'='static' AND length(btrim(framework_plan->>'installCommand'))>0
  AND length(btrim(framework_plan->>'buildCommand'))>0
  AND ((framework_plan->>'adapter'='vite-static' AND framework_plan->>'outputDirectory'='dist')
    OR (framework_plan->>'adapter'='tanstack-start' AND framework_plan->>'outputDirectory'='dist/client'))
  ${storage ? `AND framework_plan->'storage'='{"enabled":false}'::jsonb` : ""})`;
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
const containerShape = (version, keys, storage) => `(${exactKeys(keys)}
  AND framework_plan->>'schemaVersion'='${version}' AND framework_plan->>'adapter'='nextjs'
  AND framework_plan->>'runtime'='container' AND runtime='cloudflare_containers'
  AND framework_plan->>'installCommand'='pnpm install --frozen-lockfile'
  AND framework_plan->>'buildCommand'='pnpm build' AND framework_plan->>'outputDirectory'='.next/standalone'
  AND framework_plan->>'serverOutputDirectory'='.next/standalone'
  AND framework_plan->>'serverEntryPoint'='.next/standalone/server.js'
  AND framework_plan->'mail'='{"enabled":false}'::jsonb
  ${storage ? `AND framework_plan->'storage'='{"enabled":false}'::jsonb` : ""})`;
const frameworkConstraint = (version, baseKeys, edgeKeys, containerKeys, storage) => `
  framework_plan IS NULL OR (jsonb_typeof(framework_plan)='object'
  AND framework_plan->>'schemaVersion'='${version}' AND ${applicationRootCheck}
  AND valid_runtime_policy(framework_plan->'runtimePolicy')
  AND valid_database_requirement(framework_plan->'database')
  AND valid_customer_auth_requirement(framework_plan->'auth')
  AND valid_mail_requirement(framework_plan->'mail')
  ${storage ? "AND valid_storage_requirement(framework_plan->'storage')" : ""}
  AND ((framework_plan->'auth'->>'provider')='none'
    OR framework_plan->'database'->'enabled'='true'::jsonb)
  AND (${staticShape(baseKeys, storage)} OR ${edgeShape("tanstack-start", edgeKeys)}
    OR ${edgeShape("nextjs", edgeKeys)} OR ${containerShape(version, containerKeys, storage)}))`;

export function up(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
    SELECT 1 FROM deployment_plans
    WHERE framework_plan IS NOT NULL
      AND framework_plan->>'schemaVersion' NOT IN ('${V4}','${V5}')
  ) THEN RAISE EXCEPTION 'obsolete framework plans must be removed before the v5 cutover'
    USING ERRCODE='23514'; END IF; END $$`);
  pgm.sql(`CREATE FUNCTION valid_storage_requirement(requirement jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$ SELECT requirement IN (
      '{"enabled":false}'::jsonb,
      '{"enabled":true,"provider":"r2","jurisdiction":"eu","public":false}'::jsonb
    ) $$`);
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.sql("ALTER TABLE deployment_plans DISABLE TRIGGER deployment_plans_append_only");
  pgm.sql(`UPDATE deployment_plans
    SET framework_plan=framework_plan
      || '{"schemaVersion":"${V5}","storage":{"enabled":false}}'::jsonb
    WHERE framework_plan->>'schemaVersion'='${V4}'`);
  pgm.sql("ALTER TABLE deployment_plans ENABLE TRIGGER deployment_plans_append_only");
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: frameworkConstraint(V5, V5_BASE_KEYS, V5_EDGE_KEYS, V5_CONTAINER_KEYS, true),
  });
  pgm.sql("DROP TRIGGER deployment_plans_framework_plan_insert_v4 ON deployment_plans");
  pgm.sql("DROP FUNCTION require_v4_deployment_plan_insert()");
  pgm.sql(`CREATE FUNCTION require_v5_deployment_plan_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.framework_plan IS NOT NULL AND NOT (
      NEW.framework_plan->>'schemaVersion'='${V5}' AND NEW.framework_plan ? 'applicationRoot'
      AND valid_runtime_policy(NEW.framework_plan->'runtimePolicy')
      AND valid_database_requirement(NEW.framework_plan->'database')
      AND valid_customer_auth_requirement(NEW.framework_plan->'auth')
      AND valid_mail_requirement(NEW.framework_plan->'mail')
      AND valid_storage_requirement(NEW.framework_plan->'storage')
      AND ((NEW.framework_plan->'auth'->>'provider')='none'
        OR NEW.framework_plan->'database'->'enabled'='true'::jsonb)) THEN
      RAISE EXCEPTION 'new deployment plans require the v5 framework plan'
        USING ERRCODE='23514',CONSTRAINT='deployment_plans_framework_plan_insert_v5'; END IF;
    RETURN NEW; END $$`);
  pgm.sql(`CREATE TRIGGER deployment_plans_framework_plan_insert_v5
    BEFORE INSERT ON deployment_plans FOR EACH ROW EXECUTE FUNCTION require_v5_deployment_plan_insert()`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM deployment_plans WHERE framework_plan IS NOT NULL)
    THEN RAISE EXCEPTION 'v5 framework plans prevent a migration downgrade' USING ERRCODE='23514'; END IF; END $$`);
  pgm.sql("DROP TRIGGER deployment_plans_framework_plan_insert_v5 ON deployment_plans");
  pgm.sql("DROP FUNCTION require_v5_deployment_plan_insert()");
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: frameworkConstraint(V4, V4_BASE_KEYS, V4_EDGE_KEYS, V4_CONTAINER_KEYS, false),
  });
  pgm.sql("DROP FUNCTION valid_storage_requirement(jsonb)");
  pgm.sql(`CREATE FUNCTION require_v4_deployment_plan_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.framework_plan IS NOT NULL AND NEW.framework_plan->>'schemaVersion'<>'${V4}' THEN
      RAISE EXCEPTION 'new deployment plans require a v4 framework plan'
        USING ERRCODE='23514',CONSTRAINT='deployment_plans_framework_plan_insert_v4'; END IF;
    RETURN NEW; END $$`);
  pgm.sql(`CREATE TRIGGER deployment_plans_framework_plan_insert_v4
    BEFORE INSERT ON deployment_plans FOR EACH ROW EXECUTE FUNCTION require_v4_deployment_plan_insert()`);
}
