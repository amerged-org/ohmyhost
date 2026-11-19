const PREVIOUS_ATTEMPTS = 5;
const CURRENT_ATTEMPTS = 20;
const HISTORICAL_OBSERVATION_ATTEMPTS = 24;
const HISTORICAL_INCIDENT_CUTOFF = "2026-08-23T08:00:00.000Z";

export function up(pgm) {
  const historicalCheck = historicalIncidentCheck();
  replaceObservationConstraint(pgm, HISTORICAL_OBSERVATION_ATTEMPTS, historicalCheck);
  replaceAttemptConstraint(pgm, HISTORICAL_OBSERVATION_ATTEMPTS, historicalCheck);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
    SELECT 1 FROM product_provider_reconciliation_attempts WHERE attempt_number>${PREVIOUS_ATTEMPTS}
    UNION ALL
    SELECT 1 FROM product_provider_mutation_observations WHERE attempt_number>${PREVIOUS_ATTEMPTS}
  ) THEN RAISE EXCEPTION 'provider reconciliation evidence prevents a lossless migration downgrade'
    USING ERRCODE='23514'; END IF; END $$`);
  replaceObservationConstraint(pgm, PREVIOUS_ATTEMPTS);
  replaceAttemptConstraint(pgm, PREVIOUS_ATTEMPTS);
}

export function replaceObservationConstraint(pgm, maximumAttempts, additionalCheck = "") {
  pgm.dropConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
  );
  pgm.addConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
    {
      check: `attempt_number BETWEEN 0 AND ${maximumAttempts}
        ${additionalCheck}
        AND observation_kind IN ('uncertainty','preflight','execution_failure')
        AND event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1')
        AND accepted_lifecycle_version>0 AND octet_length(evidence_sha256)=32
        AND hint_phase IN ('source','build','database','runtime-secrets','gateway','wfp','container')
        AND (expected_artifact_sha256 IS NULL OR octet_length(expected_artifact_sha256)=32)
        AND source_state IN ('unknown','absent','ready','succeeded','running','failed','cleanup_failable')
        AND build_state IN ('unknown','absent','ready','succeeded','running','failed','cleanup_failable')
        AND gateway_state IN ('unknown','absent','ready')
        AND wfp_state IN ('unknown','absent','ready')
        AND ((gateway_state='ready' AND gateway_provider_tag IS NOT NULL)
          OR (gateway_state='absent' AND gateway_provider_tag IS NULL) OR gateway_state='unknown')
        AND ((wfp_state='ready' AND wfp_provider_tag IS NOT NULL
              AND wfp_product_deployment_id IS NOT NULL AND octet_length(wfp_artifact_sha256)=32)
          OR (wfp_state='absent' AND wfp_provider_tag IS NULL
              AND wfp_product_deployment_id IS NULL AND wfp_artifact_sha256 IS NULL)
          OR wfp_state='unknown')
        AND container_state IN ('unknown','absent','running','ready')
        AND ((container_state='ready' AND container_application_id IS NOT NULL
              AND container_product_deployment_id IS NOT NULL
              AND octet_length(container_image_sha256)=32 AND container_health_status=200
              AND container_observed_at IS NOT NULL)
          OR (container_state='running' AND container_application_id IS NOT NULL
              AND container_product_deployment_id IS NOT NULL
              AND octet_length(container_image_sha256)=32 AND container_health_status IS NULL
              AND container_observed_at IS NOT NULL)
          OR (container_state='absent' AND container_application_id IS NULL
              AND container_product_deployment_id IS NULL AND container_image_sha256 IS NULL
              AND container_health_status IS NULL)
          OR (container_state='unknown' AND container_health_status IS NULL
              AND ((container_application_id IS NULL
                    AND container_product_deployment_id IS NULL AND container_image_sha256 IS NULL)
                OR (container_application_id IS NOT NULL
                    AND container_product_deployment_id IS NOT NULL
                    AND octet_length(container_image_sha256)=32))))
        AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
    },
  );
}

export function replaceAttemptConstraint(pgm, maximumAttempts, additionalCheck = "") {
  pgm.dropConstraint(
    "product_provider_reconciliation_attempts",
    "product_provider_reconciliation_attempts_shape_check",
  );
  pgm.addConstraint(
    "product_provider_reconciliation_attempts",
    "product_provider_reconciliation_attempts_shape_check",
    {
      check: `mode IN ('retry','abandon') AND outcome IN ('prepared','resolved_absent','unknown')
        AND ((mode='retry' AND outcome='prepared') OR (mode='abandon' AND outcome='resolved_absent')
          OR outcome='unknown')
        AND octet_length(idempotency_sha256)=32 AND attempt_number BETWEEN 1 AND ${maximumAttempts}
        ${additionalCheck}
        AND event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1')
        AND accepted_lifecycle_version>0
        AND logical_workflow_id=btrim(logical_workflow_id) AND length(logical_workflow_id) BETWEEN 1 AND 255
        AND physical_workflow_id=btrim(physical_workflow_id) AND length(physical_workflow_id) BETWEEN 1 AND 255
        AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
    },
  );
}

function historicalIncidentCheck() {
  return `AND (attempt_number<=${CURRENT_ATTEMPTS}
          OR created_at<'${HISTORICAL_INCIDENT_CUTOFF}'::timestamptz)`;
}
