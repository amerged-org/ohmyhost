-- Explicit application schema work has its own operation and immutable SQL custody, independent of preview TTL.
CREATE TABLE preview_migration_operations (
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=26), organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
 preview_id TEXT NOT NULL, preview_generation INTEGER NOT NULL, principal_id TEXT NOT NULL, idempotency_hash TEXT NOT NULL,
 request_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, delegation TEXT CHECK(delegation IS NULL OR json_valid(delegation)),
 environment_id TEXT NOT NULL, environment_name TEXT NOT NULL CHECK(environment_name IN('dev','prod')),
 physical_environment_id TEXT NOT NULL, assignment_version INTEGER NOT NULL, billing_epoch_id TEXT NOT NULL,
 ownership_version INTEGER NOT NULL, lifecycle_version INTEGER NOT NULL,
 source_connection_id TEXT NOT NULL, source_generation INTEGER NOT NULL, commit_sha TEXT NOT NULL,
 framework_plan TEXT NOT NULL CHECK(json_valid(framework_plan)), source_archive TEXT NOT NULL CHECK(json_valid(source_archive)),
 provider_project_id TEXT NOT NULL, database_id TEXT NOT NULL, target_version INTEGER NOT NULL, registration_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('queued','running','succeeded','failed','reconciliation_required')),
 claim_id TEXT, claim_expires_at TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN(0,1)), result TEXT CHECK(result IS NULL OR json_valid(result)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(organization_id,project_id,principal_id,idempotency_hash),
 FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
 FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id)
) STRICT;
CREATE UNIQUE INDEX preview_migration_one_project ON preview_migration_operations(organization_id,project_id) WHERE state IN('queued','running','reconciliation_required');
CREATE TABLE preview_migration_files (
 operation_id TEXT NOT NULL REFERENCES preview_migration_operations(operation_id), path TEXT NOT NULL,
 digest TEXT NOT NULL CHECK(length(digest)=71), size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 262144),
 body BLOB CHECK(body IS NULL OR length(body)=size), PRIMARY KEY(operation_id,path)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER preview_migration_files_no_update BEFORE UPDATE ON preview_migration_files
WHEN NOT(NEW.operation_id=OLD.operation_id AND NEW.path=OLD.path AND NEW.digest=OLD.digest AND NEW.size=OLD.size AND OLD.body IS NOT NULL AND NEW.body IS NULL AND EXISTS(SELECT 1 FROM preview_migration_operations operation WHERE operation.operation_id=OLD.operation_id AND operation.state IN('succeeded','failed')))
BEGIN SELECT RAISE(ABORT,'migration SQL custody permits terminal erasure only'); END;
CREATE TRIGGER preview_migration_files_no_delete BEFORE DELETE ON preview_migration_files BEGIN SELECT RAISE(ABORT,'migration SQL custody is retained'); END;
CREATE TRIGGER preview_migration_identity_immutable BEFORE UPDATE ON preview_migration_operations
WHEN NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id
 OR NEW.preview_id<>OLD.preview_id OR NEW.preview_generation<>OLD.preview_generation OR NEW.principal_id<>OLD.principal_id
 OR NEW.idempotency_hash<>OLD.idempotency_hash OR NEW.request_sha256<>OLD.request_sha256 OR NEW.manifest_sha256<>OLD.manifest_sha256 OR NEW.delegation IS NOT OLD.delegation
 OR NEW.environment_id<>OLD.environment_id OR NEW.environment_name<>OLD.environment_name OR NEW.physical_environment_id<>OLD.physical_environment_id
 OR NEW.assignment_version<>OLD.assignment_version OR NEW.billing_epoch_id<>OLD.billing_epoch_id OR NEW.ownership_version<>OLD.ownership_version OR NEW.lifecycle_version<>OLD.lifecycle_version
 OR NEW.source_connection_id<>OLD.source_connection_id OR NEW.source_generation<>OLD.source_generation OR NEW.commit_sha<>OLD.commit_sha
 OR NEW.framework_plan<>OLD.framework_plan OR NEW.source_archive<>OLD.source_archive OR NEW.provider_project_id<>OLD.provider_project_id OR NEW.database_id<>OLD.database_id OR NEW.target_version<>OLD.target_version OR NEW.registration_version<>OLD.registration_version
BEGIN SELECT RAISE(ABORT,'migration identity is immutable'); END;
