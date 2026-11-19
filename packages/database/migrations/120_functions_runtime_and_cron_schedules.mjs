// P34: cron schedules for the Worker module of every edge or functions environment.
// Replaces the framework-bound scheduled-function scheduler (migrations 053/064/070)
// with one schedule row per environment head and one run row per due minute.
import { frameworkConstraint as previousConstraint } from "./056_framework_build_commands.mjs";
import { up as restoreScheduledFunctionExecution } from "./064_scheduled_function_execution.mjs";
import { up as restoreScheduledWorkflowIdentity } from "./070_scheduled_workflow_identity.mjs";

const CONSTRAINT = "deployment_plans_framework_plan_check";
const COMMAND_PREDICATE = "valid_framework_build_commands";
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
const FUNCTIONS_KEYS = [
  "adapter",
  "runtime",
  "installCommand",
  "schemaVersion",
  "applicationRoot",
  "runtimePolicy",
  "database",
  "auth",
  "mail",
  "storage",
  "compatibilityDate",
  "compatibilityFlags",
];
const INSTALL_COMMANDS = [
  "bun install --frozen-lockfile --ignore-scripts",
  "npm ci --ignore-scripts",
  "pnpm install --frozen-lockfile --ignore-scripts",
  "yarn install --immutable --mode=skip-build",
];

const exactKeys = (keys) => `framework_plan ?& ARRAY[${keys.map((key) => `'${key}'`).join(",")}]
  AND framework_plan - ARRAY[${keys.map((key) => `'${key}'`).join(",")}]='{}'::jsonb`;
const optionalCrons = (keys) => `((${exactKeys(keys)})
  OR ((${exactKeys([...keys, "functions"])}) AND valid_function_crons(framework_plan->'functions')))`;
const applicationRootCheck = `(jsonb_typeof(framework_plan->'applicationRoot')='string'
  AND octet_length(framework_plan->>'applicationRoot')<=64
  AND framework_plan->>'applicationRoot'~'^(\\.|[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*)$'
  AND (framework_plan->>'applicationRoot'='.' OR cardinality(string_to_array(framework_plan->>'applicationRoot','/'))<=8)
  AND framework_plan->>'applicationRoot'!~'(^|/)[A-Za-z0-9][A-Za-z0-9._-]{63}($|/)')`;
const commandCheck = `${COMMAND_PREDICATE}(framework_plan)`;
const staticShape = `(${exactKeys(BASE_KEYS)} AND ${commandCheck}
  AND framework_plan->>'adapter' IN ('vite-static','tanstack-start')
  AND framework_plan->>'runtime'='static'
  AND ((framework_plan->>'adapter'='vite-static' AND framework_plan->>'outputDirectory'='dist')
    OR (framework_plan->>'adapter'='tanstack-start' AND framework_plan->>'outputDirectory'='dist/client'))
  AND framework_plan->'storage'='{"enabled":false}'::jsonb)`;
const edgeShape = (adapter) => {
  const vite = adapter === "vite-static";
  const next = adapter === "nextjs";
  return `(${optionalCrons(EDGE_KEYS)} AND ${commandCheck}
    AND framework_plan->>'adapter'='${adapter}'
    AND framework_plan->>'runtime'='edge' AND runtime='cloudflare_workers_edge_ssr'
    AND framework_plan->>'outputDirectory'='${vite ? "dist" : next ? ".open-next/assets" : "dist/client"}'
    AND framework_plan->>'serverOutputDirectory'='${vite ? ".ohmyhost/vite-companion" : next ? ".ohmyhost-worker" : "dist/server"}'
    AND framework_plan->>'serverEntryPoint'='${vite ? ".ohmyhost/vite-companion/worker.js" : next ? ".ohmyhost-worker/worker.js" : "dist/server/index.js"}'
    AND framework_plan->>'serverConfigPath'='${vite ? ".ohmyhost/vite-companion/wrangler.jsonc" : next ? "wrangler.jsonc" : "dist/server/wrangler.json"}'
    AND framework_plan->>'compatibilityDate'${vite ? "='2025-01-01'" : `>='${next ? "2024-09-23" : "2025-04-01"}'`}
    AND framework_plan->'compatibilityFlags'='["nodejs_compat"]'::jsonb
    ${vite ? "AND (framework_plan->'auth'->>'provider'='none' OR framework_plan->'auth'->>'deployment'='companion')" : ""})`;
};
export const containerShape = `(${exactKeys(CONTAINER_KEYS)} AND ${commandCheck}
  AND framework_plan->>'adapter'='nextjs'
  AND framework_plan->>'runtime'='container' AND runtime='cloudflare_containers'
  AND framework_plan->>'outputDirectory'='.next/standalone'
  AND framework_plan->>'serverOutputDirectory'='.next/standalone'
  AND framework_plan->>'serverEntryPoint'='.next/standalone/server.js'
  AND framework_plan->'mail'='{"enabled":false}'::jsonb AND framework_plan->'storage'='{"enabled":false}'::jsonb)`;
