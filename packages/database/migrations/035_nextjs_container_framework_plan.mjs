const CONSTRAINT = "deployment_plans_framework_plan_check";
const V2 = "ohmyhost.framework-plan/v2";
const V3 = "ohmyhost.framework-plan/v3";
const BASE_KEYS = ["adapter", "runtime", "installCommand", "buildCommand", "outputDirectory"];
const EDGE_KEYS = [
  ...BASE_KEYS,
  "serverOutputDirectory",
  "serverEntryPoint",
  "serverConfigPath",
  "compatibilityDate",
  "compatibilityFlags",
];
const V2_BASE_KEYS = [
  ...BASE_KEYS,
  "schemaVersion",
  "applicationRoot",
  "runtimePolicy",
  "database",
];
const V2_EDGE_KEYS = [
  ...EDGE_KEYS,
  "schemaVersion",
  "applicationRoot",
  "runtimePolicy",
  "database",
];
const V3_BASE_KEYS = [...V2_BASE_KEYS, "auth"];
const V3_EDGE_KEYS = [...V2_EDGE_KEYS, "auth"];
const V3_CONTAINER_KEYS = [...V3_BASE_KEYS, "serverOutputDirectory", "serverEntryPoint"];

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
const containerShape = `(${exactKeys(V3_CONTAINER_KEYS)}
  AND framework_plan->>'schemaVersion'='${V3}'
  AND framework_plan->>'adapter'='nextjs' AND framework_plan->>'runtime'='container'
  AND runtime='cloudflare_containers'
  AND framework_plan->>'installCommand'='pnpm install --frozen-lockfile'
  AND framework_plan->>'buildCommand'='pnpm build'
  AND framework_plan->>'outputDirectory'='.next/standalone'
  AND framework_plan->>'serverOutputDirectory'='.next/standalone'
  AND framework_plan->>'serverEntryPoint'='.next/standalone/server.js')`;
const applicationRootCheck = `(jsonb_typeof(framework_plan->'applicationRoot')='string'
  AND octet_length(framework_plan->>'applicationRoot')<=64
  AND framework_plan->>'applicationRoot'~'^(\\.|[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*)$'
  AND (framework_plan->>'applicationRoot'='.' OR cardinality(string_to_array(framework_plan->>'applicationRoot','/'))<=8)
  AND framework_plan->>'applicationRoot'!~'(^|/)[A-Za-z0-9][A-Za-z0-9._-]{63}($|/)')`;
const legacyCheck = `(${staticShape(BASE_KEYS)} OR ${edgeShape("tanstack-start", EDGE_KEYS)} OR ${edgeShape("nextjs", EDGE_KEYS)})`;
const versionedCheck = (version, baseKeys, edgeKeys, auth, extraShape = "") => `(
  framework_plan->>'schemaVersion'='${version}' AND ${applicationRootCheck}
  AND valid_runtime_policy(framework_plan->'runtimePolicy')
  AND valid_database_requirement(framework_plan->'database')
  ${auth ? "AND valid_customer_auth_requirement(framework_plan->'auth') AND ((framework_plan->'auth'->>'provider')='none' OR framework_plan->'database'->'enabled'='true'::jsonb)" : ""}
  AND (${staticShape(baseKeys)} OR ${edgeShape("tanstack-start", edgeKeys)} OR ${edgeShape("nextjs", edgeKeys)}${extraShape}))`;
const previousConstraint = `framework_plan IS NULL OR (jsonb_typeof(framework_plan)='object' AND (
  ${legacyCheck} OR ${versionedCheck(V2, V2_BASE_KEYS, V2_EDGE_KEYS, false)}
  OR ${versionedCheck(V3, V3_BASE_KEYS, V3_EDGE_KEYS, true)}))`;

export function up(pgm) {
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: `framework_plan IS NULL OR (jsonb_typeof(framework_plan)='object' AND (
      ${legacyCheck} OR ${versionedCheck(V2, V2_BASE_KEYS, V2_EDGE_KEYS, false)}
      OR ${versionedCheck(V3, V3_BASE_KEYS, V3_EDGE_KEYS, true, ` OR ${containerShape}`)}))`,
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
    SELECT 1 FROM deployment_plans WHERE framework_plan->>'runtime'='container'
  ) THEN RAISE EXCEPTION 'container deployment plans prevent a lossless migration downgrade'
    USING ERRCODE='23514'; END IF; END $$`);
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, { check: previousConstraint });
}
