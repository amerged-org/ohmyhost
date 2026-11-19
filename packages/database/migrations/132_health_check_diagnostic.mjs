// A candidate that failed its health check told the customer only DEPLOYMENT_PROVIDER_FAILED with
// every optional column empty, while the platform already knew the status code, the path it probed
// and the first bytes of the answer. The code and route columns already hold their parts; the
// status needs one column of its own, and only a health-check diagnostic may carry it.
export function up(pgm) {
  pgm.addColumn("deployment_diagnostics", { status_code: { type: "smallint" } });
  pgm.addConstraint("deployment_diagnostics", "deployment_diagnostics_status_code_shape", {
    check: `status_code IS NULL OR (code='HEALTH_CHECK_FAILED' AND status_code BETWEEN 100 AND 599)`,
  });
}

export function down(pgm) {
  pgm.dropConstraint("deployment_diagnostics", "deployment_diagnostics_status_code_shape");
  pgm.dropColumn("deployment_diagnostics", "status_code");
}
