const TABLE = "scheduled_function_workflow_receipts";
const CONSTRAINT = "scheduled_function_workflow_receipts_shape_check";

export function up(pgm) {
  pgm.dropConstraint(TABLE, CONSTRAINT);
  pgm.addConstraint(TABLE, CONSTRAINT, {
    check: `workflow_id~'^scheduled-function-v1-[0-7][0-9A-HJKMNP-TV-Z]{25}$'
      AND outcome IN ('started','adopted')`,
  });
  pgm.sql(`UPDATE scheduled_function_slots slot SET state='stale_acked',
    active_lease_id=NULL,claimed_at=NULL,lease_expires_at=NULL,
    publication_claim_id=NULL,publication_claimed_at=NULL,publication_lease_expires_at=NULL,
    updated_at=now()
    WHERE state IN ('queued','retry_pending','running') AND NOT EXISTS (
      SELECT 1 FROM scheduled_function_heads head
      WHERE head.organization_id=slot.organization_id AND head.project_id=slot.project_id
        AND head.environment_id=slot.environment_id AND head.function_id=slot.function_id
        AND head.enabled AND head.definition_id=slot.definition_id
        AND head.deployment_id=slot.deployment_id)`);
}

export function down(pgm) {
  pgm.dropConstraint(TABLE, CONSTRAINT);
  pgm.sql(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT}
    CHECK (workflow_id~'^scheduled-function-v1-01[0-9A-HJKMNP-TV-Z]{24}$'
      AND outcome IN ('started','adopted')) NOT VALID`);
}
