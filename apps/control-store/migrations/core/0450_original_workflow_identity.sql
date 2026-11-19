-- Original047/118/167 accepted Workflow identity. No generated IDs or evidence rewrite.
-- The prototype restricted a Workflow to a ULID and admitted the nonexistent running state.
-- Preserve every populated row through native guarded replacement, with foreign keys always enabled.
CREATE UNIQUE INDEX product_command_intents_original_identity ON product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type);
CREATE UNIQUE INDEX outbox_events_original_identity ON outbox_events(event_id,organization_id,project_id,operation_id,billing_epoch_id);
CREATE TABLE _0450_product_workflow_runs AS SELECT * FROM product_workflow_runs;
DROP TABLE product_workflow_runs;
CREATE TABLE product_workflow_runs (
  organization_id TEXT NOT NULL, operation_id TEXT NOT NULL, event_type TEXT NOT NULL,
  workflow_id TEXT NOT NULL CHECK(workflow_id=trim(workflow_id) AND length(workflow_id) BETWEEN 1 AND 255),
  event_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, billing_epoch_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','reconciliation_required','completed')),
  terminal_evidence TEXT CHECK(terminal_evidence IS NULL OR json_valid(terminal_evidence)),
  intermediate_evidence TEXT CHECK(intermediate_evidence IS NULL OR json_valid(intermediate_evidence)),
  evidence_archive_key TEXT, reconciliation_code TEXT,
  active_reconciliation_attempt_id TEXT, active_replay_attempt_id TEXT,
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at>=created_at),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(workflow_id),
  UNIQUE(workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type),
  UNIQUE(organization_id,project_id,environment_id,operation_id),
  FOREIGN KEY(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type)
    REFERENCES product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type),
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
  FOREIGN KEY(event_id,organization_id,project_id,operation_id,billing_epoch_id)
    REFERENCES outbox_events(event_id,organization_id,project_id,operation_id,billing_epoch_id),
  FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
  CHECK(event_type IN ('SourceLinkRequestedV1','DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1','ProjectDeletionRequestedV1','ProjectDataChangeRequestedV1','ProjectHandleChangeRequestedV1')),
  CHECK((state='queued' AND terminal_evidence IS NULL AND reconciliation_code IS NULL AND completed_at IS NULL)
    OR (state='completed' AND json_type(terminal_evidence)='object' AND reconciliation_code IS NULL AND completed_at IS NOT NULL)
    OR (state='reconciliation_required' AND terminal_evidence IS NULL AND reconciliation_code=trim(reconciliation_code) AND length(reconciliation_code) BETWEEN 1 AND 128 AND completed_at IS NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO product_workflow_runs SELECT * FROM _0450_product_workflow_runs;
DROP TABLE _0450_product_workflow_runs;
