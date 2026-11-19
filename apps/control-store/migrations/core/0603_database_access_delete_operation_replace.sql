-- P2-ad: migration 0400 made provider_delete_operation_id write-once. A failed role deletion is re-issued under a key
-- derived from the failed operation id, so the id may now change to another id while the revocation is under way. The
-- store replaces it only by compare-and-set on the id it saw fail (product-access.ts). This trigger keeps the state rule:
-- a non-null delete operation id may change to another non-null id only while the access is revoking (revoked_at set,
-- role_dropped_at not set). Clearing it, changing it on an active or fully revoked access stays refused. The create
-- operation id remains write-once, and every other identity column is unchanged. Same trigger name and abort text as 0400.

DROP TRIGGER project_database_access_identity_guard;
CREATE TRIGGER project_database_access_identity_guard BEFORE UPDATE ON project_database_access
WHEN NEW.access_id IS NOT OLD.access_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
 OR NEW.environment_id IS NOT OLD.environment_id OR NEW.environment IS NOT OLD.environment OR NEW.data_environment_id IS NOT OLD.data_environment_id
 OR NEW.provider_project_id IS NOT OLD.provider_project_id OR NEW.default_branch_id IS NOT OLD.default_branch_id OR NEW.role_name IS NOT OLD.role_name
 OR NEW.mode IS NOT OLD.mode OR NEW.label IS NOT OLD.label OR NEW.principal_id IS NOT OLD.principal_id OR NEW.origin_host IS NOT OLD.origin_host
 OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.provider IS NOT OLD.provider OR NEW.database_id IS NOT OLD.database_id
 OR(OLD.provider_create_operation_id IS NOT NULL AND NEW.provider_create_operation_id IS NOT OLD.provider_create_operation_id)
 OR(OLD.provider_delete_operation_id IS NOT NULL AND NEW.provider_delete_operation_id IS NOT OLD.provider_delete_operation_id AND(NEW.provider_delete_operation_id IS NULL OR OLD.revoked_at IS NULL OR OLD.role_dropped_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'Database access target identity is immutable'); END;

-- SQLite fires same-event triggers newest first. The guard above is recreated, so the ULID update check of 0401 is
-- recreated after it with its original text: an invalid identifier still fails with the ULID domain message first.
DROP TRIGGER project_database_access_ulid_update;
CREATE TRIGGER project_database_access_ulid_update BEFORE UPDATE ON project_database_access
WHEN NOT(
 (length(NEW.access_id)=26 AND length(CAST(NEW.access_id AS BLOB))=26 AND substr(NEW.access_id,1,1) BETWEEN '0' AND '7' AND NEW.access_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.organization_id)=26 AND length(CAST(NEW.organization_id AS BLOB))=26 AND substr(NEW.organization_id,1,1) BETWEEN '0' AND '7' AND NEW.organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.project_id)=26 AND length(CAST(NEW.project_id AS BLOB))=26 AND substr(NEW.project_id,1,1) BETWEEN '0' AND '7' AND NEW.project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.environment_id)=26 AND length(CAST(NEW.environment_id AS BLOB))=26 AND substr(NEW.environment_id,1,1) BETWEEN '0' AND '7' AND NEW.environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
 AND (length(NEW.data_environment_id)=26 AND length(CAST(NEW.data_environment_id AS BLOB))=26 AND substr(NEW.data_environment_id,1,1) BETWEEN '0' AND '7' AND NEW.data_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
)
BEGIN SELECT RAISE(ABORT,'Original product database ULID domain'); END;
