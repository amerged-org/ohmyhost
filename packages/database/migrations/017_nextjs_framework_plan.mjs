const CONSTRAINT = "deployment_plans_framework_plan_check";
const BASE_KEYS = ["adapter", "runtime", "installCommand", "buildCommand", "outputDirectory"];
const EDGE_KEYS = [
  ...BASE_KEYS,
  "serverOutputDirectory",
  "serverEntryPoint",
  "serverConfigPath",
  "compatibilityDate",
  "compatibilityFlags",
];

const exactKeys = (keys) => `framework_plan ?& ARRAY[${keys.map((key) => `'${key}'`).join(",")}]
  AND framework_plan - ARRAY[${keys.map((key) => `'${key}'`).join(",")}]='{}'::jsonb`;

const staticCheck = `(
  ${exactKeys(BASE_KEYS)}
  AND framework_plan->>'adapter' IN ('vite-static','tanstack-start')
  AND framework_plan->>'runtime'='static'
  AND length(btrim(framework_plan->>'installCommand'))>0
  AND length(btrim(framework_plan->>'buildCommand'))>0
  AND length(btrim(framework_plan->>'outputDirectory'))>0
)`;

const tanStackEdgeCheck = `(
  ${exactKeys(EDGE_KEYS)}
  AND framework_plan->>'adapter'='tanstack-start'
  AND framework_plan->>'runtime'='edge'
  AND runtime='cloudflare_workers_edge_ssr'
  AND length(btrim(framework_plan->>'installCommand'))>0
  AND length(btrim(framework_plan->>'buildCommand'))>0
  AND framework_plan->>'outputDirectory'='dist/client'
  AND framework_plan->>'serverOutputDirectory'='dist/server'
  AND framework_plan->>'serverEntryPoint'='dist/server/index.js'
  AND framework_plan->>'serverConfigPath'='dist/server/wrangler.json'
  AND framework_plan->>'compatibilityDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND framework_plan->>'compatibilityDate'>='2025-04-01'
  AND framework_plan->'compatibilityFlags'='["nodejs_compat"]'::jsonb
)`;

const nextJsEdgeCheck = `(
  ${exactKeys(EDGE_KEYS)}
  AND framework_plan->>'adapter'='nextjs'
  AND framework_plan->>'runtime'='edge'
  AND runtime='cloudflare_workers_edge_ssr'
  AND framework_plan->>'installCommand'='pnpm install --frozen-lockfile'
  AND framework_plan->>'buildCommand'='pnpm build:cloudflare'
  AND framework_plan->>'outputDirectory'='.open-next/assets'
  AND framework_plan->>'serverOutputDirectory'='.ohmyhost-worker'
  AND framework_plan->>'serverEntryPoint'='.ohmyhost-worker/worker.js'
  AND framework_plan->>'serverConfigPath'='wrangler.jsonc'
  AND framework_plan->>'compatibilityDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND framework_plan->>'compatibilityDate'>='2024-09-23'
  AND framework_plan->'compatibilityFlags'='["nodejs_compat"]'::jsonb
)`;

export function up(pgm) {
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: `framework_plan IS NULL OR (
      jsonb_typeof(framework_plan)='object'
      AND (${staticCheck} OR ${tanStackEdgeCheck} OR ${nextJsEdgeCheck})
    )`,
  });
}

export function down(pgm) {
  pgm.sql(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM deployment_plans
        WHERE framework_plan->>'adapter'='nextjs'
      ) THEN
        RAISE EXCEPTION 'Next.js deployment plans prevent a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
    END
  $$`);
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, {
    check: `framework_plan IS NULL OR (
      jsonb_typeof(framework_plan)='object'
      AND (${staticCheck} OR ${tanStackEdgeCheck})
    )`,
  });
}
