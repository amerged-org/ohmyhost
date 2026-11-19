-- Restore state is held in Core, outside the database being restored.
CREATE TABLE native_auth_restores (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL,
  export_operation_id TEXT NOT NULL, database_id TEXT NOT NULL,
  archive_sha256 BLOB NOT NULL CHECK(length(archive_sha256)=32),
  principal_id TEXT NOT NULL, delegation TEXT CHECK(delegation IS NULL OR json_valid(delegation)),
  restore_generation INTEGER NOT NULL CHECK(restore_generation>0),
  captured_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('restoring','complete')),
  PRIMARY KEY(organization_id,project_id,restore_id),
  UNIQUE(organization_id,project_id,restore_generation),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  FOREIGN KEY(organization_id,export_operation_id) REFERENCES project_recovery_jobs(organization_id,operation_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX native_auth_one_restore ON native_auth_restores(organization_id,project_id)
  WHERE state='restoring';
CREATE TABLE native_auth_restore_realms (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL,
  environment_id TEXT NOT NULL, revocation_epoch INTEGER NOT NULL CHECK(revocation_epoch>0),
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision>0),
  PRIMARY KEY(organization_id,project_id,restore_id,environment_id),
  FOREIGN KEY(organization_id,project_id,restore_id) REFERENCES native_auth_restores(organization_id,project_id,restore_id),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES native_auth_realms(organization_id,project_id,environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_restore_identity_immutable BEFORE UPDATE ON native_auth_restores
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.restore_id<>OLD.restore_id
 OR NEW.export_operation_id<>OLD.export_operation_id OR NEW.database_id<>OLD.database_id
 OR NEW.principal_id<>OLD.principal_id OR NEW.delegation IS NOT OLD.delegation
 OR NEW.restore_generation<>OLD.restore_generation
 OR NEW.archive_sha256 IS NOT OLD.archive_sha256 OR NEW.captured_at<>OLD.captured_at
 OR NOT (OLD.state='restoring' AND NEW.state='complete')
BEGIN SELECT RAISE(ABORT,'native auth restore is immutable'); END;
CREATE TRIGGER native_auth_restore_no_delete BEFORE DELETE ON native_auth_restores
BEGIN SELECT RAISE(ABORT,'native auth restore is retained'); END;
CREATE TRIGGER native_auth_restore_realm_no_update BEFORE UPDATE ON native_auth_restore_realms
BEGIN SELECT RAISE(ABORT,'native auth restore realm is immutable'); END;
CREATE TRIGGER native_auth_restore_realm_no_delete BEFORE DELETE ON native_auth_restore_realms
BEGIN SELECT RAISE(ABORT,'native auth restore realm is retained'); END;
CREATE TABLE native_auth_restore_verifications (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  target_version INTEGER NOT NULL CHECK(target_version>0), registry_version INTEGER NOT NULL CHECK(registry_version>0),
  schema_name TEXT NOT NULL, runtime_role TEXT NOT NULL, migrator_role TEXT NOT NULL, backup_role TEXT NOT NULL,
  migration_digest TEXT NOT NULL CHECK(length(migration_digest)=64 AND migration_digest NOT GLOB '*[^0-9a-f]*'),
  migration_version INTEGER NOT NULL CHECK(migration_version>0), verified_at TEXT NOT NULL CHECK(verified_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,restore_id,environment_id,registry_version),
  FOREIGN KEY(organization_id,project_id,restore_id,environment_id) REFERENCES native_auth_restore_realms(organization_id,project_id,restore_id,environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_restore_verification_no_update BEFORE UPDATE ON native_auth_restore_verifications
BEGIN SELECT RAISE(ABORT,'native auth restore verification is immutable'); END;
CREATE TRIGGER native_auth_restore_verification_no_delete BEFORE DELETE ON native_auth_restore_verifications
BEGIN SELECT RAISE(ABORT,'native auth restore verification is retained'); END;
CREATE TABLE native_auth_restore_acknowledgements (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('offline','sanitized')),
  revocation_epoch INTEGER NOT NULL, configuration_revision INTEGER NOT NULL,
  PRIMARY KEY(organization_id,project_id,restore_id,environment_id,kind),
  FOREIGN KEY(organization_id,project_id,restore_id,environment_id) REFERENCES native_auth_restore_realms(organization_id,project_id,restore_id,environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_restore_ack_matches BEFORE INSERT ON native_auth_restore_acknowledgements
WHEN NOT EXISTS(SELECT 1 FROM native_auth_restore_realms rr JOIN native_auth_restores r USING(organization_id,project_id,restore_id)
 WHERE rr.organization_id=NEW.organization_id AND rr.project_id=NEW.project_id AND rr.restore_id=NEW.restore_id AND rr.environment_id=NEW.environment_id AND r.state='restoring'
 AND rr.revocation_epoch=NEW.revocation_epoch AND rr.configuration_revision=NEW.configuration_revision)
BEGIN SELECT RAISE(ABORT,'native auth restore acknowledgement invalid'); END;
CREATE TRIGGER native_auth_restore_ack_no_update BEFORE UPDATE ON native_auth_restore_acknowledgements
BEGIN SELECT RAISE(ABORT,'native auth restore acknowledgement is immutable'); END;
CREATE TRIGGER native_auth_restore_ack_no_delete BEFORE DELETE ON native_auth_restore_acknowledgements
BEGIN SELECT RAISE(ABORT,'native auth restore acknowledgement is retained'); END;
CREATE TABLE native_auth_restore_import_realms (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  imported_at TEXT NOT NULL CHECK(imported_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,restore_id,environment_id),
  FOREIGN KEY(organization_id,project_id,restore_id,environment_id) REFERENCES native_auth_restore_realms(organization_id,project_id,restore_id,environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_restore_import_realm_offline BEFORE INSERT ON native_auth_restore_import_realms
WHEN NOT EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id AND r.restore_id=NEW.restore_id AND r.state='restoring')
 OR EXISTS(SELECT 1 FROM native_auth_restore_realms rr WHERE rr.organization_id=NEW.organization_id AND rr.project_id=NEW.project_id AND rr.restore_id=NEW.restore_id AND NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements a WHERE a.organization_id=rr.organization_id AND a.project_id=rr.project_id AND a.restore_id=rr.restore_id AND a.environment_id=rr.environment_id AND a.kind='offline'))
BEGIN SELECT RAISE(ABORT,'native auth restore is not offline'); END;
CREATE TRIGGER native_auth_restore_import_realm_no_update BEFORE UPDATE ON native_auth_restore_import_realms
BEGIN SELECT RAISE(ABORT,'native auth restore realm import is immutable'); END;
CREATE TRIGGER native_auth_restore_import_realm_no_delete BEFORE DELETE ON native_auth_restore_import_realms
BEGIN SELECT RAISE(ABORT,'native auth restore realm import is retained'); END;
CREATE TABLE native_auth_restore_imports (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL,
  imported_at TEXT NOT NULL CHECK(imported_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,restore_id),
  FOREIGN KEY(organization_id,project_id,restore_id) REFERENCES native_auth_restores(organization_id,project_id,restore_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_restore_import_offline BEFORE INSERT ON native_auth_restore_imports
WHEN NOT EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id AND r.restore_id=NEW.restore_id AND r.state='restoring')
 OR EXISTS(SELECT 1 FROM native_auth_restore_realms rr WHERE rr.organization_id=NEW.organization_id AND rr.project_id=NEW.project_id AND rr.restore_id=NEW.restore_id AND NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements a WHERE a.organization_id=rr.organization_id AND a.project_id=rr.project_id AND a.restore_id=rr.restore_id AND a.environment_id=rr.environment_id AND a.kind='offline'))
 OR EXISTS(SELECT 1 FROM native_auth_restore_realms rr WHERE rr.organization_id=NEW.organization_id AND rr.project_id=NEW.project_id AND rr.restore_id=NEW.restore_id AND NOT EXISTS(SELECT 1 FROM native_auth_restore_import_realms ir WHERE ir.organization_id=rr.organization_id AND ir.project_id=rr.project_id AND ir.restore_id=rr.restore_id AND ir.environment_id=rr.environment_id))
BEGIN SELECT RAISE(ABORT,'native auth restore is not offline'); END;
CREATE TRIGGER native_auth_restore_import_no_update BEFORE UPDATE ON native_auth_restore_imports
BEGIN SELECT RAISE(ABORT,'native auth restore import is immutable'); END;
CREATE TRIGGER native_auth_restore_import_no_delete BEFORE DELETE ON native_auth_restore_imports
BEGIN SELECT RAISE(ABORT,'native auth restore import is retained'); END;
CREATE TRIGGER native_auth_restore_sanitized_after_import BEFORE INSERT ON native_auth_restore_acknowledgements
WHEN NEW.kind='sanitized' AND NOT EXISTS(SELECT 1 FROM native_auth_restore_imports i WHERE i.organization_id=NEW.organization_id AND i.project_id=NEW.project_id AND i.restore_id=NEW.restore_id)
BEGIN SELECT RAISE(ABORT,'native auth restore import missing'); END;
CREATE TRIGGER native_auth_restore_complete_requires_proofs BEFORE UPDATE OF state ON native_auth_restores
WHEN NEW.state='complete' AND (NOT EXISTS(SELECT 1 FROM native_auth_restore_realms rr WHERE rr.organization_id=NEW.organization_id AND rr.project_id=NEW.project_id AND rr.restore_id=NEW.restore_id)
 OR EXISTS(SELECT 1 FROM native_auth_restore_realms rr WHERE rr.organization_id=NEW.organization_id AND rr.project_id=NEW.project_id AND rr.restore_id=NEW.restore_id
 AND (NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements a WHERE a.organization_id=rr.organization_id AND a.project_id=rr.project_id AND a.restore_id=rr.restore_id AND a.environment_id=rr.environment_id AND a.kind='offline')
 OR NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements a WHERE a.organization_id=rr.organization_id AND a.project_id=rr.project_id AND a.restore_id=rr.restore_id AND a.environment_id=rr.environment_id AND a.kind='sanitized')
 OR NOT EXISTS(SELECT 1 FROM native_auth_restore_verifications v JOIN native_auth_registrations reg ON reg.organization_id=v.organization_id AND reg.project_id=v.project_id AND reg.environment_id=v.environment_id AND reg.registry_version=v.registry_version AND reg.target_version=v.target_version AND reg.schema_name=v.schema_name AND reg.role_name=v.runtime_role AND reg.state='active'
 WHERE v.organization_id=rr.organization_id AND v.project_id=rr.project_id AND v.restore_id=rr.restore_id AND v.environment_id=rr.environment_id
 AND v.migrator_role='omh_am_'||lower(rr.environment_id) AND v.backup_role='omh_ab_'||lower(rr.project_id)
 AND v.migration_version=3 AND v.migration_digest='799e3678b725c268176abc97e61ca796ff98c3ab32f2cfb119994aa9e35d3eeb'))))
BEGIN SELECT RAISE(ABORT,'native auth restore proof missing'); END;
-- Prevent a new accepted user operation or configuration change while SQL is replaced.
CREATE TRIGGER native_auth_restore_block_user_acceptance BEFORE INSERT ON native_auth_user_mutation_acceptances
WHEN EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id AND r.state='restoring')
BEGIN SELECT RAISE(ABORT,'native auth restore in progress'); END;
CREATE TRIGGER native_auth_restore_block_realm_update BEFORE UPDATE ON native_auth_realms
WHEN EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=OLD.organization_id AND r.project_id=OLD.project_id AND r.state='restoring')
BEGIN SELECT RAISE(ABORT,'native auth restore in progress'); END;
CREATE TRIGGER native_auth_restore_block_realm_insert BEFORE INSERT ON native_auth_realms
WHEN EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id AND r.state='restoring')
BEGIN SELECT RAISE(ABORT,'native auth restore in progress'); END;
CREATE TRIGGER native_auth_restore_block_registration_insert BEFORE INSERT ON native_auth_registrations
WHEN EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id AND r.state='restoring')
BEGIN SELECT RAISE(ABORT,'native auth restore in progress'); END;
CREATE TRIGGER native_auth_restore_block_registration_update BEFORE UPDATE ON native_auth_registrations
WHEN EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=OLD.organization_id AND r.project_id=OLD.project_id AND r.state='restoring')
BEGIN SELECT RAISE(ABORT,'native auth restore in progress'); END;
CREATE TRIGGER native_auth_restore_block_target_update BEFORE UPDATE ON native_auth_database_targets
WHEN EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=OLD.organization_id AND r.project_id=OLD.project_id AND r.state='restoring')
BEGIN SELECT RAISE(ABORT,'native auth restore in progress'); END;
