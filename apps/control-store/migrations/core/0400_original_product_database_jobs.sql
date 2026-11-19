-- Original117/122/165/221/223. These are durable product SQL/compute facts, not provider credentials.
CREATE TABLE project_database_access (
  access_id TEXT NOT NULL PRIMARY KEY CHECK(length(access_id)=26 AND access_id GLOB '[0-7]*' AND access_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL,project_id TEXT NOT NULL,environment_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN('dev','prod')),
  data_environment_id TEXT NOT NULL CHECK(length(data_environment_id)=26 AND data_environment_id GLOB '[0-7]*' AND data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  provider_project_id TEXT NOT NULL,default_branch_id TEXT CHECK(default_branch_id IS NULL OR(length(default_branch_id) BETWEEN 1 AND 60 AND default_branch_id NOT GLOB '*[^a-z0-9-]*')),
  role_name TEXT NOT NULL UNIQUE,mode TEXT NOT NULL CHECK(mode IN('read','write')),
  label TEXT CHECK(label IS NULL OR(length(label) BETWEEN 1 AND 64
    AND label NOT GLOB ('*['||char(1)||'-'||char(8)||char(11)||char(12)||char(14)||'-'||char(31)||char(127)||'-'||char(159)||']*')
    AND label=trim(label,char(9)||char(10)||char(11)||char(12)||char(13)||' '||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)))),
  principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 256),
  origin_host TEXT NOT NULL CHECK(length(origin_host) BETWEEN 1 AND 253 AND origin_host NOT GLOB '*[^a-z0-9.-]*' AND substr(origin_host,1,1) GLOB '[a-z0-9]' AND substr(origin_host,-1,1) GLOB '[a-z0-9]'),
  issued_at TEXT NOT NULL CHECK(issued_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at TEXT CHECK(revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_by TEXT,revocation_reason TEXT CHECK(revocation_reason IS NULL OR revocation_reason IN('principal','expired','budget','creation_failed','data_change')),
  role_dropped_at TEXT CHECK(role_dropped_at IS NULL OR role_dropped_at GLOB '????-??-??T??:??:??.??????Z'),
  provider TEXT NOT NULL DEFAULT 'neon',database_id TEXT,provider_create_operation_id TEXT,provider_delete_operation_id TEXT,
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK(length(role_name)=45 AND substr(role_name,1,37)='ohmyho_da_'||lower(data_environment_id)||'_' AND substr(role_name,38) NOT GLOB '*[^0-9a-z]*'),
  CHECK(expires_at>issued_at AND expires_at<=strftime('%Y-%m-%dT%H:%M:%S',issued_at,'+1 day')||substr(issued_at,20)),
  CHECK((revoked_at IS NULL)=(revocation_reason IS NULL) AND (revoked_at IS NULL)=(revoked_by IS NULL)),
  CHECK(role_dropped_at IS NULL OR revoked_at IS NOT NULL),CHECK(revoked_at IS NULL OR revoked_at>=issued_at),
  CHECK((provider='neon' AND database_id IS NULL AND default_branch_id IS NOT NULL AND length(provider_project_id) BETWEEN 1 AND 60 AND provider_project_id NOT GLOB '*[^a-z0-9-]*')
    OR(provider='pgcf' AND database_id IS NOT NULL AND length(database_id)=20 AND database_id GLOB '[a-z]*' AND database_id NOT GLOB '*[^a-z0-9]*' AND default_branch_id IS NULL AND length(provider_project_id)=24 AND substr(provider_project_id,1,4)='prj_' AND substr(provider_project_id,5) NOT GLOB '*[^a-z0-9]*')),
  CHECK((provider_create_operation_id IS NULL OR(provider='pgcf' AND length(provider_create_operation_id)=23 AND substr(provider_create_operation_id,1,3)='op_' AND substr(provider_create_operation_id,4) NOT GLOB '*[^a-z0-9]*'))
    AND(provider_delete_operation_id IS NULL OR(provider='pgcf' AND length(provider_delete_operation_id)=23 AND substr(provider_delete_operation_id,1,3)='op_' AND substr(provider_delete_operation_id,4) NOT GLOB '*[^a-z0-9]*')))
) STRICT, WITHOUT ROWID;
CREATE INDEX project_database_access_environment_idx ON project_database_access(organization_id,project_id,environment_id,issued_at DESC);
CREATE INDEX project_database_access_active_idx ON project_database_access(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX project_database_access_undropped_idx ON project_database_access(revoked_at) WHERE revoked_at IS NOT NULL AND role_dropped_at IS NULL;
CREATE TRIGGER project_database_access_identity_guard BEFORE UPDATE ON project_database_access
WHEN NEW.access_id IS NOT OLD.access_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
 OR NEW.environment_id IS NOT OLD.environment_id OR NEW.environment IS NOT OLD.environment OR NEW.data_environment_id IS NOT OLD.data_environment_id
 OR NEW.provider_project_id IS NOT OLD.provider_project_id OR NEW.default_branch_id IS NOT OLD.default_branch_id OR NEW.role_name IS NOT OLD.role_name
 OR NEW.mode IS NOT OLD.mode OR NEW.label IS NOT OLD.label OR NEW.principal_id IS NOT OLD.principal_id OR NEW.origin_host IS NOT OLD.origin_host
 OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.provider IS NOT OLD.provider OR NEW.database_id IS NOT OLD.database_id
 OR(OLD.provider_create_operation_id IS NOT NULL AND NEW.provider_create_operation_id IS NOT OLD.provider_create_operation_id)
 OR(OLD.provider_delete_operation_id IS NOT NULL AND NEW.provider_delete_operation_id IS NOT OLD.provider_delete_operation_id)
BEGIN SELECT RAISE(ABORT,'Database access target identity is immutable'); END;

CREATE TABLE project_database_writes (
  operation_id TEXT NOT NULL PRIMARY KEY,organization_id TEXT NOT NULL,project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment TEXT NOT NULL CHECK(environment IN('dev','prod')),
  data_environment_id TEXT NOT NULL CHECK(length(data_environment_id)=26 AND data_environment_id GLOB '[0-7]*' AND data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  billing_epoch_id TEXT NOT NULL,provider_project_id TEXT NOT NULL,default_branch_id TEXT,
  principal_id TEXT NOT NULL,idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),
  started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.??????Z'),
  deadline_at TEXT NOT NULL CHECK(deadline_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  command TEXT CHECK(command IN('INSERT','UPDATE','DELETE')),affected_rows INTEGER CHECK(affected_rows BETWEEN 0 AND 1000),
  failure_code TEXT CHECK(failure_code IN('DATABASE_WRITE_REJECTED','DATABASE_WRITE_UNAVAILABLE','DATABASE_WRITE_OUTCOME_UNKNOWN')),
  provider TEXT NOT NULL DEFAULT 'neon',database_id TEXT,
  UNIQUE(organization_id,principal_id,idempotency_key),
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
  FOREIGN KEY(organization_id,project_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,project_id,billing_epoch_id),
  CHECK(deadline_at=strftime('%Y-%m-%dT%H:%M:%S',started_at,'+60 seconds')||substr(started_at,20)),
  CHECK((completed_at IS NULL AND command IS NULL AND affected_rows IS NULL AND failure_code IS NULL)
    OR(completed_at>=started_at AND((command IS NOT NULL AND affected_rows IS NOT NULL AND failure_code IS NULL)OR(command IS NULL AND affected_rows IS NULL AND failure_code IS NOT NULL)))),
  CHECK((provider='neon' AND database_id IS NULL AND default_branch_id IS NOT NULL)
    OR(provider='pgcf' AND database_id IS NOT NULL AND length(database_id)=20 AND database_id GLOB '[a-z]*' AND database_id NOT GLOB '*[^a-z0-9]*' AND default_branch_id IS NULL AND length(provider_project_id)=24 AND substr(provider_project_id,1,4)='prj_' AND substr(provider_project_id,5) NOT GLOB '*[^a-z0-9]*'))
) STRICT, WITHOUT ROWID;
CREATE INDEX project_database_writes_pending ON project_database_writes(deadline_at) WHERE completed_at IS NULL;
CREATE TRIGGER project_database_write_guard BEFORE UPDATE ON project_database_writes
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
 OR NEW.environment_id IS NOT OLD.environment_id OR NEW.environment IS NOT OLD.environment OR NEW.data_environment_id IS NOT OLD.data_environment_id
 OR NEW.billing_epoch_id IS NOT OLD.billing_epoch_id OR NEW.provider_project_id IS NOT OLD.provider_project_id OR NEW.default_branch_id IS NOT OLD.default_branch_id
 OR NEW.principal_id IS NOT OLD.principal_id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_sha256 IS NOT OLD.request_sha256
 OR NEW.started_at IS NOT OLD.started_at OR NEW.deadline_at IS NOT OLD.deadline_at OR NEW.provider IS NOT OLD.provider OR NEW.database_id IS NOT OLD.database_id
 OR(OLD.completed_at IS NOT NULL AND(NEW.completed_at IS NOT OLD.completed_at OR NEW.command IS NOT OLD.command OR NEW.affected_rows IS NOT OLD.affected_rows OR NEW.failure_code IS NOT OLD.failure_code))
BEGIN SELECT RAISE(ABORT,'Write execution identity is immutable'); END;
CREATE TRIGGER project_database_write_delete_guard BEFORE DELETE ON project_database_writes
WHEN NOT EXISTS(SELECT 1 FROM projects WHERE project_id=OLD.project_id AND lifecycle_state='deleted')
BEGIN SELECT RAISE(ABORT,'Write receipt is retained until project deletion'); END;

CREATE TABLE pgcf_database_compute_changes (
  operation_id TEXT NOT NULL PRIMARY KEY,organization_id TEXT NOT NULL,project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  data_environment_id TEXT NOT NULL,billing_epoch_id TEXT NOT NULL,
  provider_project_id TEXT NOT NULL CHECK(length(provider_project_id)=24 AND substr(provider_project_id,1,4)='prj_' AND substr(provider_project_id,5) NOT GLOB '*[^a-z0-9]*'),
  database_id TEXT NOT NULL CHECK(length(database_id)=20 AND database_id GLOB '[a-z]*' AND database_id NOT GLOB '*[^a-z0-9]*'),
  target_version INTEGER NOT NULL CHECK(target_version>0),memory_mib INTEGER NOT NULL CHECK(memory_mib IN(256,512,1024,2048,4096)),size_class_id TEXT NOT NULL,
  accepted_lifecycle_version INTEGER NOT NULL CHECK(accepted_lifecycle_version BETWEEN -2147483648 AND 2147483647),
  requested_at TEXT NOT NULL CHECK(requested_at GLOB '????-??-??T??:??:??.??????Z'),
  claim_id TEXT CHECK(claim_id IS NULL OR(length(claim_id)=26 AND claim_id GLOB '[0-7]*' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  claim_expires_at TEXT CHECK(claim_expires_at IS NULL OR claim_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  last_attempted_at TEXT CHECK(last_attempted_at IS NULL OR last_attempted_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),failure_code TEXT,
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
  FOREIGN KEY(organization_id,project_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,project_id,billing_epoch_id),
  FOREIGN KEY(organization_id,project_id,data_environment_id,target_version) REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version)
) STRICT, WITHOUT ROWID;
CREATE INDEX pgcf_database_compute_changes_history ON pgcf_database_compute_changes(organization_id,project_id,data_environment_id,database_id,billing_epoch_id,requested_at DESC);
CREATE UNIQUE INDEX pgcf_database_compute_changes_unfinished ON pgcf_database_compute_changes(project_id) WHERE completed_at IS NULL;
