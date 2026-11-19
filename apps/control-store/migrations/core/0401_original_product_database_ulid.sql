-- Restore the original PostgreSQL ulid domain on every product database ULID field.
-- A matching Core parent proves scope, not the original character domain. Refuse invalid existing
-- facts atomically; never repair history or change the immutable 0400 migration.

INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM project_database_access WHERE NOT(
 (length(access_id)=26 AND length(CAST(access_id AS BLOB))=26 AND substr(access_id,1,1) BETWEEN '0' AND '7' AND access_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(data_environment_id)=26 AND length(CAST(data_environment_id AS BLOB))=26 AND substr(data_environment_id,1,1) BETWEEN '0' AND '7' AND data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
));

INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM project_database_writes WHERE NOT(
 (length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(data_environment_id)=26 AND length(CAST(data_environment_id AS BLOB))=26 AND substr(data_environment_id,1,1) BETWEEN '0' AND '7' AND data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(billing_epoch_id)=26 AND length(CAST(billing_epoch_id AS BLOB))=26 AND substr(billing_epoch_id,1,1) BETWEEN '0' AND '7' AND billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
));

INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM pgcf_database_compute_changes WHERE NOT(
 (length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(data_environment_id)=26 AND length(CAST(data_environment_id AS BLOB))=26 AND substr(data_environment_id,1,1) BETWEEN '0' AND '7' AND data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(billing_epoch_id)=26 AND length(CAST(billing_epoch_id AS BLOB))=26 AND substr(billing_epoch_id,1,1) BETWEEN '0' AND '7' AND billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (claim_id IS NULL OR (length(claim_id)=26 AND length(CAST(claim_id AS BLOB))=26 AND substr(claim_id,1,1) BETWEEN '0' AND '7' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'))
));

CREATE TRIGGER project_database_access_ulid_insert BEFORE INSERT ON project_database_access
WHEN NOT(
 (length(NEW.access_id)=26 AND length(CAST(NEW.access_id AS BLOB))=26 AND substr(NEW.access_id,1,1) BETWEEN '0' AND '7' AND NEW.access_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.organization_id)=26 AND length(CAST(NEW.organization_id AS BLOB))=26 AND substr(NEW.organization_id,1,1) BETWEEN '0' AND '7' AND NEW.organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.project_id)=26 AND length(CAST(NEW.project_id AS BLOB))=26 AND substr(NEW.project_id,1,1) BETWEEN '0' AND '7' AND NEW.project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.environment_id)=26 AND length(CAST(NEW.environment_id AS BLOB))=26 AND substr(NEW.environment_id,1,1) BETWEEN '0' AND '7' AND NEW.environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.data_environment_id)=26 AND length(CAST(NEW.data_environment_id AS BLOB))=26 AND substr(NEW.data_environment_id,1,1) BETWEEN '0' AND '7' AND NEW.data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
)
BEGIN SELECT RAISE(ABORT,'Original product database ULID domain'); END;

CREATE TRIGGER project_database_access_ulid_update BEFORE UPDATE ON project_database_access
WHEN NOT(
 (length(NEW.access_id)=26 AND length(CAST(NEW.access_id AS BLOB))=26 AND substr(NEW.access_id,1,1) BETWEEN '0' AND '7' AND NEW.access_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.organization_id)=26 AND length(CAST(NEW.organization_id AS BLOB))=26 AND substr(NEW.organization_id,1,1) BETWEEN '0' AND '7' AND NEW.organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.project_id)=26 AND length(CAST(NEW.project_id AS BLOB))=26 AND substr(NEW.project_id,1,1) BETWEEN '0' AND '7' AND NEW.project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.environment_id)=26 AND length(CAST(NEW.environment_id AS BLOB))=26 AND substr(NEW.environment_id,1,1) BETWEEN '0' AND '7' AND NEW.environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.data_environment_id)=26 AND length(CAST(NEW.data_environment_id AS BLOB))=26 AND substr(NEW.data_environment_id,1,1) BETWEEN '0' AND '7' AND NEW.data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
)
BEGIN SELECT RAISE(ABORT,'Original product database ULID domain'); END;

CREATE TRIGGER project_database_writes_ulid_insert BEFORE INSERT ON project_database_writes
WHEN NOT(
 (length(NEW.operation_id)=26 AND length(CAST(NEW.operation_id AS BLOB))=26 AND substr(NEW.operation_id,1,1) BETWEEN '0' AND '7' AND NEW.operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.organization_id)=26 AND length(CAST(NEW.organization_id AS BLOB))=26 AND substr(NEW.organization_id,1,1) BETWEEN '0' AND '7' AND NEW.organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.project_id)=26 AND length(CAST(NEW.project_id AS BLOB))=26 AND substr(NEW.project_id,1,1) BETWEEN '0' AND '7' AND NEW.project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.environment_id)=26 AND length(CAST(NEW.environment_id AS BLOB))=26 AND substr(NEW.environment_id,1,1) BETWEEN '0' AND '7' AND NEW.environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.data_environment_id)=26 AND length(CAST(NEW.data_environment_id AS BLOB))=26 AND substr(NEW.data_environment_id,1,1) BETWEEN '0' AND '7' AND NEW.data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.billing_epoch_id)=26 AND length(CAST(NEW.billing_epoch_id AS BLOB))=26 AND substr(NEW.billing_epoch_id,1,1) BETWEEN '0' AND '7' AND NEW.billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
)
BEGIN SELECT RAISE(ABORT,'Original product database ULID domain'); END;

