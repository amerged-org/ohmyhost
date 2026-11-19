export function up(pgm) {
  pgm.createTable("deployment_diagnostics", {
    diagnostic_event_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    source: { type: "text", notNull: true },
    code: { type: "text", notNull: true },
    catalog_message: { type: "text", notNull: true },
    exception_class: { type: "text" },
    source_file: { type: "text" },
    source_line: { type: "integer" },
    source_column: { type: "integer" },
    route_template: { type: "text" },
    request_id: { type: "text" },
    trace_id: { type: "text" },
    duration_ms: { type: "integer" },
    occurred_at: { type: "timestamptz", notNull: true },
    recorded_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("deployment_diagnostics", "deployment_diagnostics_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployments", "deployments_diagnostic_environment_scope_key", {
    unique: ["organization_id", "project_id", "environment_id", "deployment_id"],
  });
  pgm.addConstraint("deployment_diagnostics", "deployment_diagnostics_deployment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id", "deployment_id"],
      references: "deployments (organization_id, project_id, environment_id, deployment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployment_diagnostics", "deployment_diagnostics_shape_check", {
    check: `source IN ('build','control','runtime','function') AND code~'^[A-Z][A-Z0-9_]{1,63}$' AND catalog_message~'^[A-Z][A-Z0-9_]{1,127}$' AND (exception_class IS NULL OR exception_class~'^[A-Za-z][A-Za-z0-9_.]{0,127}$') AND (source_file IS NULL OR (length(source_file) BETWEEN 1 AND 512 AND source_file NOT LIKE '/%' AND source_file NOT LIKE '%..%' AND source_file!~'[[:cntrl:]]')) AND ((source_line IS NULL AND source_column IS NULL) OR (source_line>0 AND source_column>=0)) AND (route_template IS NULL OR (route_template LIKE '/%' AND length(route_template)<=512 AND route_template NOT LIKE '%?%')) AND (request_id IS NULL OR (length(request_id) BETWEEN 1 AND 128 AND request_id!~'[[:cntrl:][:space:]]')) AND (trace_id IS NULL OR trace_id~'^[A-Za-z0-9_-]{1,128}$') AND (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 900000) AND occurred_at<=recorded_at AND occurred_at>=recorded_at-interval '7 days'`,
  });
  pgm.createIndex(
    "deployment_diagnostics",
    ["organization_id", "project_id", "environment_id", "occurred_at", "diagnostic_event_id"],
    { name: "deployment_diagnostics_scope_order_idx" },
  );
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM deployment_diagnostics) THEN RAISE EXCEPTION 'diagnostic evidence prevents downgrade' USING ERRCODE='23514'; END IF; END $$`,
  );
  pgm.dropTable("deployment_diagnostics");
  pgm.dropConstraint("deployments", "deployments_diagnostic_environment_scope_key");
}
