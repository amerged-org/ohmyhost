-- Restore the exact native PostgreSQL physical/operation scopes. No FK is disabled or deferred.
-- Stage only this closed provider family and its FK children, restore every field unchanged in dependency order,
-- then restore every original index/immutable/head trigger. ONE migration batch has no observable guard gap.
CREATE UNIQUE INDEX product_provider_mutation_claims_provider_scope ON product_provider_mutation_claims(claim_id,organization_id,project_id,operation_id);
CREATE TABLE database_provider_operations_copy_0353 AS SELECT * FROM database_provider_operations;
CREATE TABLE database_provider_target_revisions_copy_0353 AS SELECT * FROM database_provider_target_revisions;
CREATE TABLE neon_project_placement_reservations_copy_0353 AS SELECT * FROM neon_project_placement_reservations;
CREATE TABLE pgcf_database_migration_receipts_copy_0353 AS SELECT * FROM pgcf_database_migration_receipts;
CREATE TABLE pgcf_database_serving_intervals_copy_0353 AS SELECT * FROM pgcf_database_serving_intervals;
CREATE TABLE project_database_registration_receipts_copy_0353 AS SELECT * FROM project_database_registration_receipts;
CREATE TABLE project_database_registration_reservations_copy_0353 AS SELECT * FROM project_database_registration_reservations;
CREATE TABLE database_provider_cutover_binding_refreshes_copy_0353 AS SELECT * FROM database_provider_cutover_binding_refreshes;
CREATE TABLE database_provider_legacy_retirements_copy_0353 AS SELECT * FROM database_provider_legacy_retirements;
CREATE TABLE database_provider_target_heads_copy_0353 AS SELECT * FROM database_provider_target_heads;
DROP TABLE database_provider_target_heads;
DROP TABLE database_provider_legacy_retirements;
DROP TABLE database_provider_cutover_binding_refreshes;
DROP TABLE project_database_registration_reservations;
DROP TABLE project_database_registration_receipts;
DROP TABLE pgcf_database_serving_intervals;
DROP TABLE pgcf_database_migration_receipts;
DROP TABLE neon_project_placement_reservations;
DROP TABLE database_provider_target_revisions;
DROP TABLE database_provider_operations;
CREATE TABLE database_provider_operations (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  operation_id             TEXT    NOT NULL,
  claim_id                 TEXT    NOT NULL CHECK (length(claim_id) = 26),
  step                     TEXT    NOT NULL CHECK (length(step) BETWEEN 1 AND 128 AND substr(step, 1, 1) GLOB '[a-z]' AND step NOT GLOB '*[^a-z0-9_.:-]*'),
  idempotency_key          TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) = 68 AND substr(idempotency_key, 1, 4) = 'omh-' AND substr(idempotency_key, 5) NOT GLOB '*[^a-f0-9]*'),
  provider_project_id      TEXT    NOT NULL CHECK (length(provider_project_id) = 24 AND substr(provider_project_id, 1, 4) = 'prj_' AND substr(provider_project_id, 5) NOT GLOB '*[^a-z0-9]*'),
  request_digest           BLOB    NOT NULL CHECK (length(request_digest) = 32),
  request_body             TEXT    NOT NULL CHECK (json_valid(request_body) AND json_type(request_body) = 'object'),
  provider_operation_id    TEXT    CHECK (provider_operation_id IS NULL OR (length(provider_operation_id) = 23 AND substr(provider_operation_id, 1, 3) = 'op_' AND substr(provider_operation_id, 4) NOT GLOB '*[^a-z0-9]*')),
  database_id              TEXT    CHECK (database_id IS NULL OR (length(database_id) = 20 AND substr(database_id, 1, 1) GLOB '[a-z]' AND database_id NOT GLOB '*[^a-z0-9]*')),
  state                    TEXT    NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'dispatched', 'pending', 'succeeded', 'failed')),
  dispatched_at            TEXT    CHECK (dispatched_at IS NULL OR dispatched_at GLOB '????-??-??T??:??:??.??????Z'),
  observed_at              TEXT    CHECK (observed_at IS NULL OR observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, operation_id, step),
  FOREIGN KEY (organization_id, project_id, physical_environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id),
  FOREIGN KEY (organization_id, project_id, operation_id) REFERENCES operations (organization_id, project_id, operation_id),
  CHECK ((state = 'reserved') = (dispatched_at IS NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO database_provider_operations SELECT * FROM database_provider_operations_copy_0353;
CREATE TABLE database_provider_target_revisions (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL CHECK (length(physical_environment_id) = 26),
  target_version           INTEGER NOT NULL CHECK (target_version > 0),
  provider                 TEXT    NOT NULL CHECK (provider IN ('neon', 'pgcf')),
  provider_project_id      TEXT    NOT NULL,
  database_id              TEXT,
  branch_id                TEXT,
  region_id                TEXT    NOT NULL,
  size_class_id            TEXT,
  runtime_role             TEXT    NOT NULL,
  -- A reference to the sealed credential in the registry, never the credential itself.
  credential_reference     TEXT    NOT NULL CHECK (length(credential_reference) BETWEEN 1 AND 256),
  operation_id             TEXT    CHECK (operation_id IS NULL OR length(operation_id) = 26),
  created_at               TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, target_version),
  FOREIGN KEY (organization_id, project_id, physical_environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id),
  FOREIGN KEY (organization_id, project_id, operation_id) REFERENCES operations (organization_id, project_id, operation_id),
  CHECK (runtime_role = 'ohmyho_rw_' || lower(physical_environment_id)),
  CHECK (
    (provider = 'neon'
      AND length(provider_project_id) BETWEEN 1 AND 60 AND provider_project_id NOT GLOB '*[^a-z0-9-]*'
      AND length(branch_id) BETWEEN 1 AND 60 AND branch_id NOT GLOB '*[^a-z0-9-]*'
      AND database_id IS NULL AND size_class_id IS NULL)
    OR
    (provider = 'pgcf'
      AND length(provider_project_id) = 24 AND substr(provider_project_id, 1, 4) = 'prj_' AND substr(provider_project_id, 5) NOT GLOB '*[^a-z0-9]*'
      AND length(database_id) = 20 AND substr(database_id, 1, 1) GLOB '[a-z]' AND database_id NOT GLOB '*[^a-z0-9]*'
      AND branch_id IS NULL AND region_id IN ('us-dev', 'eu-dev')
      AND length(size_class_id) BETWEEN 2 AND 32 AND substr(size_class_id, 1, 1) GLOB '[a-z]' AND size_class_id NOT GLOB '*[^a-z0-9-]*' AND substr(size_class_id, -1) <> '-')
  )
) STRICT, WITHOUT ROWID;
INSERT INTO database_provider_target_revisions SELECT * FROM database_provider_target_revisions_copy_0353;
CREATE TABLE neon_project_placement_reservations (
  organization_id   TEXT    NOT NULL,
  project_id        TEXT    NOT NULL,
  environment_id    TEXT    NOT NULL,
  operation_id      TEXT    NOT NULL,
  claim_id          TEXT    NOT NULL,
  project_name      TEXT    NOT NULL CHECK (length(project_name) = 33 AND substr(project_name, 1, 7) = 'ohmyho-'
                      AND substr(project_name, 8, 1) GLOB '[0-7]' AND substr(project_name, 8) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  region_id         TEXT    NOT NULL CHECK (region_id GLOB 'aws-*-[0-9]*' AND region_id NOT GLOB '*[^a-z0-9-]*' AND length(region_id) <= 64),
  postgres_version  INTEGER NOT NULL CHECK (postgres_version BETWEEN 14 AND 18),
  reserved_at       TEXT    NOT NULL CHECK (reserved_at GLOB '????-??-??T??:??:??.??????Z'),
  create_started_at TEXT    CHECK (create_started_at IS NULL OR (create_started_at GLOB '????-??-??T??:??:??.??????Z' AND create_started_at >= reserved_at)),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (claim_id, organization_id, project_id, operation_id) REFERENCES product_provider_mutation_claims (claim_id, organization_id, project_id, operation_id),
  FOREIGN KEY (organization_id, project_id, environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id)
) STRICT, WITHOUT ROWID;
INSERT INTO neon_project_placement_reservations SELECT * FROM neon_project_placement_reservations_copy_0353;
CREATE TABLE pgcf_database_migration_receipts (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  operation_id             TEXT    NOT NULL,
  claim_id                 TEXT    NOT NULL CHECK (length(claim_id) = 26),
  provider_project_id      TEXT    NOT NULL CHECK (length(provider_project_id) = 24 AND substr(provider_project_id, 1, 4) = 'prj_' AND substr(provider_project_id, 5) NOT GLOB '*[^a-z0-9]*'),
  database_id              TEXT    NOT NULL CHECK (length(database_id) = 20 AND substr(database_id, 1, 1) GLOB '[a-z]' AND database_id NOT GLOB '*[^a-z0-9]*'),
  bundle_sha256            BLOB    NOT NULL CHECK (length(bundle_sha256) = 32),
  applied_paths            TEXT    NOT NULL CHECK (json_valid(applied_paths) AND json_type(applied_paths) = 'array'),
  replayed_paths           TEXT    NOT NULL CHECK (json_valid(replayed_paths) AND json_type(replayed_paths) = 'array'),
  completed_at             TEXT    NOT NULL CHECK (completed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, operation_id),
  FOREIGN KEY (organization_id, project_id, operation_id) REFERENCES operations (organization_id, project_id, operation_id)
) STRICT, WITHOUT ROWID;
INSERT INTO pgcf_database_migration_receipts SELECT * FROM pgcf_database_migration_receipts_copy_0353;
CREATE TABLE pgcf_database_serving_intervals (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  target_version           INTEGER NOT NULL,
  provider_project_id      TEXT    NOT NULL,
  database_id              TEXT    NOT NULL,
  started_at               TEXT    NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.??????Z'),
  billable_from            TEXT    NOT NULL CHECK (billable_from = strftime('%Y-%m-%dT%H:00:00.000000Z', substr(started_at,1,13)||':00:00Z', '+1 hour')),
  ended_at                 TEXT    CHECK (ended_at IS NULL OR (ended_at GLOB '????-??-??T??:??:??.??????Z' AND ended_at >= started_at)),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, started_at),
  FOREIGN KEY (organization_id, project_id, physical_environment_id, target_version)
    REFERENCES database_provider_target_revisions (organization_id, project_id, physical_environment_id, target_version)
) STRICT, WITHOUT ROWID;
INSERT INTO pgcf_database_serving_intervals SELECT * FROM pgcf_database_serving_intervals_copy_0353;
CREATE TABLE project_database_registration_receipts (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  operation_id             TEXT    NOT NULL,
  claim_id                 TEXT    NOT NULL CHECK (length(claim_id) = 26),
  registration_version     INTEGER NOT NULL CHECK (registration_version > 0),
  status                   TEXT    NOT NULL CHECK (status IN ('active', 'revoked')),
  metadata                 TEXT    NOT NULL CHECK (json_valid(metadata) AND json_type(metadata) = 'object'
    AND json_extract(metadata, '$.organizationId') = organization_id AND json_extract(metadata, '$.projectId') = project_id
    AND json_extract(metadata, '$.physicalEnvironmentId') = physical_environment_id AND json_extract(metadata, '$.operationId') = operation_id
    AND json_extract(metadata, '$.registrationVersion') = registration_version AND json_extract(metadata, '$.status') = status
    AND json_extract(metadata, '$.region') IN ('us', 'eu')
    AND json_extract(metadata, '$.originUser') = 'ohmyho_rw_' || lower(physical_environment_id)
    AND json_type(metadata, '$.authorizedEnvironmentIds') = 'array' AND json_array_length(metadata, '$.authorizedEnvironmentIds') BETWEEN 1 AND 2
    AND ((json_extract(metadata, '$.provider') = 'pgcf'
          AND json_extract(metadata, '$.originDatabase') = json_extract(metadata, '$.databaseId')
          AND length(json_extract(metadata, '$.providerProjectId')) = 24 AND substr(json_extract(metadata, '$.providerProjectId'), 1, 4) = 'prj_'
          AND length(json_extract(metadata, '$.databaseId')) = 20 AND substr(json_extract(metadata, '$.databaseId'), 1, 1) GLOB '[a-z]')
      OR (json_extract(metadata, '$.provider') IS NULL
          AND json_extract(metadata, '$.originDatabase') = 'neondb' AND json_type(metadata, '$.branchId') = 'text'))),
  observed_at              TEXT    NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, registration_version),
  FOREIGN KEY (organization_id, project_id, physical_environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id),
  FOREIGN KEY (organization_id, project_id, operation_id) REFERENCES operations (organization_id, project_id, operation_id)
) STRICT, WITHOUT ROWID;
INSERT INTO project_database_registration_receipts SELECT * FROM project_database_registration_receipts_copy_0353;
CREATE TABLE project_database_registration_reservations (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  operation_id             TEXT    NOT NULL,
  claim_id                 TEXT    NOT NULL CHECK (length(claim_id) = 26),
  registration_version     INTEGER NOT NULL CHECK (registration_version > 0),
  metadata                 TEXT    NOT NULL CHECK (json_valid(metadata) AND json_type(metadata) = 'object'
    AND json_extract(metadata, '$.organizationId') = organization_id AND json_extract(metadata, '$.projectId') = project_id
    AND json_extract(metadata, '$.physicalEnvironmentId') = physical_environment_id AND json_extract(metadata, '$.operationId') = operation_id
    AND json_extract(metadata, '$.registrationVersion') = registration_version
    AND json_extract(metadata, '$.status') IN ('active', 'revoked') AND json_extract(metadata, '$.region') IN ('us', 'eu')
    AND json_extract(metadata, '$.originUser') = 'ohmyho_rw_' || lower(physical_environment_id)
    AND json_type(metadata, '$.authorizedEnvironmentIds') = 'array' AND json_array_length(metadata, '$.authorizedEnvironmentIds') BETWEEN 1 AND 2
    AND ((json_extract(metadata, '$.provider') = 'pgcf'
          AND json_extract(metadata, '$.originDatabase') = json_extract(metadata, '$.databaseId')
          AND length(json_extract(metadata, '$.providerProjectId')) = 24 AND substr(json_extract(metadata, '$.providerProjectId'), 1, 4) = 'prj_'
          AND length(json_extract(metadata, '$.databaseId')) = 20 AND substr(json_extract(metadata, '$.databaseId'), 1, 1) GLOB '[a-z]')
      OR (json_extract(metadata, '$.provider') IS NULL
          AND json_extract(metadata, '$.originDatabase') = 'neondb' AND json_type(metadata, '$.branchId') = 'text'))),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, registration_version),
  FOREIGN KEY (organization_id, project_id, physical_environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id),
  FOREIGN KEY (organization_id, project_id, operation_id) REFERENCES operations (organization_id, project_id, operation_id)
) STRICT, WITHOUT ROWID;
INSERT INTO project_database_registration_reservations SELECT * FROM project_database_registration_reservations_copy_0353;
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
INSERT INTO database_provider_cutover_binding_refreshes SELECT * FROM database_provider_cutover_binding_refreshes_copy_0353;
CREATE TABLE database_provider_legacy_retirements (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  target_version           INTEGER NOT NULL,
  provider_project_id      TEXT    NOT NULL,
  branch_id                TEXT    NOT NULL,
  manifest_sha256          BLOB    NOT NULL CHECK (length(manifest_sha256) = 32),
  inventory_sha256         BLOB    NOT NULL CHECK (length(inventory_sha256) = 32),
  retired_at               TEXT    NOT NULL CHECK (retired_at GLOB '????-??-??T??:??:??.??????Z'),
  retired_by               TEXT    NOT NULL CHECK (length(retired_by) BETWEEN 1 AND 256),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, target_version),
  FOREIGN KEY (organization_id, project_id, physical_environment_id, target_version)
    REFERENCES database_provider_target_revisions (organization_id, project_id, physical_environment_id, target_version)
) STRICT, WITHOUT ROWID;
INSERT INTO database_provider_legacy_retirements SELECT * FROM database_provider_legacy_retirements_copy_0353;
CREATE TABLE database_provider_target_heads (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  target_version           INTEGER NOT NULL,
  state                    TEXT    NOT NULL CHECK (state IN ('active', 'retired')),
  -- Set when the target starts serving; the first full UTC hour after it is the first billable hour.
  activated_at             TEXT    CHECK (activated_at IS NULL OR activated_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at               TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, physical_environment_id),
  FOREIGN KEY (organization_id, project_id, physical_environment_id, target_version)
    REFERENCES database_provider_target_revisions (organization_id, project_id, physical_environment_id, target_version)
) STRICT, WITHOUT ROWID;
INSERT INTO database_provider_target_heads SELECT * FROM database_provider_target_heads_copy_0353;
CREATE TRIGGER database_provider_cutover_binding_refreshes_no_delete BEFORE DELETE ON database_provider_cutover_binding_refreshes
BEGIN SELECT RAISE(ABORT,'cutover refresh history is append-only'); END;
CREATE TRIGGER database_provider_cutover_binding_refreshes_no_update BEFORE UPDATE ON database_provider_cutover_binding_refreshes
BEGIN SELECT RAISE(ABORT,'cutover refresh history is append-only'); END;
CREATE TRIGGER database_provider_legacy_retirements_no_delete BEFORE DELETE ON database_provider_legacy_retirements
BEGIN SELECT RAISE(ABORT, 'database_provider_legacy_retirements is append-only'); END;
CREATE TRIGGER database_provider_legacy_retirements_no_update BEFORE UPDATE ON database_provider_legacy_retirements
BEGIN SELECT RAISE(ABORT, 'database_provider_legacy_retirements is append-only'); END;
CREATE TRIGGER database_provider_operations_identity BEFORE UPDATE ON database_provider_operations
  WHEN NEW.organization_id <> OLD.organization_id OR NEW.project_id <> OLD.project_id OR NEW.physical_environment_id <> OLD.physical_environment_id
    OR NEW.operation_id <> OLD.operation_id OR NEW.claim_id <> OLD.claim_id OR NEW.step <> OLD.step OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.provider_project_id <> OLD.provider_project_id OR NEW.request_digest <> OLD.request_digest OR NEW.request_body <> OLD.request_body
    OR (OLD.provider_operation_id IS NOT NULL AND NEW.provider_operation_id IS NOT OLD.provider_operation_id)
    OR (OLD.database_id IS NOT NULL AND NEW.database_id IS NOT OLD.database_id)
    OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
    OR (OLD.state IN ('succeeded', 'failed') AND (NEW.state <> OLD.state OR NEW.provider_operation_id IS NOT OLD.provider_operation_id OR NEW.database_id IS NOT OLD.database_id OR NEW.dispatched_at IS NOT OLD.dispatched_at OR NEW.observed_at IS NOT OLD.observed_at))