CREATE TRIGGER project_database_writes_ulid_update BEFORE UPDATE ON project_database_writes
WHEN NOT(
 (length(NEW.operation_id)=26 AND length(CAST(NEW.operation_id AS BLOB))=26 AND substr(NEW.operation_id,1,1) BETWEEN '0' AND '7' AND NEW.operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.organization_id)=26 AND length(CAST(NEW.organization_id AS BLOB))=26 AND substr(NEW.organization_id,1,1) BETWEEN '0' AND '7' AND NEW.organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.project_id)=26 AND length(CAST(NEW.project_id AS BLOB))=26 AND substr(NEW.project_id,1,1) BETWEEN '0' AND '7' AND NEW.project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.environment_id)=26 AND length(CAST(NEW.environment_id AS BLOB))=26 AND substr(NEW.environment_id,1,1) BETWEEN '0' AND '7' AND NEW.environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.data_environment_id)=26 AND length(CAST(NEW.data_environment_id AS BLOB))=26 AND substr(NEW.data_environment_id,1,1) BETWEEN '0' AND '7' AND NEW.data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.billing_epoch_id)=26 AND length(CAST(NEW.billing_epoch_id AS BLOB))=26 AND substr(NEW.billing_epoch_id,1,1) BETWEEN '0' AND '7' AND NEW.billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
)
BEGIN SELECT RAISE(ABORT,'Original product database ULID domain'); END;

CREATE TRIGGER pgcf_database_compute_changes_ulid_insert BEFORE INSERT ON pgcf_database_compute_changes
WHEN NOT(
 (length(NEW.operation_id)=26 AND length(CAST(NEW.operation_id AS BLOB))=26 AND substr(NEW.operation_id,1,1) BETWEEN '0' AND '7' AND NEW.operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.organization_id)=26 AND length(CAST(NEW.organization_id AS BLOB))=26 AND substr(NEW.organization_id,1,1) BETWEEN '0' AND '7' AND NEW.organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.project_id)=26 AND length(CAST(NEW.project_id AS BLOB))=26 AND substr(NEW.project_id,1,1) BETWEEN '0' AND '7' AND NEW.project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.environment_id)=26 AND length(CAST(NEW.environment_id AS BLOB))=26 AND substr(NEW.environment_id,1,1) BETWEEN '0' AND '7' AND NEW.environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.data_environment_id)=26 AND length(CAST(NEW.data_environment_id AS BLOB))=26 AND substr(NEW.data_environment_id,1,1) BETWEEN '0' AND '7' AND NEW.data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.billing_epoch_id)=26 AND length(CAST(NEW.billing_epoch_id AS BLOB))=26 AND substr(NEW.billing_epoch_id,1,1) BETWEEN '0' AND '7' AND NEW.billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (NEW.claim_id IS NULL OR (length(NEW.claim_id)=26 AND length(CAST(NEW.claim_id AS BLOB))=26 AND substr(NEW.claim_id,1,1) BETWEEN '0' AND '7' AND NEW.claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'))
)
BEGIN SELECT RAISE(ABORT,'Original product database ULID domain'); END;

CREATE TRIGGER pgcf_database_compute_changes_ulid_update BEFORE UPDATE ON pgcf_database_compute_changes
WHEN NOT(
 (length(NEW.operation_id)=26 AND length(CAST(NEW.operation_id AS BLOB))=26 AND substr(NEW.operation_id,1,1) BETWEEN '0' AND '7' AND NEW.operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.organization_id)=26 AND length(CAST(NEW.organization_id AS BLOB))=26 AND substr(NEW.organization_id,1,1) BETWEEN '0' AND '7' AND NEW.organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.project_id)=26 AND length(CAST(NEW.project_id AS BLOB))=26 AND substr(NEW.project_id,1,1) BETWEEN '0' AND '7' AND NEW.project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.environment_id)=26 AND length(CAST(NEW.environment_id AS BLOB))=26 AND substr(NEW.environment_id,1,1) BETWEEN '0' AND '7' AND NEW.environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.data_environment_id)=26 AND length(CAST(NEW.data_environment_id AS BLOB))=26 AND substr(NEW.data_environment_id,1,1) BETWEEN '0' AND '7' AND NEW.data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.billing_epoch_id)=26 AND length(CAST(NEW.billing_epoch_id AS BLOB))=26 AND substr(NEW.billing_epoch_id,1,1) BETWEEN '0' AND '7' AND NEW.billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (NEW.claim_id IS NULL OR (length(NEW.claim_id)=26 AND length(CAST(NEW.claim_id AS BLOB))=26 AND substr(NEW.claim_id,1,1) BETWEEN '0' AND '7' AND NEW.claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'))
)
BEGIN SELECT RAISE(ABORT,'Original product database ULID domain'); END;
