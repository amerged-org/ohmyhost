-- Control metadata only. Native credentials, users, sessions and audit remain in the private Auth database.
CREATE TABLE native_auth_realms (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  signup_policy TEXT NOT NULL CHECK(signup_policy IN ('open','invite-only')),
  app_name TEXT NOT NULL CHECK(length(app_name) BETWEEN 1 AND 128),
  canonical_origin TEXT,
  allowed_redirect_paths TEXT NOT NULL DEFAULT '["/","/login","/reset-password","/accept-invitation"]' CHECK(json_valid(allowed_redirect_paths) AND json_type(allowed_redirect_paths)='array'),
  reset_password_path TEXT NOT NULL DEFAULT '/reset-password',
  invitation_path TEXT NOT NULL DEFAULT '/accept-invitation',
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision BETWEEN 1 AND 2147483647),
  revocation_epoch INTEGER NOT NULL CHECK(revocation_epoch BETWEEN 1 AND 2147483647),
  PRIMARY KEY (organization_id, project_id, environment_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, project_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments(organization_id, environment_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE native_auth_providers (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('google','github')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  client_id TEXT NOT NULL,
  ciphertext BLOB,
  nonce BLOB,
  value_sha256 BLOB,
  key_version INTEGER,
  last_success_at TEXT CHECK(last_success_at IS NULL OR last_success_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, environment_id, provider),
  FOREIGN KEY (organization_id, project_id, environment_id) REFERENCES native_auth_realms(organization_id, project_id, environment_id),
  CHECK((ciphertext IS NULL AND nonce IS NULL AND value_sha256 IS NULL AND key_version IS NULL)
    OR (ciphertext IS NOT NULL AND nonce IS NOT NULL AND value_sha256 IS NOT NULL AND key_version IS NOT NULL
      AND length(ciphertext) BETWEEN 17 AND 65552 AND length(nonce)=12 AND length(value_sha256)=32 AND key_version>0))
) STRICT, WITHOUT ROWID;

CREATE TABLE native_auth_config_requests (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'),
  PRIMARY KEY (organization_id, project_id, environment_id, operation_id),
  FOREIGN KEY (organization_id, project_id, environment_id) REFERENCES native_auth_realms(organization_id, project_id, environment_id)
) STRICT, WITHOUT ROWID;

-- The Auth database is a project resource and is never aliased to a business data environment.
CREATE TABLE native_auth_database_operations (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  provider_project_id TEXT NOT NULL, name TEXT NOT NULL, region_id TEXT NOT NULL CHECK(region_id IN ('us-dev','eu-dev')),
  size_class_id TEXT NOT NULL CHECK(size_class_id='r256-s500m'), idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','observed','cancelled')),
  dispatched_at TEXT CHECK(dispatched_at IS NULL OR dispatched_at GLOB '????-??-??T??:??:??.??????Z'),
  provider_operation_id TEXT, database_id TEXT,
  PRIMARY KEY(organization_id,project_id,operation_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  CHECK((provider_operation_id IS NULL AND database_id IS NULL) OR (provider_operation_id IS NOT NULL AND database_id IS NOT NULL)),
  CHECK((state IN ('reserved','cancelled') AND dispatched_at IS NULL AND provider_operation_id IS NULL AND database_id IS NULL)
    OR (state='dispatched' AND dispatched_at IS NOT NULL AND provider_operation_id IS NULL AND database_id IS NULL)
    OR (state='observed' AND dispatched_at IS NOT NULL AND provider_operation_id IS NOT NULL AND database_id IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX native_auth_database_one_unresolved ON native_auth_database_operations(project_id) WHERE state IN ('reserved','dispatched');
-- A possibly created database must remain reconcilable under its original accepted identity.
CREATE TRIGGER native_auth_block_unknown_create_terminal BEFORE UPDATE OF state ON operations
WHEN NEW.state IN('succeeded','failed','cancelled') AND OLD.state IN('queued','running')
  AND EXISTS(SELECT 1 FROM native_auth_database_operations n WHERE n.organization_id=OLD.organization_id AND n.project_id=OLD.project_id AND n.operation_id=OLD.operation_id AND n.state='dispatched')
BEGIN SELECT RAISE(ABORT,'native auth create outcome unresolved'); END;
CREATE TRIGGER native_auth_block_unknown_create_claim_release BEFORE DELETE ON product_provider_mutation_claims
WHEN EXISTS(SELECT 1 FROM native_auth_database_operations n WHERE n.organization_id=OLD.organization_id AND n.project_id=OLD.project_id AND n.operation_id=OLD.operation_id AND n.claim_id=OLD.claim_id AND n.state='dispatched')
BEGIN SELECT RAISE(ABORT,'native auth create outcome unresolved'); END;

CREATE TABLE native_auth_database_targets (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  provider_project_id TEXT NOT NULL, database_id TEXT NOT NULL UNIQUE, provider_operation_id TEXT NOT NULL,
  region_id TEXT NOT NULL CHECK(region_id IN ('us-dev','eu-dev')),
  size_class_id TEXT NOT NULL CHECK(size_class_id='r256-s500m'), target_version INTEGER NOT NULL CHECK(target_version>0),
  started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.??????Z'),
  billable_from TEXT NOT NULL CHECK(billable_from=strftime('%Y-%m-%dT%H:00:00.000000Z',started_at)),
  ended_at TEXT CHECK(ended_at IS NULL OR ended_at>=started_at),
  PRIMARY KEY(organization_id,project_id,target_version),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX native_auth_database_target_open ON native_auth_database_targets(project_id) WHERE ended_at IS NULL;
CREATE TRIGGER native_auth_database_target_close_only BEFORE UPDATE ON native_auth_database_targets
  WHEN OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
    OR NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id
    OR NEW.provider_project_id<>OLD.provider_project_id OR NEW.database_id<>OLD.database_id
    OR NEW.provider_operation_id<>OLD.provider_operation_id OR NEW.region_id<>OLD.region_id
    OR NEW.size_class_id<>OLD.size_class_id OR NEW.target_version<>OLD.target_version
    OR NEW.started_at<>OLD.started_at OR NEW.billable_from<>OLD.billable_from
BEGIN SELECT RAISE(ABORT,'native auth target is append-only'); END;
CREATE TRIGGER native_auth_database_target_no_delete BEFORE DELETE ON native_auth_database_targets
BEGIN SELECT RAISE(ABORT,'native auth target is retained'); END;
CREATE TABLE native_auth_role_operations (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  provider_project_id TEXT NOT NULL, database_id TEXT NOT NULL, role_name TEXT NOT NULL,
  step TEXT NOT NULL CHECK(step='role.create:'||role_name), idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','succeeded','failed')),
  provider_operation_id TEXT,
  PRIMARY KEY(organization_id,project_id,operation_id,role_name),
  UNIQUE(project_id,database_id,role_name),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE native_auth_registrations (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL, claim_id TEXT NOT NULL, provider_project_id TEXT NOT NULL, database_id TEXT NOT NULL,
  region_id TEXT NOT NULL CHECK(region_id IN ('us-dev','eu-dev')), origin_host TEXT NOT NULL,
  schema_name TEXT NOT NULL, role_name TEXT NOT NULL, target_version INTEGER NOT NULL CHECK(target_version BETWEEN 1 AND 2147483647),
  registry_version INTEGER NOT NULL CHECK(registry_version BETWEEN 1 AND 2147483647), registry_reference TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','active','revoked')),
  PRIMARY KEY(organization_id,project_id,environment_id,registry_version),
  UNIQUE(registry_reference,registry_version),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES native_auth_realms(organization_id,project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,target_version) REFERENCES native_auth_database_targets(organization_id,project_id,target_version)
) STRICT, WITHOUT ROWID;
CREATE TABLE native_auth_preparation_receipts (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL, claim_id TEXT NOT NULL, provider_project_id TEXT NOT NULL,
  database_id TEXT NOT NULL, target_version INTEGER NOT NULL CHECK(target_version BETWEEN 1 AND 2147483647),
  schema_name TEXT NOT NULL, runtime_role TEXT NOT NULL, migrator_role TEXT NOT NULL, backup_role TEXT NOT NULL,
  migration_digest TEXT NOT NULL CHECK(length(migration_digest)=64 AND migration_digest NOT GLOB '*[^0-9a-f]*'),
  migration_version INTEGER NOT NULL CHECK(migration_version BETWEEN 1 AND 2147483647),
  PRIMARY KEY(organization_id,project_id,environment_id,target_version,migration_version,operation_id),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES native_auth_realms(organization_id,project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,target_version) REFERENCES native_auth_database_targets(organization_id,project_id,target_version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_preparation_no_update BEFORE UPDATE ON native_auth_preparation_receipts
BEGIN SELECT RAISE(ABORT,'native auth preparation is immutable'); END;
CREATE TRIGGER native_auth_preparation_no_delete BEFORE DELETE ON native_auth_preparation_receipts
BEGIN SELECT RAISE(ABORT,'native auth preparation is retained'); END;
CREATE UNIQUE INDEX native_auth_registration_one_active ON native_auth_registrations(organization_id,project_id,environment_id) WHERE state='active';
CREATE TRIGGER native_auth_registration_transition BEFORE UPDATE ON native_auth_registrations
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id
  OR NEW.operation_id<>OLD.operation_id OR NEW.claim_id<>OLD.claim_id OR NEW.provider_project_id<>OLD.provider_project_id
  OR NEW.database_id<>OLD.database_id OR NEW.region_id<>OLD.region_id OR NEW.origin_host<>OLD.origin_host
  OR NEW.schema_name<>OLD.schema_name OR NEW.role_name<>OLD.role_name OR NEW.target_version<>OLD.target_version
  OR NEW.registry_version<>OLD.registry_version OR NEW.registry_reference<>OLD.registry_reference
  OR NOT ((OLD.state='reserved' AND NEW.state='active') OR (OLD.state='active' AND NEW.state='revoked'))
BEGIN SELECT RAISE(ABORT,'native auth registration transition invalid'); END;
CREATE TRIGGER native_auth_registration_no_delete BEFORE DELETE ON native_auth_registrations
BEGIN SELECT RAISE(ABORT,'native auth registration is retained'); END;
CREATE TABLE native_auth_registration_revocations (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  registry_version INTEGER NOT NULL, operation_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  next_registry_version INTEGER NOT NULL CHECK(next_registry_version=registry_version+1 AND next_registry_version<=2147483647),
  PRIMARY KEY(organization_id,project_id,environment_id,registry_version),
  UNIQUE(organization_id,project_id,environment_id,next_registry_version),
  FOREIGN KEY(organization_id,project_id,environment_id,registry_version) REFERENCES native_auth_registrations(organization_id,project_id,environment_id,registry_version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_registration_revocation_no_update BEFORE UPDATE ON native_auth_registration_revocations
BEGIN SELECT RAISE(ABORT,'native auth registration revocation is immutable'); END;
CREATE TRIGGER native_auth_registration_revocation_no_delete BEFORE DELETE ON native_auth_registration_revocations
BEGIN SELECT RAISE(ABORT,'native auth registration revocation is retained'); END;
CREATE TABLE native_auth_deletion_operations (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  target_version INTEGER NOT NULL CHECK(target_version BETWEEN 1 AND 2147483647),
  provider_project_id TEXT NOT NULL, database_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('reserved','dispatched','observed','absent')),
  provider_operation_id TEXT, absent_at TEXT CHECK(absent_at IS NULL OR absent_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,operation_id),
  FOREIGN KEY(organization_id,project_id,target_version) REFERENCES native_auth_database_targets(organization_id,project_id,target_version),
  FOREIGN KEY(organization_id,operation_id) REFERENCES operations(organization_id,operation_id),
  CHECK((state IN('reserved','dispatched') AND provider_operation_id IS NULL AND absent_at IS NULL)
    OR (state='observed' AND provider_operation_id IS NOT NULL AND absent_at IS NULL)
    OR (state='absent' AND absent_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX native_auth_deletion_operation_key ON native_auth_deletion_operations(organization_id,project_id,target_version,idempotency_key);
CREATE INDEX native_auth_deletion_key_lookup ON native_auth_deletion_operations(idempotency_key);
CREATE TRIGGER native_auth_deletion_key_target BEFORE INSERT ON native_auth_deletion_operations
WHEN EXISTS(SELECT 1 FROM native_auth_deletion_operations prior WHERE prior.idempotency_key=NEW.idempotency_key
  AND (prior.organization_id<>NEW.organization_id OR prior.project_id<>NEW.project_id OR prior.target_version<>NEW.target_version OR prior.provider_project_id<>NEW.provider_project_id OR prior.database_id<>NEW.database_id))
BEGIN SELECT RAISE(ABORT,'native auth deletion key target conflict'); END;
CREATE TRIGGER native_auth_deletion_operation_transition BEFORE UPDATE ON native_auth_deletion_operations
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.operation_id<>OLD.operation_id
 OR NEW.target_version<>OLD.target_version OR NEW.provider_project_id<>OLD.provider_project_id OR NEW.database_id<>OLD.database_id OR NEW.idempotency_key<>OLD.idempotency_key
 OR (OLD.provider_operation_id IS NOT NULL AND NEW.provider_operation_id IS NOT OLD.provider_operation_id)
 OR NOT ((OLD.state='reserved' AND NEW.state='dispatched') OR (OLD.state='dispatched' AND NEW.state IN('observed','absent')) OR (OLD.state='observed' AND NEW.state='absent'))
BEGIN SELECT RAISE(ABORT,'native auth deletion transition invalid'); END;
CREATE TRIGGER native_auth_deletion_operation_no_delete BEFORE DELETE ON native_auth_deletion_operations
BEGIN SELECT RAISE(ABORT,'native auth deletion operation is retained'); END;
CREATE TABLE native_auth_deletion_realms (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, operation_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  registry_version INTEGER NOT NULL CHECK(registry_version BETWEEN 1 AND 2147483647), registry_reference TEXT NOT NULL,
  revocation_epoch INTEGER NOT NULL CHECK(revocation_epoch BETWEEN 1 AND 2147483647),
  quiesced_at TEXT CHECK(quiesced_at IS NULL OR quiesced_at GLOB '????-??-??T??:??:??.??????Z'),
  purged_at TEXT CHECK(purged_at IS NULL OR purged_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,operation_id,environment_id),
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES native_auth_deletion_operations(organization_id,project_id,operation_id),
  FOREIGN KEY(organization_id,project_id,environment_id,registry_version) REFERENCES native_auth_registrations(organization_id,project_id,environment_id,registry_version),
  CHECK(purged_at IS NULL OR quiesced_at IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_deletion_realm_transition BEFORE UPDATE ON native_auth_deletion_realms
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.operation_id<>OLD.operation_id OR NEW.environment_id<>OLD.environment_id
 OR NEW.registry_version<>OLD.registry_version OR NEW.registry_reference<>OLD.registry_reference OR NEW.revocation_epoch<>OLD.revocation_epoch
 OR (OLD.quiesced_at IS NOT NULL AND NEW.quiesced_at IS NOT OLD.quiesced_at)
 OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS NOT OLD.purged_at)
 OR (NEW.quiesced_at IS OLD.quiesced_at AND NEW.purged_at IS OLD.purged_at)
BEGIN SELECT RAISE(ABORT,'native auth deletion realm is immutable'); END;
CREATE TRIGGER native_auth_deletion_realm_no_delete BEFORE DELETE ON native_auth_deletion_realms
BEGIN SELECT RAISE(ABORT,'native auth deletion realm is retained'); END;
CREATE TABLE native_auth_handoff_attempts (
  organization_id TEXT NOT NULL, request_hash TEXT NOT NULL, attempt_id TEXT NOT NULL, first_attempt_id TEXT NOT NULL,
  value_sha256 TEXT NOT NULL CHECK(length(value_sha256)=64 AND value_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('active','failed','succeeded')),
  lease_until TEXT NOT NULL CHECK(lease_until GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,request_hash),
  FOREIGN KEY(organization_id,request_hash) REFERENCES mcp_portal_handoffs(organization_id,request_hash) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE native_auth_handoff_attempt_events (
  organization_id TEXT NOT NULL, request_hash TEXT NOT NULL, attempt_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('started','failed','succeeded')),
  occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,request_hash,attempt_id,event),
  FOREIGN KEY(organization_id,request_hash) REFERENCES mcp_portal_handoffs(organization_id,request_hash) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX native_auth_handoff_attempt_one_terminal ON native_auth_handoff_attempt_events(organization_id,request_hash,attempt_id) WHERE event IN ('failed','succeeded');
CREATE TRIGGER native_auth_handoff_event_no_update BEFORE UPDATE ON native_auth_handoff_attempt_events
BEGIN SELECT RAISE(ABORT,'native auth handoff event is immutable'); END;
CREATE TABLE native_auth_user_mutation_acceptances (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT,
  revocation_epoch INTEGER NOT NULL CHECK(revocation_epoch BETWEEN 1 AND 2147483647),
  delegation TEXT CHECK(delegation IS NULL OR json_valid(delegation)),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 255),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,environment_id,idempotency_key),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES native_auth_realms(organization_id,project_id,environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_user_acceptance_no_update BEFORE UPDATE ON native_auth_user_mutation_acceptances
BEGIN SELECT RAISE(ABORT,'native auth user acceptance is immutable'); END;
CREATE TRIGGER native_auth_user_acceptance_no_delete BEFORE DELETE ON native_auth_user_mutation_acceptances
BEGIN SELECT RAISE(ABORT,'native auth user acceptance is retained'); END;
-- Ownership transfer cannot carry private Auth custody until its registry migration is implemented.
CREATE TRIGGER native_auth_block_ownership_transfer BEFORE UPDATE OF owner_state,ownership_version,active_billing_epoch_id ON projects
WHEN (NEW.owner_state IN ('transfer_pending_frozen','transferred') OR NEW.ownership_version<>OLD.ownership_version OR NEW.active_billing_epoch_id<>OLD.active_billing_epoch_id)
  AND (EXISTS(SELECT 1 FROM native_auth_database_targets t WHERE t.project_id=OLD.project_id AND t.ended_at IS NULL)
    OR EXISTS(SELECT 1 FROM native_auth_database_operations o WHERE o.project_id=OLD.project_id AND o.state='dispatched')
    OR EXISTS(SELECT 1 FROM native_auth_registrations r WHERE r.project_id=OLD.project_id))
BEGIN SELECT RAISE(ABORT,'native auth custody transfer unavailable'); END;
-- A live or historical registry can only enter cleanup with a frozen target and realm fences.
CREATE TRIGGER native_auth_block_uninventoried_deletion BEFORE UPDATE OF lifecycle_state ON projects
WHEN NEW.lifecycle_state IN ('deleting','deleted') AND OLD.lifecycle_state='active'
  AND (EXISTS(SELECT 1 FROM native_auth_database_operations o WHERE o.project_id=OLD.project_id AND o.state='dispatched')
    OR EXISTS(SELECT 1 FROM native_auth_database_targets t WHERE t.project_id=OLD.project_id AND t.ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM native_auth_deletion_operations d JOIN operations op USING(organization_id,project_id,operation_id) WHERE d.organization_id=t.organization_id AND d.project_id=t.project_id AND d.target_version=t.target_version AND d.database_id=t.database_id AND d.provider_project_id=t.provider_project_id AND d.state='reserved' AND op.state='queued'))
    OR EXISTS(SELECT 1 FROM native_auth_registrations r WHERE r.project_id=OLD.project_id AND NOT EXISTS(SELECT 1 FROM native_auth_deletion_realms f JOIN native_auth_deletion_operations d USING(organization_id,project_id,operation_id) JOIN native_auth_realms realm USING(organization_id,project_id,environment_id) WHERE f.organization_id=r.organization_id AND f.project_id=r.project_id AND f.environment_id=r.environment_id AND d.state='reserved' AND realm.enabled=0 AND realm.revocation_epoch=f.revocation_epoch)))
BEGIN SELECT RAISE(ABORT,'native auth deletion inventory unavailable'); END;
-- Terminal project state cannot outrun provider absence, private key erasure, or billing closure.
CREATE TRIGGER native_auth_block_unfinished_deletion BEFORE UPDATE OF lifecycle_state ON projects
WHEN NEW.lifecycle_state='deleted' AND OLD.lifecycle_state<>'deleted'
 AND (EXISTS(SELECT 1 FROM native_auth_database_targets t WHERE t.organization_id=OLD.organization_id AND t.project_id=OLD.project_id AND t.ended_at IS NULL)
   OR EXISTS(SELECT 1 FROM native_auth_database_operations o WHERE o.organization_id=OLD.organization_id AND o.project_id=OLD.project_id AND o.state='dispatched')
   OR EXISTS(SELECT 1 FROM native_auth_registrations r WHERE r.organization_id=OLD.organization_id AND r.project_id=OLD.project_id AND NOT EXISTS(SELECT 1 FROM native_auth_deletion_realms f JOIN native_auth_deletion_operations d USING(organization_id,project_id,operation_id) JOIN product_command_intents i USING(organization_id,project_id,operation_id) WHERE f.organization_id=r.organization_id AND f.project_id=r.project_id AND f.environment_id=r.environment_id AND f.registry_version>=r.registry_version AND f.purged_at IS NOT NULL AND d.state='absent' AND i.event_type='ProjectDeletionRequestedV1'))
   OR EXISTS(SELECT 1 FROM native_auth_providers s WHERE s.organization_id=OLD.organization_id AND s.project_id=OLD.project_id AND s.ciphertext IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'native auth deletion incomplete'); END;