const functionsShape = `(${optionalCrons(FUNCTIONS_KEYS)}
  AND framework_plan->>'adapter'='functions'
  AND framework_plan->>'runtime'='functions' AND runtime='cloudflare_workers_edge_ssr'
  AND framework_plan->>'installCommand' IN (${INSTALL_COMMANDS.map((command) => `'${command}'`).join(",")})
  AND framework_plan->>'compatibilityDate'>='2025-01-01'
  AND framework_plan->'compatibilityFlags'='["nodejs_compat"]'::jsonb
  AND (framework_plan->'auth'->>'provider'='none' OR framework_plan->'auth'->>'deployment'='companion'))`;
export const frameworkConstraint = `framework_plan IS NULL OR (jsonb_typeof(framework_plan)='object'
  AND framework_plan->>'schemaVersion'='${V5}' AND ${applicationRootCheck}
  AND valid_runtime_policy(framework_plan->'runtimePolicy')
  AND valid_database_requirement(framework_plan->'database')
  AND valid_customer_auth_requirement(framework_plan->'auth')
  AND valid_mail_requirement(framework_plan->'mail')
  AND valid_storage_requirement(framework_plan->'storage')
  AND (framework_plan->'auth'->>'provider'='none' OR framework_plan->'database'->'enabled'='true'::jsonb)
  AND (${staticShape} OR ${edgeShape("tanstack-start")} OR ${edgeShape("nextjs")} OR ${edgeShape("vite-static")} OR ${containerShape} OR ${functionsShape}))`;

