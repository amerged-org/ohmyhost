-- Q4-A: the provider target history of a physical data environment (PostgreSQL migrations 202, 224, 228). Every table
-- carries the organization first, so one organization's rows live on its shard.
-- Neon rows are historical provenance only: no head may be ACTIVE on a Neon revision, so there is no Neon target to
-- serve and no fallback to one. That a PGCF database serves one tenant is enforced inside the shard here; the same
-- check across shards belongs to the global `pgcf_database` external route of the directory (activation lane).

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
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
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
CREATE INDEX database_provider_target_revisions_resource ON database_provider_target_revisions (provider, provider_project_id, database_id);
CREATE TRIGGER database_provider_target_revisions_no_update BEFORE UPDATE ON database_provider_target_revisions
BEGIN SELECT RAISE(ABORT, 'database_provider_target_revisions is append-only'); END;
CREATE TRIGGER database_provider_target_revisions_no_delete BEFORE DELETE ON database_provider_target_revisions
BEGIN SELECT RAISE(ABORT, 'database_provider_target_revisions is append-only'); END;

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
CREATE TRIGGER database_provider_target_heads_pgcf_only_insert BEFORE INSERT ON database_provider_target_heads
  WHEN NEW.state = 'active' AND NOT EXISTS (SELECT 1 FROM database_provider_target_revisions r WHERE r.organization_id = NEW.organization_id AND r.project_id = NEW.project_id AND r.physical_environment_id = NEW.physical_environment_id AND r.target_version = NEW.target_version AND r.provider = 'pgcf')
BEGIN SELECT RAISE(ABORT, 'E55000 only a PGCF target can be active'); END;
CREATE TRIGGER database_provider_target_heads_guard BEFORE UPDATE ON database_provider_target_heads
  WHEN NEW.organization_id <> OLD.organization_id OR NEW.project_id <> OLD.project_id OR NEW.physical_environment_id <> OLD.physical_environment_id OR NEW.target_version < OLD.target_version
    OR (NEW.state = 'active' AND NOT EXISTS (SELECT 1 FROM database_provider_target_revisions r WHERE r.organization_id = NEW.organization_id AND r.project_id = NEW.project_id AND r.physical_environment_id = NEW.physical_environment_id AND r.target_version = NEW.target_version AND r.provider = 'pgcf'))
BEGIN SELECT RAISE(ABORT, 'E55000 provider target identity cannot be rewritten and only a PGCF target can be active'); END;
CREATE TRIGGER database_provider_target_heads_one_tenant_update BEFORE UPDATE ON database_provider_target_heads
  WHEN NEW.state = 'active' AND EXISTS (
    SELECT 1 FROM database_provider_target_revisions mine
      JOIN database_provider_target_revisions other ON other.provider = 'pgcf' AND other.provider_project_id = mine.provider_project_id AND other.database_id = mine.database_id
      JOIN database_provider_target_heads head ON head.organization_id = other.organization_id AND head.project_id = other.project_id AND head.physical_environment_id = other.physical_environment_id AND head.target_version = other.target_version AND head.state = 'active'
     WHERE mine.organization_id = NEW.organization_id AND mine.project_id = NEW.project_id AND mine.physical_environment_id = NEW.physical_environment_id AND mine.target_version = NEW.target_version AND mine.provider = 'pgcf'
       AND (head.organization_id <> NEW.organization_id OR head.project_id <> NEW.project_id OR head.physical_environment_id <> NEW.physical_environment_id))
BEGIN SELECT RAISE(ABORT, 'E42501 PGCF database already belongs to another physical identity'); END;
CREATE TRIGGER database_provider_target_heads_one_tenant_insert BEFORE INSERT ON database_provider_target_heads
  WHEN NEW.state = 'active' AND EXISTS (
    SELECT 1 FROM database_provider_target_revisions mine
      JOIN database_provider_target_revisions other ON other.provider = 'pgcf' AND other.provider_project_id = mine.provider_project_id AND other.database_id = mine.database_id
      JOIN database_provider_target_heads head ON head.organization_id = other.organization_id AND head.project_id = other.project_id AND head.physical_environment_id = other.physical_environment_id AND head.target_version = other.target_version AND head.state = 'active'
     WHERE mine.organization_id = NEW.organization_id AND mine.project_id = NEW.project_id AND mine.physical_environment_id = NEW.physical_environment_id AND mine.target_version = NEW.target_version AND mine.provider = 'pgcf'
       AND (head.organization_id <> NEW.organization_id OR head.project_id <> NEW.project_id OR head.physical_environment_id <> NEW.physical_environment_id))
BEGIN SELECT RAISE(ABORT, 'E42501 PGCF database already belongs to another physical identity'); END;

-- A provider mutation recorded before it is dispatched: replays return the SAME key, target and body.
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
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
  CHECK ((state = 'reserved') = (dispatched_at IS NULL))
) STRICT, WITHOUT ROWID;
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

-- Owner-proven absence of a legacy Neon branch (PostgreSQL migration 228); it permits the first PGCF successor target.
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
CREATE TRIGGER database_provider_legacy_retirements_no_update BEFORE UPDATE ON database_provider_legacy_retirements
BEGIN SELECT RAISE(ABORT, 'database_provider_legacy_retirements is append-only'); END;
CREATE TRIGGER database_provider_legacy_retirements_no_delete BEFORE DELETE ON database_provider_legacy_retirements
BEGIN SELECT RAISE(ABORT, 'database_provider_legacy_retirements is append-only'); END;
