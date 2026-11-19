import { frameworkConstraint as previousConstraint } from "./170_next_ssg_cache_capacity.mjs";

const constraint = "deployment_plans_framework_plan_check";
const normalized = `(CASE WHEN framework_plan->>'runtime'='static'
  THEN framework_plan || '{"adapter":"vite-static"}'::jsonb
  ELSE framework_plan || '{"adapter":"tanstack-start","serverEntryPoint":"dist/server/index.js"}'::jsonb END)`;
const astroShape = previousConstraint.replaceAll("framework_plan", normalized);
export const frameworkConstraint = `(${previousConstraint}) OR (
  framework_plan->>'adapter'='astro' AND (${astroShape}) IS TRUE
  AND NOT framework_plan ? 'ssgCacheMaxBytes'
  AND (framework_plan->>'runtime'='static' OR (framework_plan->>'serverEntryPoint'='dist/server/entry.mjs'
    AND framework_plan->>'compatibilityDate'>='2026-10-12'))
  AND (framework_plan->>'runtime'<>'static' OR (framework_plan->'database'='{"enabled":false}'::jsonb
    AND framework_plan->'auth'='{"provider":"none"}'::jsonb AND framework_plan->'mail'='{"enabled":false}'::jsonb))) IS TRUE`;

/** Widen admission without rewriting historical plans. */
export function up(pgm) {
  pgm.dropConstraint("deployment_plans", constraint);
  pgm.addConstraint("deployment_plans", constraint, { check: frameworkConstraint });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM deployment_plans WHERE framework_plan->>'adapter'='astro')
    THEN RAISE EXCEPTION 'persisted Astro plans prevent migration downgrade' USING ERRCODE='23514'; END IF; END $$`);
  pgm.dropConstraint("deployment_plans", constraint);
  pgm.addConstraint("deployment_plans", constraint, { check: previousConstraint });
}