BEGIN SELECT RAISE(ABORT, 'E55000 provider operation identity is immutable'); END;
CREATE TRIGGER database_provider_operations_no_delete BEFORE DELETE ON database_provider_operations
BEGIN SELECT RAISE(ABORT, 'E55000 provider operation identity is immutable'); END;
CREATE TRIGGER database_provider_target_heads_guard BEFORE UPDATE ON database_provider_target_heads
  WHEN NEW.organization_id <> OLD.organization_id OR NEW.project_id <> OLD.project_id OR NEW.physical_environment_id <> OLD.physical_environment_id OR NEW.target_version < OLD.target_version
    OR (NEW.state = 'active' AND NOT EXISTS (SELECT 1 FROM database_provider_target_revisions r WHERE r.organization_id = NEW.organization_id AND r.project_id = NEW.project_id AND r.physical_environment_id = NEW.physical_environment_id AND r.target_version = NEW.target_version AND r.provider = 'pgcf'))
BEGIN SELECT RAISE(ABORT, 'E55000 provider target identity cannot be rewritten and only a PGCF target can be active'); END;
CREATE TRIGGER database_provider_target_heads_one_tenant_insert BEFORE INSERT ON database_provider_target_heads
  WHEN NEW.state = 'active' AND EXISTS (
    SELECT 1 FROM database_provider_target_revisions mine
      JOIN database_provider_target_revisions other ON other.provider = 'pgcf' AND other.provider_project_id = mine.provider_project_id AND other.database_id = mine.database_id
      JOIN database_provider_target_heads head ON head.organization_id = other.organization_id AND head.project_id = other.project_id AND head.physical_environment_id = other.physical_environment_id AND head.target_version = other.target_version AND head.state = 'active'
     WHERE mine.organization_id = NEW.organization_id AND mine.project_id = NEW.project_id AND mine.physical_environment_id = NEW.physical_environment_id AND mine.target_version = NEW.target_version AND mine.provider = 'pgcf'
       AND (head.organization_id <> NEW.organization_id OR head.project_id <> NEW.project_id OR head.physical_environment_id <> NEW.physical_environment_id))
