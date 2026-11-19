// E33 names the operation error rather than pretending every deployment failure was a provider.
export function up(pgm) {
  pgm.sql(`UPDATE deployment_diagnostics
    SET catalog_message='DEPLOYMENT_FAILED_SEE_OPERATION_ERROR'
    WHERE source='control' AND code='DEPLOYMENT_FAILED'
      AND catalog_message='DEPLOYMENT_PROVIDER_FAILED'`);
}

export function down(pgm) {
  pgm.sql(`UPDATE deployment_diagnostics
    SET catalog_message='DEPLOYMENT_PROVIDER_FAILED'
    WHERE source='control' AND code='DEPLOYMENT_FAILED'
      AND catalog_message='DEPLOYMENT_FAILED_SEE_OPERATION_ERROR'`);
}
