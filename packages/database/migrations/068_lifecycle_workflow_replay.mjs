const COMMON_SHAPE = `
  AND octet_length(idempotency_sha256)=32 AND attempt_number BETWEEN 1 AND 5
  AND logical_workflow_id=btrim(logical_workflow_id)
  AND length(logical_workflow_id) BETWEEN 1 AND 255
  AND physical_workflow_id=btrim(physical_workflow_id)
  AND length(physical_workflow_id) BETWEEN 1 AND 255
  AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`;

function replaceShape(pgm, eventTypes) {
  pgm.dropConstraint("product_workflow_replay_attempts", "product_workflow_replay_attempts_shape");
  pgm.addConstraint("product_workflow_replay_attempts", "product_workflow_replay_attempts_shape", {
    check: `event_type IN (${eventTypes.map((value) => `'${value}'`).join(",")})${COMMON_SHAPE}`,
  });
}

export function up(pgm) {
  replaceShape(pgm, [
    "SourceLinkRequestedV1",
    "ProjectDeletionRequestedV1",
    "DeploymentRollbackRequestedV1",
    "DeploymentPromotionRequestedV1",
  ]);
}

export function down(pgm) {
  replaceShape(pgm, ["SourceLinkRequestedV1", "ProjectDeletionRequestedV1"]);
}
