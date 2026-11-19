-- Original PostgreSQL226 entitlement facts. Retain every action and confirmed suspension identity.
-- No resize/delete authority is introduced: expiry only suspends, restoration owns exactly its own stop.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE pgcf_database_entitlement_policies (
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  physical_environment_id TEXT NOT NULL CHECK(length(physical_environment_id)=26 AND length(CAST(physical_environment_id AS BLOB))=26 AND substr(physical_environment_id,1,1) BETWEEN '0' AND '7' AND physical_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  database_id TEXT NOT NULL CHECK(length(database_id)=20 AND length(CAST(database_id AS BLOB))=20 AND database_id GLOB '[a-z]*' AND database_id NOT GLOB '*[^a-z0-9]*'),
  suspended_by_entitlement INTEGER NOT NULL DEFAULT 0 CHECK(suspended_by_entitlement IN(0,1)),
  suspension_operation_id TEXT,suspension_generation INTEGER,last_checked_at TEXT NOT NULL CHECK((last_checked_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(last_checked_at AS BLOB))=27 AND substr(last_checked_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(last_checked_at,1,10),'+0 days')=substr(last_checked_at,1,10) AND substr(last_checked_at,12,2) BETWEEN '00' AND '23' AND substr(last_checked_at,15,2) BETWEEN '00' AND '59' AND substr(last_checked_at,18,2) BETWEEN '00' AND '59' AND (substr(last_checked_at,12,2)||substr(last_checked_at,15,2)||substr(last_checked_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(last_checked_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE),
  CHECK((suspended_by_entitlement=1 AND suspension_operation_id IS NOT NULL AND suspension_generation IS NOT NULL AND length(suspension_operation_id)=23 AND length(CAST(suspension_operation_id AS BLOB))=23 AND substr(suspension_operation_id,1,3)='op_' AND substr(suspension_operation_id,4) NOT GLOB '*[^a-z0-9]*' AND suspension_generation>0) OR(suspended_by_entitlement=0 AND suspension_operation_id IS NULL AND suspension_generation IS NULL)),
  PRIMARY KEY(organization_id,project_id,physical_environment_id,database_id),
  FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE pgcf_database_entitlement_actions (
  action_id TEXT NOT NULL CHECK(length(action_id)=26 AND length(CAST(action_id AS BLOB))=26 AND substr(action_id,1,1) BETWEEN '0' AND '7' AND action_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  physical_environment_id TEXT NOT NULL CHECK(length(physical_environment_id)=26 AND length(CAST(physical_environment_id AS BLOB))=26 AND substr(physical_environment_id,1,1) BETWEEN '0' AND '7' AND physical_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  billing_epoch_id TEXT NOT NULL CHECK(length(billing_epoch_id)=26 AND length(CAST(billing_epoch_id AS BLOB))=26 AND substr(billing_epoch_id,1,1) BETWEEN '0' AND '7' AND billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  target_version INTEGER NOT NULL,provider_project_id TEXT NOT NULL CHECK(length(provider_project_id)=24 AND length(CAST(provider_project_id AS BLOB))=24 AND substr(provider_project_id,1,4)='prj_' AND substr(provider_project_id,5) NOT GLOB '*[^a-z0-9]*'),
  database_id TEXT NOT NULL CHECK(length(database_id)=20 AND length(CAST(database_id AS BLOB))=20 AND database_id GLOB '[a-z]*' AND database_id NOT GLOB '*[^a-z0-9]*'),
  action TEXT NOT NULL CHECK(action IN('suspend','resume')),expected_generation INTEGER NOT NULL CHECK(expected_generation>0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=80 AND length(CAST(idempotency_key AS BLOB))=80 AND substr(idempotency_key,1,16)='omh-entitlement-' AND substr(idempotency_key,17) NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK(state IN('reserved','dispatched','pending','succeeded','failed','cancelled','superseded')),
  provider_operation_id TEXT CHECK(provider_operation_id IS NULL OR(length(provider_operation_id)=23 AND length(CAST(provider_operation_id AS BLOB))=23 AND substr(provider_operation_id,1,3)='op_' AND substr(provider_operation_id,4) NOT GLOB '*[^a-z0-9]*')),
  provider_generation INTEGER CHECK(provider_generation>0),
  claim_id TEXT NOT NULL CHECK(length(claim_id)=26 AND length(CAST(claim_id AS BLOB))=26 AND substr(claim_id,1,1) BETWEEN '0' AND '7' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  claim_expires_at TEXT NOT NULL CHECK((claim_expires_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(claim_expires_at AS BLOB))=27 AND substr(claim_expires_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(claim_expires_at,1,10),'+0 days')=substr(claim_expires_at,1,10) AND substr(claim_expires_at,12,2) BETWEEN '00' AND '23' AND substr(claim_expires_at,15,2) BETWEEN '00' AND '59' AND substr(claim_expires_at,18,2) BETWEEN '00' AND '59' AND (substr(claim_expires_at,12,2)||substr(claim_expires_at,15,2)||substr(claim_expires_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(claim_expires_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE),
  created_at TEXT NOT NULL CHECK((created_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(created_at AS BLOB))=27 AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(created_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE),
  dispatched_at TEXT CHECK(dispatched_at IS NULL OR (dispatched_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(dispatched_at AS BLOB))=27 AND substr(dispatched_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(dispatched_at,1,10),'+0 days')=substr(dispatched_at,1,10) AND substr(dispatched_at,12,2) BETWEEN '00' AND '23' AND substr(dispatched_at,15,2) BETWEEN '00' AND '59' AND substr(dispatched_at,18,2) BETWEEN '00' AND '59' AND (substr(dispatched_at,12,2)||substr(dispatched_at,15,2)||substr(dispatched_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(dispatched_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE),
  observed_at TEXT CHECK(observed_at IS NULL OR (observed_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(observed_at AS BLOB))=27 AND substr(observed_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(observed_at,1,10),'+0 days')=substr(observed_at,1,10) AND substr(observed_at,12,2) BETWEEN '00' AND '23' AND substr(observed_at,15,2) BETWEEN '00' AND '59' AND substr(observed_at,18,2) BETWEEN '00' AND '59' AND (substr(observed_at,12,2)||substr(observed_at,15,2)||substr(observed_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(observed_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE),
  PRIMARY KEY(action_id),
  FOREIGN KEY(organization_id,project_id,physical_environment_id,target_version) REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version),
  FOREIGN KEY(organization_id,project_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,project_id,billing_epoch_id),
  CHECK((provider_operation_id IS NULL)=(provider_generation IS NULL)),
  CHECK(state<>'succeeded' OR(provider_operation_id IS NOT NULL AND provider_generation IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX pgcf_entitlement_one_pending ON pgcf_database_entitlement_actions(organization_id,project_id,physical_environment_id,database_id) WHERE state IN('reserved','dispatched','pending');
CREATE TRIGGER pgcf_entitlement_action_identity BEFORE UPDATE ON pgcf_database_entitlement_actions
WHEN NEW.action_id IS NOT OLD.action_id
 OR NEW.organization_id IS NOT OLD.organization_id
 OR NEW.project_id IS NOT OLD.project_id
 OR NEW.physical_environment_id IS NOT OLD.physical_environment_id
 OR NEW.billing_epoch_id IS NOT OLD.billing_epoch_id
 OR NEW.target_version IS NOT OLD.target_version
 OR NEW.provider_project_id IS NOT OLD.provider_project_id
 OR NEW.database_id IS NOT OLD.database_id
 OR NEW.action IS NOT OLD.action
 OR NEW.expected_generation IS NOT OLD.expected_generation
 OR NEW.idempotency_key IS NOT OLD.idempotency_key
 OR NEW.created_at IS NOT OLD.created_at
 OR(OLD.provider_operation_id IS NOT NULL AND NEW.provider_operation_id IS NOT OLD.provider_operation_id)
 OR(OLD.provider_generation IS NOT NULL AND NEW.provider_generation IS NOT OLD.provider_generation)
 OR(OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
 OR(OLD.state IN('succeeded','failed','cancelled','superseded') AND(NEW.state IS NOT OLD.state OR NEW.provider_operation_id IS NOT OLD.provider_operation_id OR NEW.provider_generation IS NOT OLD.provider_generation OR NEW.claim_id IS NOT OLD.claim_id OR NEW.claim_expires_at IS NOT OLD.claim_expires_at OR NEW.dispatched_at IS NOT OLD.dispatched_at OR NEW.observed_at IS NOT OLD.observed_at))
BEGIN SELECT RAISE(ABORT,'PGCF entitlement action identity is immutable'); END;
CREATE TRIGGER pgcf_entitlement_action_retained BEFORE DELETE ON pgcf_database_entitlement_actions
BEGIN SELECT RAISE(ABORT,'PGCF entitlement action identity is immutable'); END;
