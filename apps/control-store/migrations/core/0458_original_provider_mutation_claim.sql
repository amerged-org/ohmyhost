-- Original020/021/060/161 full current-claim identity and native static parents.
-- Unserved atomic correction: preserve every existing claim and placement child without disabling/defering FKs.
-- Historical import never fabricates the accepted intent, Workflow run, open epoch or permission.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE _0458_claims AS SELECT * FROM product_provider_mutation_claims;
CREATE TABLE _0458_placements AS SELECT * FROM neon_project_placement_reservations;
DROP TABLE neon_project_placement_reservations;
DROP TABLE product_provider_mutation_claims;
CREATE TABLE product_provider_mutation_claims (
 claim_id TEXT NOT NULL CHECK(length(claim_id)=26 AND length(CAST(claim_id AS BLOB))=26 AND substr(claim_id,1,1) BETWEEN '0' AND '7' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 operation_id TEXT NOT NULL CHECK(length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 billing_epoch_id TEXT NOT NULL CHECK(length(billing_epoch_id)=26 AND length(CAST(billing_epoch_id AS BLOB))=26 AND substr(billing_epoch_id,1,1) BETWEEN '0' AND '7' AND billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 event_id TEXT NOT NULL CHECK(length(event_id)=26 AND length(CAST(event_id AS BLOB))=26 AND substr(event_id,1,1) BETWEEN '0' AND '7' AND event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 logical_workflow_id TEXT NOT NULL CHECK(instr(logical_workflow_id,char(0))=0 AND logical_workflow_id=trim(logical_workflow_id) AND length(logical_workflow_id) BETWEEN 1 AND 255),
 event_type TEXT NOT NULL CHECK(event_type IN('DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1','ProjectDataChangeRequestedV1','ProjectHandleChangeRequestedV1')),
 accepted_lifecycle_version INTEGER NOT NULL CHECK(accepted_lifecycle_version BETWEEN 1 AND 2147483647),
 claimed_at TEXT NOT NULL CHECK((claimed_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(claimed_at AS BLOB))=27 AND substr(claimed_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(claimed_at,1,10),'+0 days')=substr(claimed_at,1,10) AND (substr(claimed_at,12,2)||substr(claimed_at,15,2)||substr(claimed_at,18,2)||substr(claimed_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(claimed_at,12,2) BETWEEN '00' AND '23' AND substr(claimed_at,15,2) BETWEEN '00' AND '59' AND substr(claimed_at,18,2) BETWEEN '00' AND '59') IS TRUE),
 PRIMARY KEY(organization_id,project_id),
 UNIQUE(claim_id),
 UNIQUE(claim_id,organization_id,project_id,environment_id,operation_id,event_id,billing_epoch_id,logical_workflow_id,event_type,accepted_lifecycle_version),
 FOREIGN KEY(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type)
  REFERENCES product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type) ON DELETE RESTRICT,
 FOREIGN KEY(logical_workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type)
  REFERENCES product_workflow_runs(workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
INSERT INTO product_provider_mutation_claims(claim_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_id,logical_workflow_id,event_type,accepted_lifecycle_version,claimed_at) SELECT claim_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_id,logical_workflow_id,event_type,accepted_lifecycle_version,claimed_at FROM _0458_claims;
CREATE UNIQUE INDEX product_provider_mutation_claims_neon_identity ON product_provider_mutation_claims(claim_id,organization_id,project_id,environment_id,operation_id);
CREATE UNIQUE INDEX product_provider_mutation_claims_provider_scope ON product_provider_mutation_claims(claim_id,organization_id,project_id,operation_id);
CREATE TABLE neon_project_placement_reservations (
  organization_id   TEXT    NOT NULL,
  project_id        TEXT    NOT NULL,
  environment_id    TEXT    NOT NULL,
  operation_id      TEXT    NOT NULL,
  claim_id          TEXT    NOT NULL,
  project_name      TEXT    NOT NULL CHECK (length(project_name) = 33 AND substr(project_name, 1, 7) = 'ohmyho-'
                      AND substr(project_name, 8, 1) GLOB '[0-7]' AND substr(project_name, 8) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  region_id         TEXT    NOT NULL CHECK (region_id GLOB 'aws-*-[0-9]*' AND region_id NOT GLOB '*[^a-z0-9-]*' AND length(region_id) <= 64),
  postgres_version  INTEGER NOT NULL CHECK (postgres_version BETWEEN 14 AND 18),
  reserved_at       TEXT    NOT NULL CHECK (reserved_at GLOB '????-??-??T??:??:??.??????Z'),
  create_started_at TEXT    CHECK (create_started_at IS NULL OR (create_started_at GLOB '????-??-??T??:??:??.??????Z' AND create_started_at >= reserved_at)),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (claim_id, organization_id, project_id, operation_id) REFERENCES product_provider_mutation_claims (claim_id, organization_id, project_id, operation_id),
  FOREIGN KEY (organization_id, project_id, environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id)
) STRICT, WITHOUT ROWID;
INSERT INTO neon_project_placement_reservations SELECT * FROM _0458_placements;
CREATE TRIGGER product_provider_mutation_claims_update_forbidden BEFORE UPDATE ON product_provider_mutation_claims
BEGIN SELECT RAISE(ABORT,'product_provider_mutation_claims is append-only'); END;
CREATE TRIGGER product_provider_mutation_claims_delete_guard BEFORE DELETE ON product_provider_mutation_claims
WHEN NOT EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=OLD.organization_id AND operation.project_id=OLD.project_id AND operation.operation_id=OLD.operation_id AND operation.state IN ('succeeded','failed'))
 AND NOT EXISTS(SELECT 1 FROM product_provider_reconciliation_attempts attempt WHERE attempt.mode='abandon' AND attempt.outcome='resolved_absent' AND attempt.claim_id=OLD.claim_id AND attempt.organization_id=OLD.organization_id AND attempt.project_id=OLD.project_id AND attempt.environment_id=OLD.environment_id AND attempt.operation_id=OLD.operation_id AND attempt.event_id=OLD.event_id AND attempt.billing_epoch_id=OLD.billing_epoch_id AND attempt.logical_workflow_id=OLD.logical_workflow_id AND attempt.event_type=OLD.event_type AND attempt.accepted_lifecycle_version=OLD.accepted_lifecycle_version)
BEGIN SELECT RAISE(ABORT,'active product provider mutation claim cannot be deleted'); END;
DROP TABLE _0458_placements;
DROP TABLE _0458_claims;
