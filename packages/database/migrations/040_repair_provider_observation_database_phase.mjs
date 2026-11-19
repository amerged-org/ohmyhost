export function up(pgm) {
  replaceObservationConstraint(pgm);
}

export function down(pgm) {
  replaceObservationConstraint(pgm);
}

function replaceObservationConstraint(pgm) {
  pgm.dropConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
  );
  pgm.addConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
    {
      check: `attempt_number BETWEEN 0 AND 5
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