export function up(pgm) {
  pgm.sql(`CREATE FUNCTION valid_function_crons(requirement jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_typeof(requirement)='object'
      AND requirement ?& ARRAY['crons'] AND requirement - ARRAY['crons']='{}'::jsonb
      AND jsonb_typeof(requirement->'crons')='array'
      AND jsonb_array_length(requirement->'crons') BETWEEN 1 AND 8
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(requirement->'crons') WITH ORDINALITY item(value,ord)
        WHERE jsonb_typeof(value)<>'string'
          OR (value#>>'{}')!~'^(\\*\\/([5-9]|[1-5][0-9])|[0-9]|[1-5][0-9]) (\\*|[0-9]|1[0-9]|2[0-3]) (\\*|[1-9]|[12][0-9]|3[01]) (\\*|[1-9]|1[0-2]) (\\*|[0-6])$'
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(requirement->'crons') WITH ORDINALITY prior(pvalue,pord)
            WHERE pord<ord AND (pvalue#>>'{}')>=(value#>>'{}'))) $$`);
  for (const table of [
    "scheduled_function_cancellations",
    "scheduled_function_attempts",
    "scheduled_function_workflow_receipts",
    "scheduled_function_slots",
    "scheduled_function_heads",
    "scheduled_function_definitions",
  ])
    pgm.dropTable(table);
  pgm.sql("DROP FUNCTION scheduled_cron_due(text, timestamptz)");
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.sql("ALTER TABLE deployment_plans DISABLE TRIGGER deployment_plans_append_only");
  pgm.sql(`UPDATE deployment_plans SET framework_plan=
    CASE WHEN jsonb_array_length(framework_plan->'functions'->'scheduled')=0
      THEN framework_plan-'functions'
      ELSE jsonb_set(framework_plan-'functions','{functions}',jsonb_build_object('crons',
        (SELECT jsonb_agg(cron ORDER BY cron) FROM (
          SELECT DISTINCT item->>'cron' cron FROM jsonb_array_elements(framework_plan->'functions'->'scheduled') item) crons)))
    END
    WHERE framework_plan IS NOT NULL AND framework_plan->'functions' ? 'scheduled'`);
  pgm.sql("ALTER TABLE deployment_plans ENABLE TRIGGER deployment_plans_append_only");
  pgm.addConstraint("deployment_plans", CONSTRAINT, { check: frameworkConstraint });
  pgm.sql("DROP FUNCTION valid_functions_requirement(jsonb)");
  pgm.createTable("environment_function_schedules", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    candidate_receipt_id: { type: "ulid", notNull: true },
    immutable_script_name: { type: "text", notNull: true },
    crons: { type: "jsonb", notNull: true },
    egress_allowed_origins: { type: "jsonb", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("environment_function_schedules", "environment_function_schedules_pkey", {
    primaryKey: ["organization_id", "environment_id"],
  });
  pgm.addConstraint(
    "environment_function_schedules",
    "environment_function_schedules_environment_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "environment_id"],
        references: "environments (organization_id, project_id, environment_id)",
        onDelete: "CASCADE",
      },
    },
  );
  pgm.addConstraint(
    "environment_function_schedules",
    "environment_function_schedules_candidate_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "candidate_receipt_id"],
        references: "wfp_candidate_receipts (organization_id, project_id, candidate_receipt_id)",
        onDelete: "CASCADE",
      },
    },
  );
  pgm.addConstraint(
    "environment_function_schedules",
    "environment_function_schedules_shape_check",
    {
      check: `valid_function_crons(jsonb_build_object('crons',crons)) AND jsonb_typeof(egress_allowed_origins)='array'
      AND immutable_script_name~'^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$'`,
    },
  );
  pgm.createTable("function_runs", {
    run_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    immutable_script_name: { type: "text", notNull: true },
    cron: { type: "text", notNull: true },
    scheduled_at: { type: "timestamptz", notNull: true },
    state: { type: "text", notNull: true },
    attempt: { type: "integer", notNull: true, default: 0 },
    lease_until: { type: "timestamptz" },
    started_at: { type: "timestamptz" },
    finished_at: { type: "timestamptz" },
    status_code: { type: "integer" },
    egress_allowed_origins: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("function_runs", "function_runs_minute_key", {
    unique: ["organization_id", "environment_id", "cron", "scheduled_at"],
  });
  pgm.addConstraint("function_runs", "function_runs_shape_check", {
    check: `state IN ('due','running','retry','succeeded','failed')
      AND attempt BETWEEN 0 AND 3
      AND (status_code IS NULL OR status_code BETWEEN 100 AND 599)
      AND jsonb_typeof(egress_allowed_origins)='array'
      AND ((state='running')=(lease_until IS NOT NULL))
      AND ((state IN ('succeeded','failed'))=(finished_at IS NOT NULL))`,
  });
  pgm.createIndex("function_runs", ["state", "lease_until"], { name: "function_runs_claim_idx" });
  pgm.createIndex("function_runs", ["finished_at"], {
    name: "function_runs_finished_idx",
    where: "finished_at IS NOT NULL",
  });
}

/**
 * Lossless downgrade only: recorded schedules, runs or plans that declare crons or the
 * functions runtime cannot be expressed by the retired scheduler and block the rollback.
 */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM environment_function_schedules)
      OR EXISTS (SELECT 1 FROM function_runs)
      OR EXISTS (SELECT 1 FROM deployment_plans
        WHERE framework_plan ? 'functions' OR framework_plan->>'runtime'='functions')
    THEN RAISE EXCEPTION 'function schedule evidence prevents a lossless downgrade'
      USING ERRCODE='23514'; END IF; END $$`);
  pgm.dropTable("function_runs");
  pgm.dropTable("environment_function_schedules");
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.sql("DROP FUNCTION valid_function_crons(jsonb)");
  restoreScheduledFunctionExecution(pgm);
  restoreScheduledWorkflowIdentity(pgm);
  // The upgrade removed the empty declaration envelope; the retired constraint requires it.
  pgm.sql("ALTER TABLE deployment_plans DISABLE TRIGGER deployment_plans_append_only");
  pgm.sql(`UPDATE deployment_plans SET framework_plan=framework_plan
      || '{"functions":{"delivery":"at-least-once","timeoutSeconds":120,"maxAttempts":3,"scheduled":[]}}'::jsonb
    WHERE framework_plan->>'adapter'='vite-static' AND framework_plan->>'runtime'='edge'
      AND NOT framework_plan ? 'functions'`);
  pgm.sql("ALTER TABLE deployment_plans ENABLE TRIGGER deployment_plans_append_only");
  pgm.addConstraint("deployment_plans", CONSTRAINT, { check: previousConstraint });
}
