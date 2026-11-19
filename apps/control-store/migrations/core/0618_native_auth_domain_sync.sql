-- Domain/handle completion waits for exact private realm-policy acknowledgement.
CREATE TABLE native_auth_domain_operations (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('paid_delete','handle_change')), identity TEXT NOT NULL,
  original_input TEXT NOT NULL CHECK(json_valid(original_input) AND json_type(original_input)='object'),
  state TEXT NOT NULL CHECK(state IN('pending','completed','cancelled')),
  PRIMARY KEY(organization_id,project_id,kind,identity),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_domain_operation_transition BEFORE UPDATE ON native_auth_domain_operations
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.kind<>OLD.kind OR NEW.identity<>OLD.identity
 OR NEW.original_input IS NOT OLD.original_input OR NOT(OLD.state='pending' AND NEW.state IN('completed','cancelled'))
BEGIN SELECT RAISE(ABORT,'native auth domain operation is immutable'); END;
CREATE TRIGGER native_auth_domain_operation_no_delete BEFORE DELETE ON native_auth_domain_operations
BEGIN SELECT RAISE(ABORT,'native auth domain operation is retained'); END;
CREATE TABLE native_auth_domain_policy_syncs (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, identity TEXT NOT NULL, environment_id TEXT NOT NULL,
  old_origin TEXT NOT NULL, head_deployment_id TEXT, head_revision_id TEXT, head_version INTEGER NOT NULL CHECK(head_version>=0),
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision BETWEEN 1 AND 2147483647),
  revocation_epoch INTEGER NOT NULL CHECK(revocation_epoch BETWEEN 1 AND 2147483647),
  owner_enabled INTEGER NOT NULL CHECK(owner_enabled IN(0,1)), registry_version INTEGER CHECK(registry_version IS NULL OR registry_version BETWEEN 1 AND 2147483647),
  state TEXT NOT NULL CHECK(state IN('pending','acknowledged')),
  acknowledgement TEXT CHECK(acknowledgement IS NULL OR (json_valid(acknowledgement) AND json_type(acknowledgement)='object')),
  PRIMARY KEY(organization_id,project_id,kind,identity,environment_id),
  FOREIGN KEY(organization_id,project_id,kind,identity) REFERENCES native_auth_domain_operations(organization_id,project_id,kind,identity),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES native_auth_realms(organization_id,project_id,environment_id),
  CHECK((head_deployment_id IS NULL)=(head_revision_id IS NULL)),
  CHECK((state='pending' AND acknowledgement IS NULL) OR (state='acknowledged' AND acknowledgement IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX native_auth_domain_one_pending_realm ON native_auth_domain_policy_syncs(organization_id,project_id,environment_id) WHERE state='pending';
CREATE TRIGGER native_auth_domain_operation_requires_ack BEFORE UPDATE OF state ON native_auth_domain_operations
WHEN NEW.state IN('completed','cancelled') AND EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s WHERE s.organization_id=OLD.organization_id AND s.project_id=OLD.project_id AND s.kind=OLD.kind AND s.identity=OLD.identity AND s.state<>'acknowledged')
BEGIN SELECT RAISE(ABORT,'native auth domain policy acknowledgement pending'); END;
CREATE TABLE native_auth_domain_recoveries (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, identity TEXT NOT NULL,
  recovery_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, delegation TEXT CHECK(delegation IS NULL OR json_valid(delegation)),
  request_sha256 BLOB CHECK(request_sha256 IS NULL OR length(request_sha256)=32), recovery_operation_id TEXT,
  state TEXT NOT NULL CHECK(state IN('pending','completed','cancelled')),
  PRIMARY KEY(organization_id,project_id,kind,identity,recovery_id),
  FOREIGN KEY(organization_id,project_id,kind,identity) REFERENCES native_auth_domain_operations(organization_id,project_id,kind,identity)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX native_auth_domain_one_recovery_pending ON native_auth_domain_recoveries(organization_id,project_id,kind,identity) WHERE state='pending';
CREATE TRIGGER native_auth_domain_recovery_transition BEFORE UPDATE ON native_auth_domain_recoveries
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.kind<>OLD.kind OR NEW.identity<>OLD.identity OR NEW.recovery_id<>OLD.recovery_id
 OR NEW.principal_id<>OLD.principal_id OR NEW.delegation IS NOT OLD.delegation OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.recovery_operation_id IS NOT OLD.recovery_operation_id
 OR NOT(OLD.state='pending' AND NEW.state IN('completed','cancelled'))
BEGIN SELECT RAISE(ABORT,'native auth domain recovery is immutable'); END;
CREATE TRIGGER native_auth_domain_recovery_no_delete BEFORE DELETE ON native_auth_domain_recoveries
BEGIN SELECT RAISE(ABORT,'native auth domain recovery is retained'); END;
CREATE TRIGGER native_auth_domain_policy_transition BEFORE UPDATE ON native_auth_domain_policy_syncs
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.kind<>OLD.kind OR NEW.identity<>OLD.identity OR NEW.environment_id<>OLD.environment_id
 OR NEW.old_origin<>OLD.old_origin OR NEW.head_deployment_id IS NOT OLD.head_deployment_id OR NEW.head_revision_id IS NOT OLD.head_revision_id OR NEW.head_version<>OLD.head_version
 OR NEW.configuration_revision<>OLD.configuration_revision OR NEW.revocation_epoch<>OLD.revocation_epoch OR NEW.owner_enabled<>OLD.owner_enabled OR NEW.registry_version IS NOT OLD.registry_version
 OR NOT(OLD.state='pending' AND NEW.state='acknowledged')
BEGIN SELECT RAISE(ABORT,'native auth domain policy snapshot is immutable'); END;
CREATE TRIGGER native_auth_domain_policy_no_delete BEFORE DELETE ON native_auth_domain_policy_syncs
BEGIN SELECT RAISE(ABORT,'native auth domain policy snapshot is retained'); END;
-- Permit only the initial origin-loss fence while a domain ACK is pending; all other policy changes wait.
CREATE TRIGGER native_auth_domain_block_concurrent_realm_update BEFORE UPDATE ON native_auth_realms
WHEN EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s WHERE s.organization_id=OLD.organization_id AND s.project_id=OLD.project_id AND s.environment_id=OLD.environment_id AND s.state='pending')
 AND NOT EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s WHERE s.organization_id=OLD.organization_id AND s.project_id=OLD.project_id AND s.environment_id=OLD.environment_id AND s.state='pending'
   AND OLD.canonical_origin=s.old_origin AND NEW.canonical_origin IS NULL
   AND NEW.configuration_revision=OLD.configuration_revision+1 AND NEW.configuration_revision=s.configuration_revision
   AND NEW.revocation_epoch=OLD.revocation_epoch+1 AND NEW.revocation_epoch=s.revocation_epoch
   AND NEW.enabled=OLD.enabled AND NEW.enabled=s.owner_enabled AND NEW.signup_policy=OLD.signup_policy AND NEW.app_name=OLD.app_name
   AND NEW.allowed_redirect_paths=OLD.allowed_redirect_paths AND NEW.reset_password_path=OLD.reset_password_path AND NEW.invitation_path=OLD.invitation_path)
