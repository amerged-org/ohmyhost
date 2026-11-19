// The real Dev planning request req_c63add2a-ce03-4a1c-a2fc-73ec41dcf167 reached
// Source Fetcher successfully, but the persisted framework constraint rejected its cache budget.
import { frameworkConstraint as previousConstraint } from "./125_remove_customer_container_runtime.mjs";

const CONSTRAINT = "deployment_plans_framework_plan_check";
const previousShape = previousConstraint.replaceAll(
  "framework_plan",
  "(framework_plan - 'ssgCacheMaxBytes')",
);
export const frameworkConstraint = `framework_plan IS NULL OR (
  (${previousShape}) IS TRUE
  AND COALESCE(NOT (framework_plan ? 'ssgCacheMaxBytes') OR (
    framework_plan->>'adapter'='nextjs' AND framework_plan->>'runtime'='edge'
    AND CASE WHEN jsonb_typeof(framework_plan->'ssgCacheMaxBytes')='number' THEN
      (framework_plan->>'ssgCacheMaxBytes')::numeric BETWEEN 1048576 AND 67108864
      AND mod((framework_plan->>'ssgCacheMaxBytes')::numeric,1048576)=0
    ELSE false END),false))`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, { check: frameworkConstraint });
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM deployment_plans WHERE framework_plan ? 'ssgCacheMaxBytes') THEN
      RAISE EXCEPTION 'persisted Next cache plans prevent migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropConstraint("deployment_plans", CONSTRAINT);
  pgm.addConstraint("deployment_plans", CONSTRAINT, { check: previousConstraint });
}
