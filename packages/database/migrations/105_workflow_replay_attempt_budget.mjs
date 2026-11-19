const EVENT_TYPES = [
  "SourceLinkRequestedV1",
  "ProjectDeletionRequestedV1",
  "DeploymentRollbackRequestedV1",
  "DeploymentPromotionRequestedV1",
];

export function up(pgm) {
  replaceShape(pgm, 32);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
    SELECT 1 FROM product_workflow_replay_attempts WHERE attempt_number>5
  ) THEN RAISE EXCEPTION 'workflow replay evidence prevents a lossless migration downgrade'
    USING ERRCODE='23514'; END IF; END $$`);
  replaceShape(pgm, 5);
}

function replaceShape(pgm, maximumAttempts) {
  pgm.dropConstraint("product_workflow_replay_attempts", "product_workflow_replay_attempts_shape");
  pgm.addConstraint("product_workflow_replay_attempts", "product_workflow_replay_attempts_shape", {
    check: `event_type IN (${EVENT_TYPES.map((value) => `'${value}'`).join(",")})
      AND octet_length(idempotency_sha256)=32 AND attempt_number BETWEEN 1 AND ${maximumAttempts}
      AND logical_workflow_id=btrim(logical_workflow_id)
      AND length(logical_workflow_id) BETWEEN 1 AND 255
      AND physical_workflow_id=btrim(physical_workflow_id)
      AND length(physical_workflow_id) BETWEEN 1 AND 255
      AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
  });
}