BEGIN SELECT RAISE(ABORT,'native auth domain policy acknowledgement pending'); END;
CREATE TRIGGER native_auth_domain_block_concurrent_head BEFORE UPDATE OF active_deployment_id,active_revision_id,head_version ON environments
WHEN (NEW.active_deployment_id IS NOT OLD.active_deployment_id OR NEW.active_revision_id IS NOT OLD.active_revision_id OR NEW.head_version<>OLD.head_version)
 AND EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s WHERE s.organization_id=OLD.organization_id AND s.project_id=OLD.project_id AND s.environment_id=OLD.environment_id AND s.state='pending')
BEGIN SELECT RAISE(ABORT,'native auth domain policy acknowledgement pending'); END;
CREATE TRIGGER native_auth_domain_block_registration_insert BEFORE INSERT ON native_auth_registrations
WHEN EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s WHERE s.organization_id=NEW.organization_id AND s.project_id=NEW.project_id AND s.environment_id=NEW.environment_id AND s.state='pending')
BEGIN SELECT RAISE(ABORT,'native auth domain policy acknowledgement pending'); END;
CREATE TRIGGER native_auth_domain_block_registration_update BEFORE UPDATE ON native_auth_registrations
WHEN EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s WHERE s.organization_id=OLD.organization_id AND s.project_id=OLD.project_id AND s.environment_id=OLD.environment_id AND s.state='pending')
BEGIN SELECT RAISE(ABORT,'native auth domain policy acknowledgement pending'); END;
CREATE TRIGGER native_auth_domain_block_role_insert BEFORE INSERT ON native_auth_role_operations
WHEN EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s WHERE s.organization_id=NEW.organization_id AND s.project_id=NEW.project_id AND s.environment_id=NEW.environment_id AND s.state='pending')
BEGIN SELECT RAISE(ABORT,'native auth domain policy acknowledgement pending'); END;
CREATE TRIGGER native_auth_domain_block_preparation_insert BEFORE INSERT ON native_auth_preparation_receipts
WHEN EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s WHERE s.organization_id=NEW.organization_id AND s.project_id=NEW.project_id AND s.environment_id=NEW.environment_id AND s.state='pending')
BEGIN SELECT RAISE(ABORT,'native auth domain policy acknowledgement pending'); END;
CREATE TRIGGER native_auth_domain_block_restore_realm_insert BEFORE INSERT ON native_auth_restore_realms
WHEN EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s WHERE s.organization_id=NEW.organization_id AND s.project_id=NEW.project_id AND s.environment_id=NEW.environment_id AND s.state='pending')
BEGIN SELECT RAISE(ABORT,'native auth domain policy acknowledgement pending'); END;
