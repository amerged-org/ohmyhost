-- Original021/024/038/040/043/045/055/060/068/105/125 current native evidence and attempt identities.
-- Unserved source correction; original evidence outlives ephemeral claims.
-- Current-claim INSERT admission belongs to the closed record effects, not historical import replay.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);

CREATE TABLE product_provider_mutation_observations (
 observation_id TEXT NOT NULL CHECK((length(observation_id)=26 AND length(CAST(observation_id AS BLOB))=26 AND substr(observation_id,1,1) BETWEEN '0' AND '7' AND observation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 claim_id TEXT NOT NULL CHECK((length(claim_id)=26 AND length(CAST(claim_id AS BLOB))=26 AND substr(claim_id,1,1) BETWEEN '0' AND '7' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 organization_id TEXT NOT NULL CHECK((length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 project_id TEXT NOT NULL CHECK((length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 environment_id TEXT NOT NULL CHECK((length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 operation_id TEXT NOT NULL CHECK((length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 event_id TEXT NOT NULL CHECK((length(event_id)=26 AND length(CAST(event_id AS BLOB))=26 AND substr(event_id,1,1) BETWEEN '0' AND '7' AND event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 billing_epoch_id TEXT NOT NULL CHECK((length(billing_epoch_id)=26 AND length(CAST(billing_epoch_id AS BLOB))=26 AND substr(billing_epoch_id,1,1) BETWEEN '0' AND '7' AND billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 logical_workflow_id TEXT NOT NULL CHECK((instr(logical_workflow_id,char(0))=0)),
 event_type TEXT NOT NULL CHECK((instr(event_type,char(0))=0)),
 accepted_lifecycle_version INTEGER NOT NULL CHECK((accepted_lifecycle_version BETWEEN -2147483648 AND 2147483647)),
 observation_kind TEXT NOT NULL CHECK((instr(observation_kind,char(0))=0)),
 attempt_number INTEGER NOT NULL CHECK((attempt_number BETWEEN -2147483648 AND 2147483647)),
 evidence_sha256 BLOB NOT NULL,
 hint_phase TEXT NOT NULL CHECK((instr(hint_phase,char(0))=0)),
 expected_artifact_sha256 BLOB,
 hint_provider_tag TEXT CHECK(hint_provider_tag IS NULL OR (instr(hint_provider_tag,char(0))=0)),
 hint_product_deployment_id TEXT CHECK(hint_product_deployment_id IS NULL OR (length(hint_product_deployment_id)=26 AND length(CAST(hint_product_deployment_id AS BLOB))=26 AND substr(hint_product_deployment_id,1,1) BETWEEN '0' AND '7' AND hint_product_deployment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 source_state TEXT NOT NULL CHECK((instr(source_state,char(0))=0)),
 build_state TEXT NOT NULL CHECK((instr(build_state,char(0))=0)),
 gateway_state TEXT NOT NULL CHECK((instr(gateway_state,char(0))=0)),
 gateway_provider_tag TEXT CHECK(gateway_provider_tag IS NULL OR (instr(gateway_provider_tag,char(0))=0)),
 gateway_observed_at TEXT CHECK(gateway_observed_at IS NULL OR ((gateway_observed_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(gateway_observed_at AS BLOB))=27 AND substr(gateway_observed_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(gateway_observed_at,1,10),'+0 days')=substr(gateway_observed_at,1,10) AND substr(gateway_observed_at,12,2) BETWEEN '00' AND '23' AND substr(gateway_observed_at,15,2) BETWEEN '00' AND '59' AND substr(gateway_observed_at,18,2) BETWEEN '00' AND '59' AND (substr(gateway_observed_at,12,2)||substr(gateway_observed_at,15,2)||substr(gateway_observed_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(gateway_observed_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE)),
 wfp_state TEXT NOT NULL CHECK((instr(wfp_state,char(0))=0)),
 wfp_provider_tag TEXT CHECK(wfp_provider_tag IS NULL OR (instr(wfp_provider_tag,char(0))=0)),
 wfp_product_deployment_id TEXT CHECK(wfp_product_deployment_id IS NULL OR (length(wfp_product_deployment_id)=26 AND length(CAST(wfp_product_deployment_id AS BLOB))=26 AND substr(wfp_product_deployment_id,1,1) BETWEEN '0' AND '7' AND wfp_product_deployment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 wfp_artifact_sha256 BLOB,
 wfp_observed_at TEXT CHECK(wfp_observed_at IS NULL OR ((wfp_observed_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(wfp_observed_at AS BLOB))=27 AND substr(wfp_observed_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(wfp_observed_at,1,10),'+0 days')=substr(wfp_observed_at,1,10) AND substr(wfp_observed_at,12,2) BETWEEN '00' AND '23' AND substr(wfp_observed_at,15,2) BETWEEN '00' AND '59' AND substr(wfp_observed_at,18,2) BETWEEN '00' AND '59' AND (substr(wfp_observed_at,12,2)||substr(wfp_observed_at,15,2)||substr(wfp_observed_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(wfp_observed_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE)),
 actor_id TEXT NOT NULL CHECK((instr(actor_id,char(0))=0)),
 created_at TEXT NOT NULL CHECK(((created_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(created_at AS BLOB))=27 AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(created_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE)),
 CONSTRAINT product_provider_mutation_observations_shape_check CHECK (((attempt_number >= 0) AND (attempt_number <= 32) AND (observation_kind IN ('uncertainty', 'preflight', 'execution_failure')) AND (event_type IN ('DeploymentRequestedV1', 'DeploymentRollbackRequestedV1', 'DeploymentPromotionRequestedV1', 'ProjectDataChangeRequestedV1', 'ProjectHandleChangeRequestedV1')) AND (accepted_lifecycle_version > 0) AND (length(evidence_sha256) = 32) AND (hint_phase IN ('source', 'build', 'database', 'runtime-secrets', 'storage', 'gateway', 'wfp')) AND ((expected_artifact_sha256 IS NULL) OR (length(expected_artifact_sha256) = 32)) AND (source_state IN ('unknown', 'absent', 'ready', 'succeeded', 'running', 'failed', 'cleanup_failable')) AND (build_state IN ('unknown', 'absent', 'ready', 'succeeded', 'running', 'failed', 'cleanup_failable')) AND (gateway_state IN ('unknown', 'absent', 'ready')) AND (wfp_state IN ('unknown', 'absent', 'ready')) AND (((gateway_state = 'ready') AND (gateway_provider_tag IS NOT NULL)) OR ((gateway_state = 'absent') AND (gateway_provider_tag IS NULL)) OR (gateway_state = 'unknown')) AND (((wfp_state = 'ready') AND (wfp_provider_tag IS NOT NULL) AND (wfp_product_deployment_id IS NOT NULL) AND (length(wfp_artifact_sha256) = 32)) OR ((wfp_state = 'absent') AND (wfp_provider_tag IS NULL) AND (wfp_product_deployment_id IS NULL) AND (wfp_artifact_sha256 IS NULL)) OR (wfp_state = 'unknown')) AND (actor_id = trim(actor_id)) AND ((length(actor_id) >= 1) AND (length(actor_id) <= 255)))),
 CONSTRAINT product_provider_mutation_observations_attempt_key UNIQUE (claim_id, attempt_number, observation_kind),
 CONSTRAINT product_provider_mutation_observations_full_identity_key UNIQUE (observation_id, claim_id, organization_id, project_id, environment_id, operation_id, event_id, billing_epoch_id, logical_workflow_id, event_type, accepted_lifecycle_version),
 CONSTRAINT product_provider_mutation_observations_pkey PRIMARY KEY (observation_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER product_provider_mutation_observations_no_update BEFORE UPDATE ON product_provider_mutation_observations
BEGIN SELECT RAISE(ABORT,'product_provider_mutation_observations is append-only'); END;

CREATE TRIGGER product_provider_mutation_observations_no_delete BEFORE DELETE ON product_provider_mutation_observations
BEGIN SELECT RAISE(ABORT,'product_provider_mutation_observations is append-only'); END;

CREATE TABLE product_provider_reconciliation_attempts (
 attempt_id TEXT NOT NULL CHECK((length(attempt_id)=26 AND length(CAST(attempt_id AS BLOB))=26 AND substr(attempt_id,1,1) BETWEEN '0' AND '7' AND attempt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 observation_id TEXT NOT NULL CHECK((length(observation_id)=26 AND length(CAST(observation_id AS BLOB))=26 AND substr(observation_id,1,1) BETWEEN '0' AND '7' AND observation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 claim_id TEXT NOT NULL CHECK((length(claim_id)=26 AND length(CAST(claim_id AS BLOB))=26 AND substr(claim_id,1,1) BETWEEN '0' AND '7' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 organization_id TEXT NOT NULL CHECK((length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 project_id TEXT NOT NULL CHECK((length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 environment_id TEXT NOT NULL CHECK((length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 operation_id TEXT NOT NULL CHECK((length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 event_id TEXT NOT NULL CHECK((length(event_id)=26 AND length(CAST(event_id AS BLOB))=26 AND substr(event_id,1,1) BETWEEN '0' AND '7' AND event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 billing_epoch_id TEXT NOT NULL CHECK((length(billing_epoch_id)=26 AND length(CAST(billing_epoch_id AS BLOB))=26 AND substr(billing_epoch_id,1,1) BETWEEN '0' AND '7' AND billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 logical_workflow_id TEXT NOT NULL CHECK((instr(logical_workflow_id,char(0))=0)),
 event_type TEXT NOT NULL CHECK((instr(event_type,char(0))=0)),
 accepted_lifecycle_version INTEGER NOT NULL CHECK((accepted_lifecycle_version BETWEEN -2147483648 AND 2147483647)),
 physical_workflow_id TEXT NOT NULL CHECK((instr(physical_workflow_id,char(0))=0)),
 mode TEXT NOT NULL CHECK((instr(mode,char(0))=0)),
 outcome TEXT NOT NULL CHECK((instr(outcome,char(0))=0)),
 idempotency_sha256 BLOB NOT NULL,
 attempt_number INTEGER NOT NULL CHECK((attempt_number BETWEEN -2147483648 AND 2147483647)),
 actor_id TEXT NOT NULL CHECK((instr(actor_id,char(0))=0)),
 created_at TEXT NOT NULL CHECK(((created_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(created_at AS BLOB))=27 AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(created_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE)),
 CONSTRAINT product_provider_reconciliation_attempts_shape_check CHECK (((mode IN ('retry', 'abandon')) AND (outcome IN ('prepared', 'resolved_absent', 'unknown')) AND (((mode = 'retry') AND (outcome = 'prepared')) OR ((mode = 'abandon') AND (outcome = 'resolved_absent')) OR (outcome = 'unknown')) AND (length(idempotency_sha256) = 32) AND ((attempt_number >= 1) AND (attempt_number <= 32)) AND (event_type IN ('DeploymentRequestedV1', 'DeploymentRollbackRequestedV1', 'DeploymentPromotionRequestedV1', 'ProjectDataChangeRequestedV1', 'ProjectHandleChangeRequestedV1')) AND (accepted_lifecycle_version > 0) AND (logical_workflow_id = trim(logical_workflow_id)) AND ((length(logical_workflow_id) >= 1) AND (length(logical_workflow_id) <= 255)) AND (physical_workflow_id = trim(physical_workflow_id)) AND ((length(physical_workflow_id) >= 1) AND (length(physical_workflow_id) <= 255)) AND (actor_id = trim(actor_id)) AND ((length(actor_id) >= 1) AND (length(actor_id) <= 255)))),
 CONSTRAINT product_provider_reconciliation_attemp_physical_workflow_id_key UNIQUE (physical_workflow_id),
 CONSTRAINT product_provider_reconciliation_attempts_idempotency_key UNIQUE (claim_id, idempotency_sha256),
 CONSTRAINT product_provider_reconciliation_attempts_pkey PRIMARY KEY (attempt_id),
 CONSTRAINT product_provider_reconciliation_attempts_workflow_identity_key UNIQUE (attempt_id, logical_workflow_id, event_id, organization_id, project_id, environment_id, operation_id, billing_epoch_id, event_type),
 CONSTRAINT product_provider_reconciliation_attempts_observation_fkey FOREIGN KEY (observation_id, claim_id, organization_id, project_id, environment_id, operation_id, event_id, billing_epoch_id, logical_workflow_id, event_type, accepted_lifecycle_version) REFERENCES product_provider_mutation_observations(observation_id, claim_id, organization_id, project_id, environment_id, operation_id, event_id, billing_epoch_id, logical_workflow_id, event_type, accepted_lifecycle_version) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER product_provider_reconciliation_attempts_no_update BEFORE UPDATE ON product_provider_reconciliation_attempts
BEGIN SELECT RAISE(ABORT,'product_provider_reconciliation_attempts is append-only'); END;

CREATE TRIGGER product_provider_reconciliation_attempts_no_delete BEFORE DELETE ON product_provider_reconciliation_attempts
BEGIN SELECT RAISE(ABORT,'product_provider_reconciliation_attempts is append-only'); END;

CREATE TABLE product_workflow_replay_attempts (
 attempt_id TEXT NOT NULL CHECK((length(attempt_id)=26 AND length(CAST(attempt_id AS BLOB))=26 AND substr(attempt_id,1,1) BETWEEN '0' AND '7' AND attempt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 organization_id TEXT NOT NULL CHECK((length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 project_id TEXT NOT NULL CHECK((length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 environment_id TEXT NOT NULL CHECK((length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 operation_id TEXT NOT NULL CHECK((length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 event_id TEXT NOT NULL CHECK((length(event_id)=26 AND length(CAST(event_id AS BLOB))=26 AND substr(event_id,1,1) BETWEEN '0' AND '7' AND event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 billing_epoch_id TEXT NOT NULL CHECK((length(billing_epoch_id)=26 AND length(CAST(billing_epoch_id AS BLOB))=26 AND substr(billing_epoch_id,1,1) BETWEEN '0' AND '7' AND billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 logical_workflow_id TEXT NOT NULL CHECK((instr(logical_workflow_id,char(0))=0)),
 physical_workflow_id TEXT NOT NULL CHECK((instr(physical_workflow_id,char(0))=0)),
 event_type TEXT NOT NULL CHECK((instr(event_type,char(0))=0)),
 idempotency_sha256 BLOB NOT NULL,
 attempt_number INTEGER NOT NULL CHECK((attempt_number BETWEEN -2147483648 AND 2147483647)),
 actor_id TEXT NOT NULL CHECK((instr(actor_id,char(0))=0)),
 created_at TEXT NOT NULL CHECK(((created_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(created_at AS BLOB))=27 AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(created_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE)),
 CONSTRAINT product_workflow_replay_attempts_shape CHECK (((event_type IN ('SourceLinkRequestedV1', 'ProjectDeletionRequestedV1', 'ProjectDataChangeRequestedV1', 'DeploymentRollbackRequestedV1', 'DeploymentPromotionRequestedV1', 'ProjectHandleChangeRequestedV1')) AND (length(idempotency_sha256) = 32) AND ((attempt_number >= 1) AND (attempt_number <= 32)) AND (logical_workflow_id = trim(logical_workflow_id)) AND ((length(logical_workflow_id) >= 1) AND (length(logical_workflow_id) <= 255)) AND (physical_workflow_id = trim(physical_workflow_id)) AND ((length(physical_workflow_id) >= 1) AND (length(physical_workflow_id) <= 255)) AND (actor_id = trim(actor_id)) AND ((length(actor_id) >= 1) AND (length(actor_id) <= 255)))),
 CONSTRAINT product_workflow_replay_attempts_failure_identity_key UNIQUE (attempt_id, organization_id, operation_id, physical_workflow_id, actor_id),
 CONSTRAINT product_workflow_replay_attempts_idempotency_key UNIQUE (organization_id, operation_id, idempotency_sha256),
 CONSTRAINT product_workflow_replay_attempts_identity_key UNIQUE (attempt_id, logical_workflow_id, event_id, organization_id, project_id, environment_id, operation_id, billing_epoch_id, event_type),
 CONSTRAINT product_workflow_replay_attempts_physical_workflow_id_key UNIQUE (physical_workflow_id),
 CONSTRAINT product_workflow_replay_attempts_pkey PRIMARY KEY (attempt_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER product_workflow_replay_attempts_no_update BEFORE UPDATE ON product_workflow_replay_attempts
BEGIN SELECT RAISE(ABORT,'product_workflow_replay_attempts is append-only'); END;

CREATE TRIGGER product_workflow_replay_attempts_no_delete BEFORE DELETE ON product_workflow_replay_attempts
BEGIN SELECT RAISE(ABORT,'product_workflow_replay_attempts is append-only'); END;

CREATE TABLE product_workflow_replay_failures (
 failure_id TEXT NOT NULL CHECK((length(failure_id)=26 AND length(CAST(failure_id AS BLOB))=26 AND substr(failure_id,1,1) BETWEEN '0' AND '7' AND failure_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 attempt_id TEXT NOT NULL CHECK((length(attempt_id)=26 AND length(CAST(attempt_id AS BLOB))=26 AND substr(attempt_id,1,1) BETWEEN '0' AND '7' AND attempt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 organization_id TEXT NOT NULL CHECK((length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 operation_id TEXT NOT NULL CHECK((length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 physical_workflow_id TEXT NOT NULL CHECK((instr(physical_workflow_id,char(0))=0)),
 terminal_status TEXT NOT NULL CHECK((instr(terminal_status,char(0))=0)),
 evidence_sha256 BLOB NOT NULL,
 actor_id TEXT NOT NULL CHECK((instr(actor_id,char(0))=0)),
 created_at TEXT NOT NULL CHECK(((created_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(created_at AS BLOB))=27 AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(created_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE)),
 CONSTRAINT product_workflow_replay_failures_shape CHECK (((terminal_status IN ('errored', 'terminated')) AND (length(evidence_sha256) = 32) AND (physical_workflow_id = trim(physical_workflow_id)) AND ((length(physical_workflow_id) >= 1) AND (length(physical_workflow_id) <= 255)) AND (actor_id = trim(actor_id)) AND ((length(actor_id) >= 1) AND (length(actor_id) <= 255)))),
 CONSTRAINT product_workflow_replay_failures_attempt_id_key UNIQUE (attempt_id),
 CONSTRAINT product_workflow_replay_failures_pkey PRIMARY KEY (failure_id),
 CONSTRAINT product_workflow_replay_failures_attempt_fkey FOREIGN KEY (attempt_id, organization_id, operation_id, physical_workflow_id, actor_id) REFERENCES product_workflow_replay_attempts(attempt_id, organization_id, operation_id, physical_workflow_id, actor_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER product_workflow_replay_failures_no_update BEFORE UPDATE ON product_workflow_replay_failures
BEGIN SELECT RAISE(ABORT,'product_workflow_replay_failures is append-only'); END;

CREATE TRIGGER product_workflow_replay_failures_no_delete BEFORE DELETE ON product_workflow_replay_failures
BEGIN SELECT RAISE(ABORT,'product_workflow_replay_failures is append-only'); END;

-- Keep native FKs enabled and preserve every run field, including technical archive metadata.
CREATE TABLE _0453_workflow_runs AS SELECT * FROM product_workflow_runs;
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
  FOREIGN KEY(active_reconciliation_attempt_id,workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type)
    REFERENCES product_provider_reconciliation_attempts(attempt_id,logical_workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type) ON DELETE RESTRICT,
  FOREIGN KEY(active_replay_attempt_id,workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type)
    REFERENCES product_workflow_replay_attempts(attempt_id,logical_workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type) ON DELETE RESTRICT,
  CHECK(event_type IN ('SourceLinkRequestedV1','DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1','ProjectDeletionRequestedV1','ProjectDataChangeRequestedV1','ProjectHandleChangeRequestedV1')),
  CHECK((state='queued' AND terminal_evidence IS NULL AND reconciliation_code IS NULL AND completed_at IS NULL)
    OR (state='completed' AND json_type(terminal_evidence)='object' AND reconciliation_code IS NULL AND completed_at IS NOT NULL)
    OR (state='reconciliation_required' AND terminal_evidence IS NULL AND reconciliation_code=trim(reconciliation_code) AND length(reconciliation_code) BETWEEN 1 AND 128 AND completed_at IS NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO product_workflow_runs SELECT * FROM _0453_workflow_runs;
DROP TABLE _0453_workflow_runs;

-- Exact original claim UPDATE immutability and terminal/exact-abandon DELETE policy.
CREATE TRIGGER product_provider_mutation_claims_update_forbidden BEFORE UPDATE ON product_provider_mutation_claims
BEGIN SELECT RAISE(ABORT,'product_provider_mutation_claims is append-only'); END;
CREATE TRIGGER product_provider_mutation_claims_delete_guard BEFORE DELETE ON product_provider_mutation_claims
WHEN NOT EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=OLD.organization_id AND operation.project_id=OLD.project_id AND operation.operation_id=OLD.operation_id AND operation.state IN ('succeeded','failed'))
 AND NOT EXISTS(SELECT 1 FROM product_provider_reconciliation_attempts attempt WHERE attempt.mode='abandon' AND attempt.outcome='resolved_absent' AND attempt.claim_id=OLD.claim_id AND attempt.organization_id=OLD.organization_id AND attempt.project_id=OLD.project_id AND attempt.environment_id=OLD.environment_id AND attempt.operation_id=OLD.operation_id AND attempt.event_id=OLD.event_id AND attempt.billing_epoch_id=OLD.billing_epoch_id AND attempt.logical_workflow_id=OLD.logical_workflow_id AND attempt.event_type=OLD.event_type AND attempt.accepted_lifecycle_version=OLD.accepted_lifecycle_version)
BEGIN SELECT RAISE(ABORT,'active product provider mutation claim cannot be deleted'); END;