BEGIN SELECT RAISE(ABORT, 'E42501 PGCF database already belongs to another physical identity'); END;
CREATE TRIGGER database_provider_target_heads_one_tenant_update BEFORE UPDATE ON database_provider_target_heads
  WHEN NEW.state = 'active' AND EXISTS (
    SELECT 1 FROM database_provider_target_revisions mine
      JOIN database_provider_target_revisions other ON other.provider = 'pgcf' AND other.provider_project_id = mine.provider_project_id AND other.database_id = mine.database_id
      JOIN database_provider_target_heads head ON head.organization_id = other.organization_id AND head.project_id = other.project_id AND head.physical_environment_id = other.physical_environment_id AND head.target_version = other.target_version AND head.state = 'active'
     WHERE mine.organization_id = NEW.organization_id AND mine.project_id = NEW.project_id AND mine.physical_environment_id = NEW.physical_environment_id AND mine.target_version = NEW.target_version AND mine.provider = 'pgcf'
       AND (head.organization_id <> NEW.organization_id OR head.project_id <> NEW.project_id OR head.physical_environment_id <> NEW.physical_environment_id))
BEGIN SELECT RAISE(ABORT, 'E42501 PGCF database already belongs to another physical identity'); END;
CREATE TRIGGER database_provider_target_heads_pgcf_only_insert BEFORE INSERT ON database_provider_target_heads
  WHEN NEW.state = 'active' AND NOT EXISTS (SELECT 1 FROM database_provider_target_revisions r WHERE r.organization_id = NEW.organization_id AND r.project_id = NEW.project_id AND r.physical_environment_id = NEW.physical_environment_id AND r.target_version = NEW.target_version AND r.provider = 'pgcf')
