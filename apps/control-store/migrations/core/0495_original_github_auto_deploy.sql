-- Original061/062 current GitHub auto-deployment identity and authority. UNSERVED additive correction.
-- No missing configuration, sequence, parent or cleanup evidence is inferred from prototype push rows.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
-- The old target has no config table at all. Populated prototype pushes require a fresh exact Source import;
-- refusing them atomically preserves their bytes instead of manufacturing an authority parent.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM github_push_deployments);
CREATE TABLE github_auto_deploy_configs (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 source_connection_id TEXT NOT NULL CHECK(length(source_connection_id)=26 AND length(CAST(source_connection_id AS BLOB))=26 AND substr(source_connection_id,1,1) BETWEEN '0' AND '7' AND source_connection_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 branch_ref TEXT NOT NULL CHECK(instr(branch_ref,char(0))=0 AND length(branch_ref) BETWEEN 12 AND 1035 AND substr(branch_ref,1,11)='refs/heads/' AND substr(branch_ref,12,1) GLOB '[A-Za-z0-9]' AND substr(branch_ref,12) NOT GLOB '*[^A-Za-z0-9._/-]*' AND branch_ref NOT LIKE '%..%' AND branch_ref NOT LIKE '%@{%' AND branch_ref NOT LIKE '%//%' AND branch_ref NOT LIKE '%/.%' AND branch_ref NOT LIKE '%.lock/%' AND substr(branch_ref,-5)<>'.lock' AND substr(branch_ref,-1)<>'.'),
 generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 2147483647),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 configured_at TEXT NOT NULL CHECK((configured_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(configured_at AS BLOB))=27 AND substr(configured_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(configured_at,1,10),'+0 days')=substr(configured_at,1,10) AND (substr(configured_at,12,2)||substr(configured_at,15,2)||substr(configured_at,18,2)||substr(configured_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(configured_at,12,2) BETWEEN '00' AND '23' AND substr(configured_at,15,2) BETWEEN '00' AND '59' AND substr(configured_at,18,2) BETWEEN '00' AND '59') IS TRUE),
 updated_at TEXT NOT NULL CHECK((updated_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(updated_at AS BLOB))=27 AND substr(updated_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(updated_at,1,10),'+0 days')=substr(updated_at,1,10) AND (substr(updated_at,12,2)||substr(updated_at,15,2)||substr(updated_at,18,2)||substr(updated_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND substr(updated_at,15,2) BETWEEN '00' AND '59' AND substr(updated_at,18,2) BETWEEN '00' AND '59') IS TRUE),
 PRIMARY KEY(organization_id,project_id),
 FOREIGN KEY(organization_id,project_id,source_connection_id) REFERENCES repository_grants(organization_id,project_id,source_connection_id) ON DELETE RESTRICT,
 CHECK(updated_at>=configured_at)
) STRICT, WITHOUT ROWID;
DROP TABLE github_push_deployments;
CREATE TABLE github_push_deployments (
 push_deployment_id TEXT NOT NULL CHECK(length(push_deployment_id)=26 AND length(CAST(push_deployment_id AS BLOB))=26 AND substr(push_deployment_id,1,1) BETWEEN '0' AND '7' AND push_deployment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 inbox_event_id TEXT NOT NULL CHECK(length(inbox_event_id)=26 AND length(CAST(inbox_event_id AS BLOB))=26 AND substr(inbox_event_id,1,1) BETWEEN '0' AND '7' AND inbox_event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 source_connection_id TEXT NOT NULL CHECK(length(source_connection_id)=26 AND length(CAST(source_connection_id AS BLOB))=26 AND substr(source_connection_id,1,1) BETWEEN '0' AND '7' AND source_connection_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 config_generation INTEGER NOT NULL CHECK(config_generation BETWEEN 1 AND 2147483647),
 delivery_guid TEXT NOT NULL CHECK(length(delivery_guid)=36 AND length(CAST(delivery_guid AS BLOB))=36 AND substr(delivery_guid,9,1)='-' AND substr(delivery_guid,14,1)='-' AND substr(delivery_guid,19,1)='-' AND substr(delivery_guid,24,1)='-' AND length(replace(delivery_guid,'-',''))=32 AND replace(delivery_guid,'-','') NOT GLOB '*[^0-9a-f]*'),
 github_installation_id TEXT NOT NULL CHECK(length(github_installation_id) BETWEEN 1 AND 20 AND instr(github_installation_id,char(0))=0 AND substr(github_installation_id,1,1) GLOB '[1-9]' AND github_installation_id NOT GLOB '*[^0-9]*'),
 external_repository_id TEXT NOT NULL CHECK(length(external_repository_id) BETWEEN 1 AND 16 AND instr(external_repository_id,char(0))=0 AND substr(external_repository_id,1,1) GLOB '[1-9]' AND external_repository_id NOT GLOB '*[^0-9]*'),
 branch_ref TEXT NOT NULL CHECK(instr(branch_ref,char(0))=0 AND substr(branch_ref,1,11)='refs/heads/'),
 commit_sha TEXT NOT NULL CHECK(length(commit_sha)=40 AND length(CAST(commit_sha AS BLOB))=40 AND commit_sha NOT GLOB '*[^0-9a-f]*' AND commit_sha<>'0000000000000000000000000000000000000000'),
 sequence INTEGER NOT NULL CHECK(sequence>0),
 operation_id TEXT CHECK(operation_id IS NULL OR (length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 state TEXT NOT NULL CHECK(state IN('reserved','queued','running','cleanup_pending','superseded','failed','active','reconciliation_required')),
 superseded_by_id TEXT CHECK(superseded_by_id IS NULL OR (length(superseded_by_id)=26 AND length(CAST(superseded_by_id AS BLOB))=26 AND substr(superseded_by_id,1,1) BETWEEN '0' AND '7' AND superseded_by_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 cleanup_required INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_required IN(0,1)),
 created_at TEXT NOT NULL CHECK((created_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(created_at AS BLOB))=27 AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)||substr(created_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59') IS TRUE),
 updated_at TEXT NOT NULL CHECK((updated_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(updated_at AS BLOB))=27 AND substr(updated_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(updated_at,1,10),'+0 days')=substr(updated_at,1,10) AND (substr(updated_at,12,2)||substr(updated_at,15,2)||substr(updated_at,18,2)||substr(updated_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND substr(updated_at,15,2) BETWEEN '00' AND '59' AND substr(updated_at,18,2) BETWEEN '00' AND '59') IS TRUE),
 PRIMARY KEY(push_deployment_id),
 UNIQUE(organization_id,project_id,delivery_guid),
 UNIQUE(organization_id,project_id,source_connection_id,config_generation,commit_sha),
 UNIQUE(operation_id),
 FOREIGN KEY(inbox_event_id) REFERENCES webhook_inbox(inbox_event_id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,project_id) REFERENCES github_auto_deploy_configs(organization_id,project_id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,project_id,source_connection_id) REFERENCES repository_grants(organization_id,project_id,source_connection_id) ON DELETE RESTRICT,
 FOREIGN KEY(superseded_by_id) REFERENCES github_push_deployments(push_deployment_id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,operation_id) REFERENCES operations(organization_id,operation_id) ON DELETE RESTRICT,
 CHECK(((state='reserved' AND operation_id IS NULL) OR state='superseded' OR(state NOT IN('reserved','superseded') AND operation_id IS NOT NULL))
 AND((state='cleanup_pending' AND superseded_by_id IS NOT NULL AND cleanup_required=1) OR(state='superseded' AND superseded_by_id IS NOT NULL AND cleanup_required=0) OR(state NOT IN('cleanup_pending','superseded') AND superseded_by_id IS NULL AND cleanup_required=0)) AND updated_at>=created_at)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX github_push_deployments_latest_idx ON github_push_deployments(organization_id,project_id,sequence);
CREATE INDEX github_push_deployments_by_operation ON github_push_deployments(organization_id,operation_id);
CREATE TRIGGER github_push_deployments_cleanup_receipt_check BEFORE UPDATE ON github_push_deployments
WHEN NEW.state='superseded' AND NEW.cleanup_required=0 AND NOT EXISTS(
 SELECT 1 FROM wfp_candidate_receipts candidate JOIN wfp_candidate_cleanup_receipts cleanup ON cleanup.candidate_receipt_id=candidate.candidate_receipt_id
 WHERE candidate.organization_id=NEW.organization_id AND candidate.project_id=NEW.project_id AND candidate.operation_id=NEW.operation_id
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected WHERE expected.candidate_receipt_id=candidate.candidate_receipt_id AND NOT EXISTS(SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual WHERE actual.cleanup_request_id=expected.cleanup_request_id AND actual.provider=expected.provider AND actual.resource_kind=expected.resource_kind AND actual.resource_identity_sha256=expected.resource_identity_sha256))
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual WHERE actual.candidate_receipt_id=candidate.candidate_receipt_id AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected WHERE expected.cleanup_request_id=actual.cleanup_request_id AND expected.provider=actual.provider AND expected.resource_kind=actual.resource_kind AND expected.resource_identity_sha256=actual.resource_identity_sha256)))
BEGIN SELECT RAISE(ABORT,'superseded push requires durable WFP candidate cleanup evidence'); END;
