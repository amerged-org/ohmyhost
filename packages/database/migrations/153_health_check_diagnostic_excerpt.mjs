// A candidate that fails its health check keeps a sanitized head of its own answer as the
// diagnostic's excerpt (D271, migration 132), but the excerpt check still admitted only
// BUILD_FAILED, so the verdict could not be stored and the customer never learned why the
// candidate was removed (Sebmer Dev operation 01M3C5PEP52T5E3YCM26VWPKXW, 2026-09-25). The same
// shape rules now admit a HEALTH_CHECK_FAILED excerpt as well.
const SHAPE = `length(excerpt) BETWEEN 1 AND 16384 AND excerpt!~'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]' AND excerpt!~'[[:space:]]$'`;

export function up(pgm) {
  pgm.dropConstraint("deployment_diagnostics", "deployment_diagnostics_excerpt_check");
  pgm.addConstraint("deployment_diagnostics", "deployment_diagnostics_excerpt_check", {
    check: `((excerpt IS NULL)=(excerpt_truncated IS NULL)) AND (excerpt IS NULL OR (code IN ('BUILD_FAILED','HEALTH_CHECK_FAILED') AND ${SHAPE}))`,
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM deployment_diagnostics WHERE code='HEALTH_CHECK_FAILED' AND excerpt IS NOT NULL) THEN
      RAISE EXCEPTION 'Health-check diagnostics keep response excerpts; let them expire before this downgrade';
    END IF;
  END $$`);
  pgm.dropConstraint("deployment_diagnostics", "deployment_diagnostics_excerpt_check");
  pgm.addConstraint("deployment_diagnostics", "deployment_diagnostics_excerpt_check", {
    check: `((excerpt IS NULL)=(excerpt_truncated IS NULL)) AND (excerpt IS NULL OR (code='BUILD_FAILED' AND ${SHAPE}))`,
  });
}