BEGIN SELECT RAISE(ABORT, 'E55000 only a PGCF target can be active'); END;
CREATE TRIGGER database_provider_target_revisions_no_delete BEFORE DELETE ON database_provider_target_revisions
BEGIN SELECT RAISE(ABORT, 'database_provider_target_revisions is append-only'); END;
CREATE TRIGGER database_provider_target_revisions_no_update BEFORE UPDATE ON database_provider_target_revisions
BEGIN SELECT RAISE(ABORT, 'database_provider_target_revisions is append-only'); END;
CREATE INDEX database_provider_target_revisions_resource ON database_provider_target_revisions (provider, provider_project_id, database_id);
CREATE TRIGGER pgcf_database_migration_receipts_no_delete BEFORE DELETE ON pgcf_database_migration_receipts
BEGIN SELECT RAISE(ABORT, 'pgcf_database_migration_receipts is append-only'); END;
CREATE TRIGGER pgcf_database_migration_receipts_no_update BEFORE UPDATE ON pgcf_database_migration_receipts
BEGIN SELECT RAISE(ABORT, 'pgcf_database_migration_receipts is append-only'); END;
CREATE TRIGGER pgcf_serving_interval_close_only BEFORE UPDATE ON pgcf_database_serving_intervals
  WHEN OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
    OR NEW.organization_id <> OLD.organization_id OR NEW.project_id <> OLD.project_id OR NEW.physical_environment_id <> OLD.physical_environment_id
    OR NEW.target_version <> OLD.target_version OR NEW.provider_project_id <> OLD.provider_project_id OR NEW.database_id <> OLD.database_id
    OR NEW.started_at <> OLD.started_at OR NEW.billable_from <> OLD.billable_from
