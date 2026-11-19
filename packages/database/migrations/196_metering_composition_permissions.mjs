// W24: final explicit Metering composition policy. Restores the concrete discovery capabilities
// intentionally withheld by188 and allows only the four reviewed derived-projection lifecycle APIs.
// No credentials, roles, membership, defaults, provider work or financial authority are created.
// A missing login is schema-only/unprovisioned; provisioning must precede this migration.

export const METERING_COMPOSITION_POLICY_VERSION = "metering-composition/v1";

const TABLE_GRANTS = {
  wfp_batch_discovery: ["SELECT", "INSERT", "UPDATE"],
  metering_discovery_backfills: ["SELECT", "UPDATE"],
  wfp_discovery_cohort_plan: ["SELECT", "INSERT", "DELETE"],
  lifetime_resource_work: ["SELECT", "INSERT", "UPDATE"],
  lifetime_resource_sources: ["SELECT", "INSERT", "UPDATE"],
  lifetime_day_hints: ["SELECT", "INSERT", "UPDATE"],
  lifetime_dirty_notices: ["SELECT", "UPDATE"],
  lifetime_discovery_bootstrap: ["SELECT", "UPDATE"],
  wfp_usage_batches: ["SELECT"],
  wfp_usage_events: ["SELECT"],
  attributed_wfp_usage: ["SELECT"],
  runtime_probe_windows: ["SELECT"],
};
const ENTRY_FUNCTIONS = [
  "credit_projection_start(text,text,text)",
  "credit_projection_advance(text,text,integer)",
  "credit_projection_activate(text,text,text)",
  "credit_projection_cleanup(text,text,integer)",
  "credit_expiry_start(text,text,text)",
  "credit_expiry_advance(text,text,integer)",
  "credit_expiry_publish(text,text,text)",
  "credit_expiry_cleanup(text,text,integer)",
  "credit_usage_reporting_start(text,text,text)",
  "credit_usage_reporting_advance(text,text,integer)",
  "credit_usage_reporting_activate(text,text,text)",
  "credit_usage_reporting_cleanup(text,text,integer)",
  "credit_source_start(text,text,text,text)",
  "credit_source_advance(text,text,text,text,integer)",
  "credit_source_activate(text,text,text,text)",
  "credit_source_cleanup(text,text,text,text,integer)",
];
const PRIVATE_FUNCTIONS = [
  "credit_projection_contribute(text,text,text,text,boolean)",
  "credit_projection_lock_organization(text)",
  "credit_projection_lock_source()",
  "credit_projection_apply_source()",
  "credit_projection_create_state()",
  "credit_expiry_lock_organization(text)",
  "credit_expiry_invalidate_source()",
  "credit_expiry_create_state()",
  "credit_expiry_guard_state()",
  "credit_expiry_guard_build()",
  "credit_usage_reporting_create_state()",
  "credit_usage_reporting_apply_source()",
  "credit_usage_reporting_lock_source()",
  "credit_usage_reporting_contribute(text,text,text,text,boolean)",
  "credit_usage_reporting_lock_organization(text)",
  "credit_source_require_read_committed()",
  "credit_source_lock_organization(text)",
  "credit_source_lock_source(text,text)",
  "credit_source_adjust_head(text,text,numeric,integer)",
  "credit_source_contribute_valuation(text,text,text,boolean,text,text)",
  "credit_source_contribute_movement(text,text,text,text,text,boolean)",
  "credit_source_lock_valuation()",
  "credit_source_apply_valuation()",
  "credit_source_apply_movement()",
];

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function boundDdl(pgm) {
  pgm.sql(`CREATE TEMP TABLE w24_composition_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,
      current_setting('statement_timeout') AS statement_timeout;
    SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
function restoreBounds(pgm) {
  pgm.sql(`SELECT set_config('lock_timeout',lock_timeout,true),
      set_config('statement_timeout',statement_timeout,true) FROM pg_temp.w24_composition_timeouts;
    DROP TABLE pg_temp.w24_composition_timeouts;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  boundDdl(pgm);
  pgm.sql(`DO $composition$
  DECLARE v_schema text := pg_catalog.current_schema(); v_name text; v_rights jsonb; v_signature text; v_role text;
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'metering_runtime') THEN
      FOR v_name, v_rights IN SELECT * FROM jsonb_each('${JSON.stringify(TABLE_GRANTS)}'::jsonb) LOOP
        EXECUTE pg_catalog.format('GRANT %s ON TABLE %I.%I TO metering_runtime',
          (SELECT string_agg(value, ', ') FROM jsonb_array_elements_text(v_rights)), v_schema, v_name);
      END LOOP;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['control_runtime', 'metering_runtime'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
        FOREACH v_signature IN ARRAY ARRAY[${PRIVATE_FUNCTIONS.map((s) => `'${s}'`).join(", ")}] LOOP
          EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.%s FROM %I', v_schema, v_signature, v_role);
        END LOOP;
        FOREACH v_signature IN ARRAY ARRAY[${ENTRY_FUNCTIONS.map((s) => `'${s}'`).join(", ")}] LOOP
          EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %I.%s TO %I', v_schema, v_signature, v_role);
        END LOOP;
      END IF;
    END LOOP;
  END $composition$;`);
  restoreBounds(pgm);
}

/**
 * Removes this composition's direct capabilities only. Existing base identity guards, credentials,
 * receipts and financial facts remain. A runtime without this policy must fail readiness.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
export function down(pgm) {
  boundDdl(pgm);
  pgm.sql(`DO $composition$
  DECLARE v_schema text := pg_catalog.current_schema(); v_name text; v_rights jsonb; v_signature text; v_role text;
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'metering_runtime') THEN
      FOR v_name, v_rights IN SELECT * FROM jsonb_each('${JSON.stringify(TABLE_GRANTS)}'::jsonb) LOOP
        EXECUTE pg_catalog.format('REVOKE %s ON TABLE %I.%I FROM metering_runtime',
          (SELECT string_agg(value, ', ') FROM jsonb_array_elements_text(v_rights)), v_schema, v_name);
      END LOOP;
      FOREACH v_signature IN ARRAY ARRAY[${ENTRY_FUNCTIONS.map((s) => `'${s}'`).join(", ")}] LOOP
        EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %I.%s FROM metering_runtime', v_schema, v_signature);
      END LOOP;
    END IF;
    --187/191 already granted their Control lifecycle APIs before this composition.
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_runtime') THEN
      FOREACH v_signature IN ARRAY ARRAY[${ENTRY_FUNCTIONS.filter(
        (s) => s.startsWith("credit_projection_") || s.startsWith("credit_usage_reporting_"),
      )
        .map((s) => `'${s}'`)
        .join(", ")}] LOOP
        EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %I.%s FROM control_runtime', v_schema, v_signature);
      END LOOP;
    END IF;
  END $composition$;`);
  restoreBounds(pgm);
}
