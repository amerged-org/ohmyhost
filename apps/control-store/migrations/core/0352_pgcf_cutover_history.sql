-- Original PostgreSQL224 history, imported without rewriting payloads or adding runtime mutation authority.
-- Authorizations already retain historical org/project custody; restore the original GLOBAL operation identity.
CREATE UNIQUE INDEX database_provider_cutover_authorizations_global_operation ON database_provider_cutover_authorizations(operation_id);
CREATE TABLE database_provider_cutover_verifications (
  operation_id TEXT PRIMARY KEY REFERENCES database_provider_cutover_authorizations(operation_id),
  target_database_id TEXT NOT NULL CHECK(length(target_database_id)=20 AND substr(target_database_id,1,1) GLOB '[a-z]' AND target_database_id NOT GLOB '*[^a-z0-9]*'),
  writer_fence_sha256 BLOB NOT NULL CHECK(length(writer_fence_sha256)=32),
  verification_sha256 BLOB NOT NULL CHECK(length(verification_sha256)=32),
  verified_at TEXT NOT NULL CHECK(verified_at GLOB '????-??-??T??:??:??.??????Z'),
  verified_by TEXT NOT NULL CHECK(length(verified_by) BETWEEN 1 AND 256)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER database_provider_cutover_verifications_no_update BEFORE UPDATE ON database_provider_cutover_verifications
BEGIN SELECT RAISE(ABORT,'cutover verification is append-only'); END;
CREATE TRIGGER database_provider_cutover_verifications_no_delete BEFORE DELETE ON database_provider_cutover_verifications
BEGIN SELECT RAISE(ABORT,'cutover verification is append-only'); END;
CREATE TABLE database_provider_cutover_receipts (
  operation_id TEXT NOT NULL REFERENCES database_provider_cutover_authorizations(operation_id),
  phase TEXT NOT NULL CHECK(phase IN('prepared','roles_ready','source_revoked','registered','activated')),
  metadata TEXT NOT NULL CHECK(json_valid(metadata) AND json_type(metadata)='object'),
  recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(operation_id,phase)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER database_provider_cutover_receipts_no_update BEFORE UPDATE ON database_provider_cutover_receipts
BEGIN SELECT RAISE(ABORT,'cutover receipt is append-only'); END;
CREATE TRIGGER database_provider_cutover_receipts_no_delete BEFORE DELETE ON database_provider_cutover_receipts
BEGIN SELECT RAISE(ABORT,'cutover receipt is append-only'); END;
CREATE TABLE database_provider_cutover_binding_refreshes (
  cutover_operation_id TEXT NOT NULL REFERENCES database_provider_cutover_authorizations(operation_id),
  refresh_operation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,project_id TEXT NOT NULL,environment_id TEXT NOT NULL,physical_environment_id TEXT NOT NULL,
  target_version INTEGER NOT NULL,target_registration_version INTEGER NOT NULL,
  approved_at TEXT NOT NULL CHECK(approved_at GLOB '????-??-??T??:??:??.??????Z'),approved_by TEXT NOT NULL,
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,physical_environment_id,target_version) REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER database_provider_cutover_binding_refreshes_no_update BEFORE UPDATE ON database_provider_cutover_binding_refreshes
BEGIN SELECT RAISE(ABORT,'cutover refresh history is append-only'); END;
CREATE TRIGGER database_provider_cutover_binding_refreshes_no_delete BEFORE DELETE ON database_provider_cutover_binding_refreshes
BEGIN SELECT RAISE(ABORT,'cutover refresh history is append-only'); END;