BEGIN SELECT RAISE(ABORT, 'PGCF serving history is immutable'); END;
CREATE TRIGGER pgcf_serving_interval_no_delete BEFORE DELETE ON pgcf_database_serving_intervals
BEGIN SELECT RAISE(ABORT, 'PGCF serving history is immutable'); END;
CREATE TRIGGER pgcf_serving_interval_on_head_delete AFTER DELETE ON database_provider_target_heads
BEGIN
  UPDATE pgcf_database_serving_intervals SET ended_at = strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'
   WHERE organization_id = OLD.organization_id AND project_id = OLD.project_id AND physical_environment_id = OLD.physical_environment_id AND ended_at IS NULL;
END;
CREATE TRIGGER pgcf_serving_interval_on_head_insert AFTER INSERT ON database_provider_target_heads
  WHEN NEW.state = 'active' AND NEW.activated_at IS NOT NULL
BEGIN
  INSERT INTO pgcf_database_serving_intervals(organization_id, project_id, physical_environment_id, target_version, provider_project_id, database_id, started_at, billable_from, ended_at)
  SELECT r.organization_id, r.project_id, r.physical_environment_id, r.target_version, r.provider_project_id, r.database_id, NEW.activated_at, strftime('%Y-%m-%dT%H:00:00.000000Z', substr(NEW.activated_at,1,13)||':00:00Z', '+1 hour'), NULL
    FROM database_provider_target_revisions r
   WHERE r.organization_id = NEW.organization_id AND r.project_id = NEW.project_id AND r.physical_environment_id = NEW.physical_environment_id AND r.target_version = NEW.target_version AND r.provider = 'pgcf';
