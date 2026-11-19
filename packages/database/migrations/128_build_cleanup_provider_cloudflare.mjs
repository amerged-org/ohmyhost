// D249/D251: the source archive and the build artifact of a candidate live in the platform's R2
// build bucket, so the cleanup evidence of migration 062 names `cloudflare` as their provider.
// As in migration 127 the history of deleted and deleting projects is removed instead of being
// rewritten (the provider is part of the hashed resource identity, and those objects were in S3),
// and an active project with such evidence stops the migration.
const EXPECTATIONS = "wfp_candidate_cleanup_resource_expectations";
const RECEIPTS = "wfp_candidate_operation_cleanup_receipts";

const expectationShape = (provider) => `provider='${provider}'
  AND resource_kind IN ('source-archive','build-artifact')
  AND octet_length(resource_identity_sha256)=32`;
const receiptShape = (provider) => `${expectationShape(provider)}
  AND outcome IN ('removed','not_found')`;

export function up(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
      SELECT 1 FROM projects project WHERE project.lifecycle_state='active' AND (
        EXISTS (SELECT 1 FROM ${EXPECTATIONS} expected WHERE expected.project_id=project.project_id)
        OR EXISTS (SELECT 1 FROM ${RECEIPTS} actual WHERE actual.project_id=project.project_id)))
    THEN RAISE EXCEPTION 'build cleanup evidence of an active project prevents the provider change'
      USING ERRCODE='23514'; END IF; END $$`);
  // The receipts reference their expectation, so they go first.
  for (const table of [RECEIPTS, EXPECTATIONS]) {
    pgm.sql(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_append_only;
      DELETE FROM ${table};
      ALTER TABLE ${table} ENABLE TRIGGER ${table}_append_only;`);
  }
  replaceShapes(pgm, "cloudflare");
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM ${EXPECTATIONS}) OR EXISTS (SELECT 1 FROM ${RECEIPTS})
    THEN RAISE EXCEPTION 'build cleanup evidence prevents a lossless migration downgrade'
      USING ERRCODE='23514'; END IF; END $$`);
  replaceShapes(pgm, "aws");
}

function replaceShapes(pgm, provider) {
  pgm.dropConstraint(EXPECTATIONS, `${EXPECTATIONS}_shape_check`);
  pgm.addConstraint(EXPECTATIONS, `${EXPECTATIONS}_shape_check`, {
    check: expectationShape(provider),
  });
  pgm.dropConstraint(RECEIPTS, `${RECEIPTS}_shape_check`);
  pgm.addConstraint(RECEIPTS, `${RECEIPTS}_shape_check`, { check: receiptShape(provider) });
}
