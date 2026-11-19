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
const CURRENT_BASE_KEYS = [...BASE_KEYS, "schemaVersion", "applicationRoot", "runtimePolicy"];
const CURRENT_EDGE_KEYS = [...EDGE_KEYS, "schemaVersion", "applicationRoot", "runtimePolicy"];
const PREVIOUS_CURRENT_BASE_KEYS = [...BASE_KEYS, "schemaVersion", "applicationRoot"];
const PREVIOUS_CURRENT_EDGE_KEYS = [...EDGE_KEYS, "schemaVersion", "applicationRoot"];

const exactKeys = (keys) => `framework_plan ?& ARRAY[${keys.map((key) => `'${key}'`).join(",")}]
  AND framework_plan - ARRAY[${keys.map((key) => `'${key}'`).join(",")}]='{}'::jsonb`;

const staticShape = (keys) => `(
  ${exactKeys(keys)}
  AND framework_plan->>'adapter' IN ('vite-static','tanstack-start')
  AND framework_plan->>'runtime'='static'
  AND length(btrim(framework_plan->>'installCommand'))>0
  AND length(btrim(framework_plan->>'buildCommand'))>0
  AND ((framework_plan->>'adapter'='vite-static' AND framework_plan->>'outputDirectory'='dist')
    OR (framework_plan->>'adapter'='tanstack-start' AND framework_plan->>'outputDirectory'='dist/client'))
)`;

const edgeShape = (adapter, keys) => `(
  ${exactKeys(keys)}
  AND framework_plan->>'adapter'='${adapter}'
  AND framework_plan->>'runtime'='edge'
  AND runtime='cloudflare_workers_edge_ssr'
  AND framework_plan->>'installCommand'='pnpm install --frozen-lockfile'
  AND framework_plan->>'buildCommand'${adapter === "nextjs" ? "='pnpm build:cloudflare'" : "<>''"}
  AND framework_plan->>'outputDirectory'='${adapter === "nextjs" ? ".open-next/assets" : "dist/client"}'
  AND framework_plan->>'serverOutputDirectory'='${adapter === "nextjs" ? ".ohmyhost-worker" : "dist/server"}'
  AND framework_plan->>'serverEntryPoint'='${adapter === "nextjs" ? ".ohmyhost-worker/worker.js" : "dist/server/index.js"}'
  AND framework_plan->>'serverConfigPath'='${adapter === "nextjs" ? "wrangler.jsonc" : "dist/server/wrangler.json"}'
  AND framework_plan->>'compatibilityDate'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND framework_plan->>'compatibilityDate'>='${adapter === "nextjs" ? "2024-09-23" : "2025-04-01"}'
  AND framework_plan->'compatibilityFlags'='["nodejs_compat"]'::jsonb
)`;

const legacyCheck = `(${staticShape(BASE_KEYS)} OR ${edgeShape("tanstack-start", EDGE_KEYS)} OR ${edgeShape("nextjs", EDGE_KEYS)})`;
const applicationRootCheck = `(
  jsonb_typeof(framework_plan->'applicationRoot')='string'
  AND octet_length(framework_plan->>'applicationRoot')<=64
  AND framework_plan->>'applicationRoot'~'^(\\.|[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*)$'
  AND (framework_plan->>'applicationRoot'='.'
    OR cardinality(string_to_array(framework_plan->>'applicationRoot','/'))<=8)
  AND framework_plan->>'applicationRoot'!~'(^|/)[A-Za-z0-9][A-Za-z0-9._-]{63}($|/)'
)`;
const previousCurrentCheck = `(
  framework_plan->>'schemaVersion'='${SCHEMA_VERSION}' AND ${applicationRootCheck}
  AND (${staticShape(PREVIOUS_CURRENT_BASE_KEYS)}
    OR ${edgeShape("tanstack-start", PREVIOUS_CURRENT_EDGE_KEYS)}
    OR ${edgeShape("nextjs", PREVIOUS_CURRENT_EDGE_KEYS)})
)`;
const currentCheck = `(
  framework_plan->>'schemaVersion'='${SCHEMA_VERSION}'
  AND ${applicationRootCheck}
  AND valid_runtime_policy(framework_plan->'runtimePolicy')
  AND (${staticShape(CURRENT_BASE_KEYS)}
    OR ${edgeShape("tanstack-start", CURRENT_EDGE_KEYS)}
    OR ${edgeShape("nextjs", CURRENT_EDGE_KEYS)})
)`;