END;
CREATE TRIGGER pgcf_serving_interval_on_head_update AFTER UPDATE ON database_provider_target_heads
BEGIN
  UPDATE pgcf_database_serving_intervals SET ended_at = CASE WHEN NEW.updated_at IS OLD.updated_at THEN strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z' ELSE NEW.updated_at END
   WHERE organization_id = OLD.organization_id AND project_id = OLD.project_id AND physical_environment_id = OLD.physical_environment_id AND ended_at IS NULL
     AND NOT (NEW.state = 'active' AND NEW.activated_at IS NOT NULL AND NEW.activated_at = started_at AND EXISTS (SELECT 1 FROM database_provider_target_revisions current_target WHERE current_target.organization_id = NEW.organization_id AND current_target.project_id = NEW.project_id AND current_target.physical_environment_id = NEW.physical_environment_id AND current_target.target_version = NEW.target_version AND current_target.provider = 'pgcf' AND current_target.provider_project_id = pgcf_database_serving_intervals.provider_project_id AND current_target.database_id = pgcf_database_serving_intervals.database_id));
  INSERT INTO pgcf_database_serving_intervals(organization_id, project_id, physical_environment_id, target_version, provider_project_id, database_id, started_at, billable_from, ended_at)
  SELECT r.organization_id, r.project_id, r.physical_environment_id, r.target_version, r.provider_project_id, r.database_id, NEW.activated_at, strftime('%Y-%m-%dT%H:00:00.000000Z', substr(NEW.activated_at,1,13)||':00:00Z', '+1 hour'), NULL
    FROM database_provider_target_revisions r
   WHERE NEW.state = 'active' AND NEW.activated_at IS NOT NULL
     AND r.organization_id = NEW.organization_id AND r.project_id = NEW.project_id AND r.physical_environment_id = NEW.physical_environment_id AND r.target_version = NEW.target_version AND r.provider = 'pgcf'
     AND NOT EXISTS (SELECT 1 FROM pgcf_database_serving_intervals still_open WHERE still_open.organization_id = NEW.organization_id AND still_open.project_id = NEW.project_id AND still_open.physical_environment_id = NEW.physical_environment_id AND still_open.ended_at IS NULL);
