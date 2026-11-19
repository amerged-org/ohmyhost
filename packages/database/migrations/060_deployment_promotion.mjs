const deploymentEvents =
  "('DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1')";

export function up(pgm) {
  pgm.addColumns("deployments", {
    promotion_source_environment_id: { type: "ulid" },
    promotion_source_deployment_id: { type: "ulid" },
    promotion_source_revision_id: { type: "ulid" },
  });
  pgm.dropConstraint("deployments", "deployments_kind_status_check");
  pgm.addConstraint("deployments", "deployments_kind_status_check", {
    check: `kind IN ('deploy','rollback','promotion')
      AND status IN ('queued','running','succeeded','failed','reconciliation_required')
      AND ((kind='deploy' AND rollback_target_deployment_id IS NULL
            AND rollback_target_revision_id IS NULL AND promotion_source_environment_id IS NULL
            AND promotion_source_deployment_id IS NULL AND promotion_source_revision_id IS NULL)
        OR (kind='rollback' AND rollback_target_deployment_id IS NOT NULL
            AND rollback_target_revision_id IS NOT NULL AND promotion_source_environment_id IS NULL
            AND promotion_source_deployment_id IS NULL AND promotion_source_revision_id IS NULL)
        OR (kind='promotion' AND rollback_target_deployment_id IS NULL
            AND rollback_target_revision_id IS NULL AND promotion_source_environment_id IS NOT NULL
            AND promotion_source_deployment_id IS NOT NULL AND promotion_source_revision_id IS NOT NULL))`,
  });
  pgm.addConstraint("deployments", "deployments_promotion_source_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "promotion_source_environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployments", "deployments_promotion_source_revision_fkey", {
    foreignKeys: {
      columns: [
        "organization_id",
        "project_id",
        "promotion_source_deployment_id",
        "promotion_source_revision_id",
      ],
      references: "deployment_revisions (organization_id, project_id, deployment_id, revision_id)",
      onDelete: "RESTRICT",
      deferrable: true,
      initiallyDeferred: true,
    },
  });

  pgm.addColumns("product_command_intents", {
    source_environment_id: { type: "ulid" },
    source_deployment_id: { type: "ulid" },
    source_revision_id: { type: "ulid" },
    source_artifact_id: { type: "ulid" },
    source_artifact_sha256: { type: "bytea" },
    expected_source_head_version: { type: "integer" },
    expected_target_head_version: { type: "integer" },
  });
  pgm.addConstraint(
    "product_command_intents",
    "product_command_intents_promotion_source_environment_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "source_environment_id"],
        references: "environments (organization_id, project_id, environment_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "product_command_intents",
    "product_command_intents_promotion_source_revision_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "source_deployment_id", "source_revision_id"],
        references:
          "deployment_revisions (organization_id, project_id, deployment_id, revision_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "product_command_intents",
    "product_command_intents_promotion_source_artifact_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "source_artifact_id"],
        references: "build_artifacts (organization_id, project_id, artifact_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.dropConstraint("product_command_intents", "product_command_intents_shape_check");
  pgm.addConstraint("product_command_intents", "product_command_intents_shape_check", {
    check: `
      (event_type='SourceLinkRequestedV1'
       AND installation_id IS NOT NULL AND repository_owner IS NOT NULL AND repository_name IS NOT NULL
       AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL
       AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
       AND expected_etag IS NULL AND cleanup_run_id IS NULL
       AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL
       AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL
       AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL)
      OR (event_type='DeploymentRequestedV1'
       AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
       AND plan_id IS NOT NULL AND source_connection_id IS NOT NULL AND deployment_id IS NOT NULL
       AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
       AND expected_etag IS NULL AND cleanup_run_id IS NULL
       AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL
       AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL
       AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL)
      OR (event_type='DeploymentRollbackRequestedV1'
       AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
       AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NOT NULL
       AND target_deployment_id IS NOT NULL AND target_revision_id IS NOT NULL AND target_artifact_id IS NOT NULL
       AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL
       AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL
       AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL
       AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL)
      OR (event_type='DeploymentPromotionRequestedV1'
       AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
       AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NOT NULL
       AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
       AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL
       AND source_environment_id IS NOT NULL AND source_deployment_id IS NOT NULL
       AND source_revision_id IS NOT NULL AND source_artifact_id IS NOT NULL
       AND octet_length(source_artifact_sha256)=32 AND expected_source_head_version>=0
       AND expected_target_head_version>=0)
      OR (event_type='ProjectDeletionRequestedV1'
       AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
       AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL
       AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
       AND expected_etag IS NOT NULL AND cleanup_run_id IS NOT NULL
       AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL
       AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL
       AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL)`,
  });

  pgm.dropConstraint("action_confirmations", "action_confirmations_shape_check");
  pgm.addConstraint("action_confirmations", "action_confirmations_shape_check", {
    check: `action IN ('rollback','promote','delete')
      AND issued_to_principal_id=btrim(issued_to_principal_id)
      AND length(issued_to_principal_id) BETWEEN 1 AND 255
      AND subject_etag=btrim(subject_etag) AND length(subject_etag) BETWEEN 1 AND 255
      AND octet_length(token_sha256)=32 AND expires_at=created_at+interval '10 minutes'
      AND (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at)
      AND ((action IN ('rollback','promote') AND target_deployment_id IS NOT NULL)
        OR (action='delete' AND target_deployment_id IS NULL))`,
  });

  replaceEventChecks(pgm, true);
  replaceReconciliationEventChecks(pgm, true);
  replaceReconciliationPhaseCheck(pgm, true);
  pgm.dropConstraint(
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_lease_check",
  );
  pgm.addConstraint(
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_lease_check",
    {
      check: `(active_lease_id IS NULL AND claimed_generation IS NULL AND claimed_trigger IS NULL
          AND claimed_runtime_provider IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
      OR (active_lease_id IS NOT NULL AND claimed_generation IS NOT NULL
          AND claimed_generation>=applied_generation AND claimed_generation<=desired_generation
          AND claimed_trigger IN ('deploy','rollback','promotion','reconcile')
          AND claimed_runtime_provider IN ('wfp','container')
          AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at)`,
    },
  );
  pgm.dropConstraint(
    "runtime_secret_delivery_receipts",
    "runtime_secret_delivery_receipts_trigger_check",
  );
  pgm.addConstraint(
    "runtime_secret_delivery_receipts",
    "runtime_secret_delivery_receipts_trigger_check",
    {
      check: "trigger IN ('deploy','rollback','promotion','reconcile')",
    },
  );
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
    SELECT 1 FROM product_command_intents WHERE event_type='DeploymentPromotionRequestedV1'
    UNION ALL SELECT 1 FROM deployments WHERE kind='promotion'
    UNION ALL SELECT 1 FROM action_confirmations WHERE action='promote'
    UNION ALL SELECT 1 FROM runtime_secret_delivery_receipts WHERE trigger='promotion'
    UNION ALL SELECT 1 FROM runtime_secret_delivery_states WHERE claimed_trigger='promotion'
  ) THEN RAISE EXCEPTION 'promotion evidence prevents a lossless migration downgrade'
    USING ERRCODE='23514'; END IF; END $$`);
  pgm.dropConstraint(
    "runtime_secret_delivery_receipts",
    "runtime_secret_delivery_receipts_trigger_check",
  );
  pgm.addConstraint(
    "runtime_secret_delivery_receipts",
    "runtime_secret_delivery_receipts_trigger_check",
    {
      check: "trigger IN ('deploy','rollback','reconcile')",
    },
  );
  pgm.dropConstraint(
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_lease_check",
  );
  pgm.addConstraint(
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_lease_check",
    {
      check: `(active_lease_id IS NULL AND claimed_generation IS NULL AND claimed_trigger IS NULL
          AND claimed_runtime_provider IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
      OR (active_lease_id IS NOT NULL AND claimed_generation IS NOT NULL
          AND claimed_generation>=applied_generation AND claimed_generation<=desired_generation
          AND claimed_trigger IN ('deploy','rollback','reconcile')
          AND claimed_runtime_provider IN ('wfp','container')
          AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at)`,
    },
  );
  replaceReconciliationPhaseCheck(pgm, false);
  replaceReconciliationEventChecks(pgm, false);
  replaceEventChecks(pgm, false);
  pgm.dropConstraint("action_confirmations", "action_confirmations_shape_check");
  pgm.addConstraint("action_confirmations", "action_confirmations_shape_check", {
    check: `action IN ('rollback','delete') AND issued_to_principal_id=btrim(issued_to_principal_id)
      AND length(issued_to_principal_id) BETWEEN 1 AND 255
      AND subject_etag=btrim(subject_etag) AND length(subject_etag) BETWEEN 1 AND 255
      AND octet_length(token_sha256)=32 AND expires_at=created_at+interval '10 minutes'
      AND (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at)
      AND ((action='rollback' AND target_deployment_id IS NOT NULL)
        OR (action='delete' AND target_deployment_id IS NULL))`,
  });
  pgm.dropConstraint("product_command_intents", "product_command_intents_shape_check");
  pgm.dropConstraint(
    "product_command_intents",
    "product_command_intents_promotion_source_artifact_fkey",
  );
  pgm.dropConstraint(
    "product_command_intents",
    "product_command_intents_promotion_source_revision_fkey",
  );
  pgm.dropConstraint(
    "product_command_intents",
    "product_command_intents_promotion_source_environment_fkey",
  );
  pgm.dropColumns("product_command_intents", [
    "source_environment_id",
    "source_deployment_id",
    "source_revision_id",
    "source_artifact_id",
    "source_artifact_sha256",
    "expected_source_head_version",
    "expected_target_head_version",
  ]);
  pgm.addConstraint("product_command_intents", "product_command_intents_shape_check", {
    check: `
      (event_type='SourceLinkRequestedV1' AND installation_id IS NOT NULL AND repository_owner IS NOT NULL
       AND repository_name IS NOT NULL AND plan_id IS NULL AND source_connection_id IS NULL
       AND deployment_id IS NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL
       AND target_artifact_id IS NULL AND expected_etag IS NULL AND cleanup_run_id IS NULL)
      OR (event_type='DeploymentRequestedV1' AND installation_id IS NULL AND repository_owner IS NULL
       AND repository_name IS NULL AND plan_id IS NOT NULL AND source_connection_id IS NOT NULL
       AND deployment_id IS NOT NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL
       AND target_artifact_id IS NULL AND expected_etag IS NULL AND cleanup_run_id IS NULL)
      OR (event_type='DeploymentRollbackRequestedV1' AND installation_id IS NULL AND repository_owner IS NULL
       AND repository_name IS NULL AND plan_id IS NULL AND source_connection_id IS NULL
       AND deployment_id IS NOT NULL AND target_deployment_id IS NOT NULL AND target_revision_id IS NOT NULL
       AND target_artifact_id IS NOT NULL AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL)
      OR (event_type='ProjectDeletionRequestedV1' AND installation_id IS NULL AND repository_owner IS NULL
       AND repository_name IS NULL AND plan_id IS NULL AND source_connection_id IS NULL
       AND deployment_id IS NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL
       AND target_artifact_id IS NULL AND expected_etag IS NOT NULL AND cleanup_run_id IS NOT NULL)`,
  });
  pgm.dropConstraint("deployments", "deployments_promotion_source_revision_fkey");
  pgm.dropConstraint("deployments", "deployments_promotion_source_environment_fkey");
  pgm.dropConstraint("deployments", "deployments_kind_status_check");
  pgm.dropColumns("deployments", [
    "promotion_source_environment_id",
    "promotion_source_deployment_id",
    "promotion_source_revision_id",
  ]);
  pgm.addConstraint("deployments", "deployments_kind_status_check", {
    check: `kind IN ('deploy','rollback') AND status IN ('queued','running','succeeded','failed','reconciliation_required')
      AND ((kind='deploy' AND rollback_target_deployment_id IS NULL AND rollback_target_revision_id IS NULL)
        OR (kind='rollback' AND rollback_target_deployment_id IS NOT NULL AND rollback_target_revision_id IS NOT NULL))`,
  });
}

function replaceEventChecks(pgm, includePromotion) {
  const events = includePromotion
    ? deploymentEvents
    : "('DeploymentRequestedV1','DeploymentRollbackRequestedV1')";
  pgm.dropConstraint("product_workflow_runs", "product_workflow_runs_shape_check");
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_shape_check", {
    check: `workflow_id=btrim(workflow_id) AND length(workflow_id) BETWEEN 1 AND 255
      AND event_type IN ('SourceLinkRequestedV1','DeploymentRequestedV1','DeploymentRollbackRequestedV1'${includePromotion ? ",'DeploymentPromotionRequestedV1'" : ""},'ProjectDeletionRequestedV1')
      AND state IN ('queued','completed','reconciliation_required') AND updated_at>=created_at
      AND ((state='queued' AND terminal_evidence IS NULL AND reconciliation_code IS NULL AND completed_at IS NULL)
        OR (state='completed' AND jsonb_typeof(terminal_evidence)='object' AND reconciliation_code IS NULL AND completed_at IS NOT NULL)
        OR (state='reconciliation_required' AND terminal_evidence IS NULL
            AND reconciliation_code=btrim(reconciliation_code) AND length(reconciliation_code) BETWEEN 1 AND 128
            AND completed_at IS NULL))`,
  });
  pgm.dropConstraint(
    "product_provider_mutation_claims",
    "product_provider_mutation_claims_shape_check",
  );
  pgm.addConstraint(
    "product_provider_mutation_claims",
    "product_provider_mutation_claims_shape_check",
    {
      check: `event_type IN ${events} AND accepted_lifecycle_version>0
      AND logical_workflow_id=btrim(logical_workflow_id) AND length(logical_workflow_id) BETWEEN 1 AND 255`,
    },
  );
}

function replaceReconciliationEventChecks(pgm, includePromotion) {
  const previous = includePromotion
    ? "ARRAY['DeploymentRequestedV1'::text, 'DeploymentRollbackRequestedV1'::text]"
    : "ARRAY['DeploymentRequestedV1'::text, 'DeploymentRollbackRequestedV1'::text, 'DeploymentPromotionRequestedV1'::text]";
  const next = includePromotion
    ? "ARRAY['DeploymentRequestedV1'::text, 'DeploymentRollbackRequestedV1'::text, 'DeploymentPromotionRequestedV1'::text]"
    : "ARRAY['DeploymentRequestedV1'::text, 'DeploymentRollbackRequestedV1'::text]";
  for (const [table, constraint] of [
    [
      "product_provider_mutation_observations",
      "product_provider_mutation_observations_shape_check",
    ],
    [
      "product_provider_reconciliation_attempts",
      "product_provider_reconciliation_attempts_shape_check",
    ],
  ]) {
    pgm.sql(`DO $$ DECLARE definition text; replaced text; BEGIN
      SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
      WHERE conrelid='${table}'::regclass AND conname='${constraint}';
      replaced := replace(definition, '${previous.replaceAll("'", "''")}', '${next.replaceAll("'", "''")}');
      IF replaced=definition THEN RAISE EXCEPTION 'promotion reconciliation constraint shape is unexpected'
        USING ERRCODE='23514', CONSTRAINT='${constraint}'; END IF;
      EXECUTE 'ALTER TABLE ${table} DROP CONSTRAINT ${constraint}';
      EXECUTE 'ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ' || replaced;
    END $$`);
  }
}

function replaceReconciliationPhaseCheck(pgm, includeStorage) {
  const previous = includeStorage
    ? "ARRAY['source'::text, 'build'::text, 'database'::text, 'runtime-secrets'::text, 'gateway'::text, 'wfp'::text, 'container'::text]"
    : "ARRAY['source'::text, 'build'::text, 'database'::text, 'runtime-secrets'::text, 'storage'::text, 'gateway'::text, 'wfp'::text, 'container'::text]";
  const next = includeStorage
    ? "ARRAY['source'::text, 'build'::text, 'database'::text, 'runtime-secrets'::text, 'storage'::text, 'gateway'::text, 'wfp'::text, 'container'::text]"
    : "ARRAY['source'::text, 'build'::text, 'database'::text, 'runtime-secrets'::text, 'gateway'::text, 'wfp'::text, 'container'::text]";
  pgm.sql(`DO $$ DECLARE definition text; replaced text; BEGIN
    SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='product_provider_mutation_observations'::regclass
      AND conname='product_provider_mutation_observations_shape_check';
    replaced := replace(definition, '${previous.replaceAll("'", "''")}', '${next.replaceAll("'", "''")}');
    IF replaced=definition THEN RAISE EXCEPTION 'provider reconciliation phase constraint shape is unexpected'
      USING ERRCODE='23514', CONSTRAINT='product_provider_mutation_observations_shape_check'; END IF;
    EXECUTE 'ALTER TABLE product_provider_mutation_observations DROP CONSTRAINT product_provider_mutation_observations_shape_check';
    EXECUTE 'ALTER TABLE product_provider_mutation_observations ADD CONSTRAINT product_provider_mutation_observations_shape_check ' || replaced;
  END $$`);
}
