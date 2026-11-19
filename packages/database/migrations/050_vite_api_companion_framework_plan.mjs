const CONSTRAINT = "deployment_plans_framework_plan_check";
const V5 = "ohmyhost.framework-plan/v5";
const BASE_KEYS = [
  "adapter",
  "runtime",
  "installCommand",
  "buildCommand",
  "outputDirectory",
  "schemaVersion",
  "applicationRoot",
  "runtimePolicy",
  "database",
  "auth",
  "mail",
  "storage",
];
const EDGE_KEYS = [
  ...BASE_KEYS,
  "serverOutputDirectory",
  "serverEntryPoint",
  "serverConfigPath",
  "compatibilityDate",
  "compatibilityFlags",
];
const CONTAINER_KEYS = [...BASE_KEYS, "serverOutputDirectory", "serverEntryPoint"];

const exactKeys = (keys) => `framework_plan ?& ARRAY[${keys.map((key) => `'${key}'`).join(",")}]
  AND framework_plan - ARRAY[${keys.map((key) => `'${key}'`).join(",")}]='{}'::jsonb`;
const applicationRootCheck = `(jsonb_typeof(framework_plan->'applicationRoot')='string'
  AND octet_length(framework_plan->>'applicationRoot')<=64
  AND framework_plan->>'applicationRoot'~'^(\\.|[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*)$'
  AND (framework_plan->>'applicationRoot'='.' OR cardinality(string_to_array(framework_plan->>'applicationRoot','/'))<=8)
  AND framework_plan->>'applicationRoot'!~'(^|/)[A-Za-z0-9][A-Za-z0-9._-]{63}($|/)')`;
const staticShape = `(${exactKeys(BASE_KEYS)}
  AND framework_plan->>'adapter' IN ('vite-static','tanstack-start')
  AND framework_plan->>'runtime'='static' AND length(btrim(framework_plan->>'installCommand'))>0
  AND length(btrim(framework_plan->>'buildCommand'))>0
  AND ((framework_plan->>'adapter'='vite-static' AND framework_plan->>'outputDirectory'='dist')
    OR (framework_plan->>'adapter'='tanstack-start' AND framework_plan->>'outputDirectory'='dist/client'))
  AND framework_plan->'storage'='{"enabled":false}'::jsonb)`;
const edgeShape = (adapter) => {
  const vite = adapter === "vite-static";
  const next = adapter === "nextjs";
  return `(${exactKeys(EDGE_KEYS)} AND framework_plan->>'adapter'='${adapter}'
    AND framework_plan->>'runtime'='edge' AND runtime='cloudflare_workers_edge_ssr'
    AND framework_plan->>'installCommand'='pnpm install --frozen-lockfile'
    AND framework_plan->>'buildCommand'${next ? "='pnpm build:cloudflare'" : "='pnpm build'"}
    AND framework_plan->>'outputDirectory'='${vite ? "dist" : next ? ".open-next/assets" : "dist/client"}'
    AND framework_plan->>'serverOutputDirectory'='${vite ? ".ohmyhost/vite-companion" : next ? ".ohmyhost-worker" : "dist/server"}'
    AND framework_plan->>'serverEntryPoint'='${vite ? ".ohmyhost/vite-companion/worker.js" : next ? ".ohmyhost-worker/worker.js" : "dist/server/index.js"}'
    AND framework_plan->>'serverConfigPath'='${vite ? ".ohmyhost/vite-companion/wrangler.jsonc" : next ? "wrangler.jsonc" : "dist/server/wrangler.json"}'
    AND framework_plan->>'compatibilityDate'${vite ? "='2025-01-01'" : `>='${next ? "2024-09-23" : "2025-04-01"}'`}
    AND framework_plan->'compatibilityFlags'='["nodejs_compat"]'::jsonb
    ${vite ? "AND (framework_plan->'auth'->>'provider'='none' OR framework_plan->'auth'->>'deployment'='companion')" : ""})`;
};
const containerShape = `(${exactKeys(CONTAINER_KEYS)}
  AND framework_plan->>'adapter'='nextjs' AND framework_plan->>'runtime'='container'
  AND runtime='cloudflare_containers'
  AND framework_plan->>'installCommand'='pnpm install --frozen-lockfile'
  AND framework_plan->>'buildCommand'='pnpm build'
  AND framework_plan->>'outputDirectory'='.next/standalone'
  AND framework_plan->>'serverOutputDirectory'='.next/standalone'
  AND framework_plan->>'serverEntryPoint'='.next/standalone/server.js'
  AND framework_plan->'mail'='{"enabled":false}'::jsonb
  AND framework_plan->'storage'='{"enabled":false}'::jsonb)`;
const frameworkConstraint = (includeVite) => `framework_plan IS NULL OR (
  jsonb_typeof(framework_plan)='object'
  AND framework_plan->>'schemaVersion'='${V5}' AND ${applicationRootCheck}
  AND valid_runtime_policy(framework_plan->'runtimePolicy')
  AND valid_database_requirement(framework_plan->'database')
  AND valid_customer_auth_requirement(framework_plan->'auth')
  AND valid_mail_requirement(framework_plan->'mail')
  AND valid_storage_requirement(framework_plan->'storage')
  AND (framework_plan->'auth'->>'provider'='none'
    OR framework_plan->'database'->'enabled'='true'::jsonb)
  AND (${staticShape} OR ${edgeShape("tanstack-start")} OR ${edgeShape("nextjs")}
    ${includeVite ? `OR ${edgeShape("vite-static")}` : ""} OR ${containerShape}))`;

export function up(pgm) {
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, { check: frameworkConstraint(true) });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
    SELECT 1 FROM deployment_plans
    WHERE framework_plan->>'adapter'='vite-static' AND framework_plan->>'runtime'='edge'
  ) THEN RAISE EXCEPTION 'Vite companion plans prevent a migration downgrade'
    USING ERRCODE='23514'; END IF;
    IF EXISTS (SELECT 1 FROM project_r2_delete_requests)
      OR EXISTS (SELECT 1 FROM project_r2_delete_receipts) THEN
      RAISE EXCEPTION 'storage deletion evidence prevents a migration downgrade'
        USING ERRCODE='23514';
    END IF; END $$`);
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, { check: frameworkConstraint(false) });
}