END;
CREATE UNIQUE INDEX pgcf_serving_interval_open_database ON pgcf_database_serving_intervals (provider_project_id, database_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX pgcf_serving_interval_open_physical ON pgcf_database_serving_intervals (organization_id, project_id, physical_environment_id) WHERE ended_at IS NULL;
CREATE INDEX pgcf_serving_interval_usage ON pgcf_database_serving_intervals (provider_project_id, database_id, started_at);
CREATE TRIGGER project_database_registration_receipts_no_delete BEFORE DELETE ON project_database_registration_receipts
BEGIN SELECT RAISE(ABORT, 'project_database_registration_receipts is append-only'); END;
CREATE TRIGGER project_database_registration_receipts_no_update BEFORE UPDATE ON project_database_registration_receipts
BEGIN SELECT RAISE(ABORT, 'project_database_registration_receipts is append-only'); END;
CREATE TRIGGER project_database_registration_receipts_shape BEFORE INSERT ON project_database_registration_receipts
  WHEN (SELECT count(*) FROM json_each(NEW.metadata)) <> CASE json_extract(NEW.metadata, '$.provider') WHEN 'pgcf' THEN 14 ELSE 13 END
BEGIN SELECT RAISE(ABORT, 'registration metadata has an unexpected key set'); END;
CREATE TRIGGER project_database_registration_reservations_delete_after_receipt BEFORE DELETE ON project_database_registration_reservations
  WHEN NOT EXISTS (SELECT 1 FROM project_database_registration_receipts receipt WHERE receipt.organization_id = OLD.organization_id AND receipt.project_id = OLD.project_id AND receipt.physical_environment_id = OLD.physical_environment_id AND receipt.registration_version = OLD.registration_version AND receipt.metadata = OLD.metadata)
BEGIN SELECT RAISE(ABORT, 'a registration reservation is deleted only after its receipt exists'); END;
CREATE TRIGGER project_database_registration_reservations_no_update BEFORE UPDATE ON project_database_registration_reservations
BEGIN SELECT RAISE(ABORT, 'project_database_registration_reservations is append-only'); END;
CREATE TRIGGER project_database_registration_reservations_shape BEFORE INSERT ON project_database_registration_reservations
  WHEN (SELECT count(*) FROM json_each(NEW.metadata)) <> CASE json_extract(NEW.metadata, '$.provider') WHEN 'pgcf' THEN 14 ELSE 13 END
BEGIN SELECT RAISE(ABORT, 'registration metadata has an unexpected key set'); END;
DROP TABLE database_provider_target_heads_copy_0353;
DROP TABLE database_provider_legacy_retirements_copy_0353;
DROP TABLE database_provider_cutover_binding_refreshes_copy_0353;
DROP TABLE project_database_registration_reservations_copy_0353;
DROP TABLE project_database_registration_receipts_copy_0353;
DROP TABLE pgcf_database_serving_intervals_copy_0353;
DROP TABLE pgcf_database_migration_receipts_copy_0353;
DROP TABLE neon_project_placement_reservations_copy_0353;
DROP TABLE database_provider_target_revisions_copy_0353;
DROP TABLE database_provider_operations_copy_0353;