export function up(pgm) {
  pgm.sql(`CREATE FUNCTION valid_runtime_policy(policy jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE origin text; previous text := NULL; hostname text; address inet;
    BEGIN
      IF jsonb_typeof(policy)<>'object'
        OR NOT (policy ?& ARRAY['healthCheckPath','egressAllowedOrigins'])
        OR policy-ARRAY['healthCheckPath','egressAllowedOrigins']<>'{}'::jsonb
        OR jsonb_typeof(policy->'healthCheckPath')<>'string'
        OR length(policy->>'healthCheckPath') NOT BETWEEN 1 AND 256
        OR policy->>'healthCheckPath'!~'^/(?!/)[^\\?#]*$'
        OR string_to_array(policy->>'healthCheckPath','/') && ARRAY['.','..']
        OR jsonb_typeof(policy->'egressAllowedOrigins')<>'array'
        OR jsonb_array_length(policy->'egressAllowedOrigins')>16 THEN
        RETURN false;
      END IF;
      FOR origin IN SELECT jsonb_array_elements_text(policy->'egressAllowedOrigins') LOOP
        IF origin!~'^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$'
          OR origin~':443$'
          OR (previous IS NOT NULL AND previous>=origin) THEN RETURN false; END IF;
        hostname := split_part(substring(origin from 9),':',1);
        IF hostname='localhost' OR hostname~'\\.(local|internal)$' THEN RETURN false; END IF;
        IF hostname~'^[0-9]{1,3}(\\.[0-9]{1,3}){3}$' THEN
          address := hostname::inet;
          IF address <<= inet '0.0.0.0/8' OR address <<= inet '10.0.0.0/8'
            OR address <<= inet '127.0.0.0/8' OR address <<= inet '169.254.0.0/16'
            OR address <<= inet '172.16.0.0/12' OR address <<= inet '192.168.0.0/16'
            OR address <<= inet '224.0.0.0/4' THEN RETURN false; END IF;
        END IF;
        IF position(':' in substring(origin from 9))>0
          AND split_part(substring(origin from 9),':',2)::integer>65535 THEN RETURN false; END IF;
        previous := origin;
      END LOOP;
      RETURN true;
    EXCEPTION WHEN OTHERS THEN RETURN false;
    END
  $$`);
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: `framework_plan IS NULL OR (
      jsonb_typeof(framework_plan)='object' AND (${legacyCheck} OR ${currentCheck})
    )`,
  });
  pgm.sql(`CREATE OR REPLACE FUNCTION require_v2_deployment_plan_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.framework_plan IS NOT NULL AND NOT (
        NEW.framework_plan->>'schemaVersion'='${SCHEMA_VERSION}'
        AND NEW.framework_plan ? 'applicationRoot'
        AND valid_runtime_policy(NEW.framework_plan->'runtimePolicy')
      ) THEN
        RAISE EXCEPTION 'new deployment plans require a v2 framework plan with runtime policy'
          USING ERRCODE='23514', CONSTRAINT='deployment_plans_framework_plan_insert_v2';
      END IF;
      RETURN NEW;
    END
  $$`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM deployment_plans WHERE framework_plan ? 'runtimePolicy') THEN
      RAISE EXCEPTION 'runtime-policy deployment plans prevent a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.sql("DROP FUNCTION valid_runtime_policy(jsonb)");
  pgm.sql(`CREATE OR REPLACE FUNCTION require_v2_deployment_plan_insert() RETURNS trigger
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
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: `framework_plan IS NULL OR (
      jsonb_typeof(framework_plan)='object' AND (${legacyCheck} OR ${previousCurrentCheck})
    )`,
  });
}
