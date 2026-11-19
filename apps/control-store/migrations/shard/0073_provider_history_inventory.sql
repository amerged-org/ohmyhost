-- Provider/recovery closure: the historical, read-only evidence the PGCF provider authority and the recovery inventory
-- read, and the cleanup tables the deletion authority of `database.delete` reads. Every table keeps the columns, identity
-- and append-only rules of the PostgreSQL original (packages/database/migrations 007, 010, 023, 025, 119, 202, plus the
-- cleanup evidence), checked against a real PostgreSQL 18 schema. Organization first in every primary key.
-- NO command creates a Neon placement or role here: rows arrive only by the verified historical import, and a Neon
-- receipt is never a serving target (database_provider_target_heads cannot be ACTIVE on a Neon revision).

-- The immutable plan of a deployment. framework_plan is the validated JSON of the original jsonb column (the Node
-- consumer parses it with parseNewProductionFrameworkPlan; the store keeps it opaque beyond json_valid).
CREATE TABLE deployment_plans (
  organization_id       TEXT    NOT NULL,
  plan_id               TEXT    NOT NULL CHECK (length(plan_id) = 26),
  project_id            TEXT    NOT NULL,
  source_connection_id  TEXT    NOT NULL,
  commit_sha            TEXT    NOT NULL CHECK (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  source_sha256         BLOB    NOT NULL CHECK (length(source_sha256) = 32),
  build_plan_sha256     BLOB    NOT NULL CHECK (length(build_plan_sha256) = 32),
  runtime               TEXT    NOT NULL CHECK (runtime = trim(runtime) AND length(runtime) BETWEEN 1 AND 64),
  impacts               TEXT    NOT NULL CHECK (json_valid(impacts) AND json_type(impacts) = 'array'),
  risks                 TEXT    NOT NULL CHECK (json_valid(risks) AND json_type(risks) = 'array'),
  cost_estimate         TEXT    NOT NULL CHECK (json_valid(cost_estimate) AND json_type(cost_estimate) = 'object'),
  created_at            TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at            TEXT    NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z'),
  plan_sha256           BLOB    NOT NULL CHECK (length(plan_sha256) = 32),
  framework_plan        TEXT    CHECK (framework_plan IS NULL OR (json_valid(framework_plan) AND json_type(framework_plan) = 'object')),
  environment_id        TEXT    NOT NULL,
  source_generation     INTEGER NOT NULL DEFAULT 1 CHECK (source_generation > 0),
  PRIMARY KEY (organization_id, plan_id),
  UNIQUE (organization_id, project_id, plan_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id),
  FOREIGN KEY (organization_id, project_id, source_connection_id) REFERENCES repository_grants (organization_id, project_id, source_connection_id),
  CHECK (expires_at > created_at AND expires_at <= strftime('%Y-%m-%dT%H:%M:%S', created_at, '+24 hours') || substr(created_at, 20))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER deployment_plans_no_update BEFORE UPDATE ON deployment_plans
BEGIN SELECT RAISE(ABORT, 'deployment_plans is append-only'); END;
CREATE TRIGGER deployment_plans_no_delete BEFORE DELETE ON deployment_plans
BEGIN SELECT RAISE(ABORT, 'deployment_plans is append-only'); END;

-- Historical Neon placement of a physical data environment (PostgreSQL migration 023): provenance and import evidence only.
-- operation_ids is the JSON text of the original uuid[] (at most 128 entries).
CREATE TABLE neon_project_placement_receipts (
  organization_id              TEXT    NOT NULL,
  project_id                   TEXT    NOT NULL,
  environment_id               TEXT    NOT NULL,
  operation_id                 TEXT    NOT NULL CHECK (length(operation_id) = 26),
  claim_id                     TEXT    NOT NULL CHECK (length(claim_id) = 26),
  project_name                 TEXT    NOT NULL CHECK (project_name IN ('ohmyho-' || lower(project_id), 'ohmyho-' || lower(project_id) || '-' || lower(environment_id))),
  -- ^aws-[a-z0-9]+(-[a-z0-9]+)*-[0-9]+$: lowercase segments, no empty segment, a numeric last segment.
  region_id                    TEXT    NOT NULL CHECK (region_id GLOB 'aws-*' AND region_id NOT GLOB '*[^a-z0-9-]*' AND region_id NOT GLOB '*--*'
    AND length(rtrim(region_id, '0123456789')) > 5 AND substr(rtrim(region_id, '0123456789'), -1) = '-' AND region_id <> rtrim(region_id, '0123456789')),
  postgres_version             INTEGER NOT NULL CHECK (postgres_version BETWEEN 14 AND 18),
  provider_project_id          TEXT    NOT NULL UNIQUE CHECK (length(provider_project_id) BETWEEN 1 AND 60 AND provider_project_id NOT GLOB '*[^a-z0-9-]*'),
  default_branch_id            TEXT    NOT NULL CHECK (length(default_branch_id) BETWEEN 1 AND 60 AND default_branch_id NOT GLOB '*[^a-z0-9-]*'),
  operation_ids                TEXT    NOT NULL CHECK (json_valid(operation_ids) AND json_type(operation_ids) = 'array' AND json_array_length(operation_ids) <= 128),
  state                        TEXT    NOT NULL CHECK (state = 'ready'),
  observed_at                  TEXT    NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  created_at                   TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  provisioned_compute_profile  TEXT    CHECK (provisioned_compute_profile IS NULL OR provisioned_compute_profile IN ('free', 'paid', 'performance')),
  PRIMARY KEY (organization_id, project_id, environment_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id, environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER neon_project_placement_receipts_no_update BEFORE UPDATE ON neon_project_placement_receipts
BEGIN SELECT RAISE(ABORT, 'neon_project_placement_receipts is append-only'); END;
CREATE TRIGGER neon_project_placement_receipts_no_delete BEFORE DELETE ON neon_project_placement_receipts
BEGIN SELECT RAISE(ABORT, 'neon_project_placement_receipts is append-only'); END;

-- Historical Neon SQL role of that placement (PostgreSQL migrations 025 and 119).
CREATE TABLE neon_project_role_receipts (
  organization_id      TEXT    NOT NULL,
  project_id           TEXT    NOT NULL,
  environment_id       TEXT    NOT NULL,
  operation_id         TEXT    NOT NULL CHECK (length(operation_id) = 26),
  claim_id             TEXT    NOT NULL CHECK (length(claim_id) = 26),
  provider_project_id  TEXT    NOT NULL CHECK (length(provider_project_id) BETWEEN 1 AND 60 AND provider_project_id NOT GLOB '*[^a-z0-9-]*'),
  branch_id            TEXT    NOT NULL CHECK (length(branch_id) BETWEEN 1 AND 60 AND branch_id NOT GLOB '*[^a-z0-9-]*'),
  role_name            TEXT    NOT NULL CHECK (role_name IN ('ohmyho_migration', 'ohmyho_readonly', 'ohmyho_runtime')
    OR role_name IN ('ohmyho_m_' || lower(environment_id), 'ohmyho_ro_' || lower(environment_id), 'ohmyho_rw_' || lower(environment_id))),
  operation_ids        TEXT    NOT NULL CHECK (json_valid(operation_ids) AND json_type(operation_ids) = 'array' AND json_array_length(operation_ids) <= 128),
  state                TEXT    NOT NULL CHECK (state = 'ready'),
  observed_at          TEXT    NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  created_at           TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, environment_id, role_name),
  FOREIGN KEY (organization_id, project_id, environment_id) REFERENCES neon_project_placement_receipts (organization_id, project_id, environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER neon_project_role_receipts_no_update BEFORE UPDATE ON neon_project_role_receipts
BEGIN SELECT RAISE(ABORT, 'neon_project_role_receipts is append-only'); END;
CREATE TRIGGER neon_project_role_receipts_no_delete BEFORE DELETE ON neon_project_role_receipts
BEGIN SELECT RAISE(ABORT, 'neon_project_role_receipts is append-only'); END;

-- Cleanup evidence read by the deletion authority of `database.delete`: the run an accepted deletion or data change
-- opened, and the provider resources frozen into its inventory.
CREATE TABLE cleanup_runs (
  organization_id      TEXT    NOT NULL,
  cleanup_run_id       TEXT    NOT NULL CHECK (length(cleanup_run_id) = 26),
  project_id           TEXT    NOT NULL,
  operation_id         TEXT    NOT NULL,
  state                TEXT    NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'reconciliation_required')),
  revision             INTEGER NOT NULL CHECK (revision > 0),
  reconciliation_code  TEXT,
  created_at           TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at           TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at         TEXT    CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, cleanup_run_id),
  UNIQUE (organization_id, project_id, operation_id),
  UNIQUE (organization_id, project_id, operation_id, cleanup_run_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
  CHECK (updated_at >= created_at
    AND ((state = 'reconciliation_required' AND reconciliation_code IS NOT NULL AND completed_at IS NULL)
      OR (state = 'succeeded' AND reconciliation_code IS NULL AND completed_at IS NOT NULL)
      OR (state IN ('pending', 'running') AND reconciliation_code IS NULL AND completed_at IS NULL)))
) STRICT, WITHOUT ROWID;

CREATE TABLE run_resource_inventory (
  organization_id    TEXT    NOT NULL,
  resource_record_id TEXT    NOT NULL CHECK (length(resource_record_id) = 26),
  project_id         TEXT    NOT NULL,
  operation_id       TEXT    NOT NULL,
  provider           TEXT    NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  resource_kind      TEXT    NOT NULL CHECK (length(resource_kind) BETWEEN 1 AND 64),
  external_ref_hash  BLOB    NOT NULL CHECK (length(external_ref_hash) = 32),
  recorded_at        TEXT    NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  cleanup_locator    TEXT    NOT NULL CHECK (cleanup_locator = trim(cleanup_locator) AND length(cleanup_locator) BETWEEN 1 AND 1024
    AND cleanup_locator NOT GLOB '*[' || char(1) || '-' || char(31) || char(127) || ']*'
    AND cleanup_locator NOT LIKE '%://%' AND cleanup_locator NOT GLOB '*[?@#]*'),
  PRIMARY KEY (organization_id, resource_record_id),
  UNIQUE (organization_id, operation_id, provider, resource_kind, external_ref_hash),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER run_resource_inventory_no_update BEFORE UPDATE ON run_resource_inventory
BEGIN SELECT RAISE(ABORT, 'run_resource_inventory is append-only'); END;
CREATE TRIGGER run_resource_inventory_no_delete BEFORE DELETE ON run_resource_inventory
BEGIN SELECT RAISE(ABORT, 'run_resource_inventory is append-only'); END;
