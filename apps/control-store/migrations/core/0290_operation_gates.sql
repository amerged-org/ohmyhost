-- core-v1 source: migrations/shard/0090_operation_gates.sql
-- Q6 operation gates: the Postgres facts the lease-recovery, accept and delegation-assert commands read to refuse unsafe work.
-- Every table keeps the columns, identity and append-only rules of its PostgreSQL original (packages/database/migrations
-- 007/008/023/061/171/173/176/224); no row is converted by this migration and no command writes the source tables yet
-- (the source-control, deployment and PGCF cutover lanes own their writers). Sizes of text identities follow the shard DDL.

-- A Neon project placement keeps its mutation claim alive while the reservation is unresolved (D431): the composite
-- unique index is the parent key of the reservation's foreign key, exactly as product_provider_mutation_claims_neon_identity_key.
CREATE UNIQUE INDEX product_provider_mutation_claims_neon_identity
  ON product_provider_mutation_claims (claim_id, organization_id, project_id, environment_id, operation_id);

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
  FOREIGN KEY (claim_id, organization_id, project_id, environment_id, operation_id)
    REFERENCES product_provider_mutation_claims (claim_id, organization_id, project_id, environment_id, operation_id)
) STRICT, WITHOUT ROWID;

-- Source control facts read by the source-generation recheck and the promote/rollback confirmation.
CREATE TABLE source_connections (
  organization_id         TEXT NOT NULL,
  source_connection_id    TEXT NOT NULL CHECK (length(source_connection_id) = 26),
  project_id              TEXT NOT NULL,
  billing_epoch_id        TEXT NOT NULL,
  provider                TEXT NOT NULL CHECK (provider IN ('github', 'managed')),
  external_repository_id  TEXT NOT NULL,
  created_at              TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, source_connection_id),
  UNIQUE (organization_id, project_id, source_connection_id),
  UNIQUE (organization_id, project_id, source_connection_id, provider),
  UNIQUE (organization_id, project_id, billing_epoch_id, source_connection_id, external_repository_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, billing_epoch_id) REFERENCES billing_epochs (organization_id, billing_epoch_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE repository_grants (
  organization_id        TEXT NOT NULL,
  grant_id               TEXT NOT NULL CHECK (length(grant_id) = 26),
  project_id             TEXT NOT NULL,
  billing_epoch_id       TEXT NOT NULL,
  source_connection_id   TEXT NOT NULL,
  provider               TEXT NOT NULL,
  github_installation_id TEXT NOT NULL,
  external_repository_id TEXT NOT NULL,
  repository_owner       TEXT NOT NULL,
  repository_name        TEXT NOT NULL,
  permission             TEXT NOT NULL,
  granted_at             TEXT NOT NULL CHECK (granted_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, grant_id),
  UNIQUE (organization_id, project_id, grant_id),
  UNIQUE (organization_id, project_id, source_connection_id),
  FOREIGN KEY (organization_id, project_id, billing_epoch_id, source_connection_id, external_repository_id)
    REFERENCES source_connections (organization_id, project_id, billing_epoch_id, source_connection_id, external_repository_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE repository_grant_revocations (
  organization_id  TEXT NOT NULL,
  revocation_id    TEXT NOT NULL CHECK (length(revocation_id) = 26),
  grant_id         TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  reason           TEXT NOT NULL CHECK (reason IN ('installation_uninstalled', 'permission_revoked', 'repository_removed')),
  revoked_at       TEXT NOT NULL CHECK (revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, revocation_id),
  UNIQUE (grant_id),
  FOREIGN KEY (organization_id, project_id, grant_id) REFERENCES repository_grants (organization_id, project_id, grant_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER repository_grant_revocations_no_update BEFORE UPDATE ON repository_grant_revocations
BEGIN SELECT RAISE(ABORT, 'repository_grant_revocations is append-only'); END;
CREATE TRIGGER repository_grant_revocations_no_delete BEFORE DELETE ON repository_grant_revocations
BEGIN SELECT RAISE(ABORT, 'repository_grant_revocations is append-only'); END;

CREATE TABLE project_source_bindings (
  organization_id       TEXT    NOT NULL,
  project_id            TEXT    NOT NULL,
  source_connection_id  TEXT    NOT NULL,
  provider              TEXT    NOT NULL CHECK (provider IN ('github', 'managed')),
  generation            INTEGER NOT NULL CHECK (generation > 0),
  commit_sha            TEXT    CHECK (commit_sha IS NULL OR (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*' AND commit_sha <> '0000000000000000000000000000000000000000')),
  updated_at            TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  CHECK (provider = 'github' OR commit_sha IS NOT NULL),
  FOREIGN KEY (organization_id, project_id, source_connection_id, provider)
    REFERENCES source_connections (organization_id, project_id, source_connection_id, provider)
) STRICT, WITHOUT ROWID;

-- GitHub push deployments: lease recovery fails the unfinished ones of an abandoned operation and marks them for cleanup.
CREATE TABLE github_push_deployments (
  organization_id        TEXT    NOT NULL,
  push_deployment_id     TEXT    NOT NULL CHECK (length(push_deployment_id) = 26),
  inbox_event_id         TEXT    NOT NULL,
  project_id             TEXT    NOT NULL,
  source_connection_id   TEXT    NOT NULL,
  config_generation      INTEGER NOT NULL CHECK (config_generation > 0),
  delivery_guid          TEXT    NOT NULL,
  github_installation_id TEXT    NOT NULL CHECK (github_installation_id NOT GLOB '*[^0-9]*' AND github_installation_id NOT GLOB '0*' AND length(github_installation_id) BETWEEN 1 AND 20),
  external_repository_id TEXT    NOT NULL CHECK (external_repository_id NOT GLOB '*[^0-9]*' AND external_repository_id NOT GLOB '0*' AND length(external_repository_id) BETWEEN 1 AND 16),
  branch_ref             TEXT    NOT NULL CHECK (branch_ref GLOB 'refs/heads/*'),
  commit_sha             TEXT    NOT NULL CHECK (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*' AND commit_sha <> '0000000000000000000000000000000000000000'),
  sequence               INTEGER NOT NULL CHECK (sequence > 0),
  operation_id           TEXT    NOT NULL,
  state                  TEXT    NOT NULL CHECK (state IN ('queued', 'running', 'superseded', 'failed', 'active', 'reconciliation_required')),
  superseded_by_id       TEXT,
  cleanup_required       INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_required IN (0, 1)),
  created_at             TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at             TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at >= created_at),
  PRIMARY KEY (organization_id, push_deployment_id),
  UNIQUE (organization_id, project_id, delivery_guid),
  CHECK ((state = 'superseded' AND superseded_by_id IS NOT NULL AND cleanup_required = 1)
      OR (state <> 'superseded' AND superseded_by_id IS NULL)),
  FOREIGN KEY (organization_id, inbox_event_id) REFERENCES webhook_inbox (organization_id, inbox_event_id),
  FOREIGN KEY (organization_id, project_id, source_connection_id) REFERENCES repository_grants (organization_id, project_id, source_connection_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
  FOREIGN KEY (organization_id, superseded_by_id) REFERENCES github_push_deployments (organization_id, push_deployment_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX github_push_deployments_by_operation ON github_push_deployments (organization_id, operation_id);

-- Action confirmations: issued by a confirmation route, consumed once by the accepting batch. A promote/rollback
-- confirmation also pins the source generation it was issued under.
CREATE TABLE action_confirmations (
  organization_id         TEXT    NOT NULL,
  confirmation_id         TEXT    NOT NULL CHECK (length(confirmation_id) = 26),
  project_id              TEXT    NOT NULL,
  issued_to_principal_id  TEXT    NOT NULL CHECK (issued_to_principal_id = trim(issued_to_principal_id) AND length(issued_to_principal_id) BETWEEN 1 AND 255),
  action                  TEXT    NOT NULL CHECK (action IN ('rollback', 'promote', 'delete', 'data_change')),
  target_deployment_id    TEXT,
  subject_etag            TEXT    NOT NULL CHECK (subject_etag = trim(subject_etag) AND length(subject_etag) BETWEEN 1 AND 255),
  token_sha256            BLOB    NOT NULL UNIQUE CHECK (length(token_sha256) = 32),
  source_generation       INTEGER CHECK (source_generation IS NULL OR source_generation >= 0),
  created_at              TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at              TEXT    NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z' AND expires_at > created_at),
  consumed_at             TEXT    CHECK (consumed_at IS NULL OR (consumed_at GLOB '????-??-??T??:??:??.??????Z' AND consumed_at >= created_at AND consumed_at <= expires_at)),
  PRIMARY KEY (organization_id, confirmation_id),
  CHECK ((action IN ('rollback', 'promote') AND target_deployment_id IS NOT NULL)
      OR (action IN ('delete', 'data_change') AND target_deployment_id IS NULL)),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, target_deployment_id) REFERENCES deployments (organization_id, deployment_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX action_confirmations_open ON action_confirmations (organization_id, project_id, action, issued_to_principal_id)
  WHERE consumed_at IS NULL;

-- PGCF provider cutover gate (PostgreSQL migration 224): a project is gated while it has an authorization without a
-- release. Both tables are append-only evidence; the cutover lane writes them, this lane only reads.
CREATE TABLE database_provider_cutover_authorizations (
  organization_id            TEXT    NOT NULL,
  operation_id               TEXT    NOT NULL,
  project_id                 TEXT    NOT NULL,
  physical_environment_id    TEXT    NOT NULL,
  manifest_sha256            BLOB    NOT NULL CHECK (length(manifest_sha256) = 32),
  expected_lifecycle_version INTEGER NOT NULL CHECK (expected_lifecycle_version > 0),
  source_target_version      INTEGER NOT NULL CHECK (source_target_version > 0),
  source_registration        TEXT    NOT NULL CHECK (json_valid(source_registration)),
  target_provider_project_id TEXT    NOT NULL CHECK (length(target_provider_project_id) = 24 AND substr(target_provider_project_id, 1, 4) = 'prj_' AND substr(target_provider_project_id, 5) NOT GLOB '*[^a-z0-9]*'),
  target_region_id           TEXT    NOT NULL CHECK (target_region_id = 'us-dev'),
  target_size_class_id       TEXT    NOT NULL,
  approved_at                TEXT    NOT NULL CHECK (approved_at GLOB '????-??-??T??:??:??.??????Z'),
  approved_by                TEXT    NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 256),
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX database_provider_cutover_authorizations_by_project ON database_provider_cutover_authorizations (organization_id, project_id);
CREATE TRIGGER database_provider_cutover_authorizations_no_update BEFORE UPDATE ON database_provider_cutover_authorizations
BEGIN SELECT RAISE(ABORT, 'database_provider_cutover_authorizations is append-only'); END;
CREATE TRIGGER database_provider_cutover_authorizations_no_delete BEFORE DELETE ON database_provider_cutover_authorizations
BEGIN SELECT RAISE(ABORT, 'database_provider_cutover_authorizations is append-only'); END;

CREATE TABLE database_provider_cutover_releases (
  organization_id TEXT NOT NULL,
  operation_id    TEXT NOT NULL,
  released_at     TEXT NOT NULL CHECK (released_at GLOB '????-??-??T??:??:??.??????Z'),
  released_by     TEXT NOT NULL CHECK (length(released_by) BETWEEN 1 AND 256),
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES database_provider_cutover_authorizations (organization_id, operation_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER database_provider_cutover_releases_no_update BEFORE UPDATE ON database_provider_cutover_releases
BEGIN SELECT RAISE(ABORT, 'database_provider_cutover_releases is append-only'); END;
CREATE TRIGGER database_provider_cutover_releases_no_delete BEFORE DELETE ON database_provider_cutover_releases
BEGIN SELECT RAISE(ABORT, 'database_provider_cutover_releases is append-only'); END;

-- Raw inbox evidence is purged only through a registered, verified export: a webhook_inbox row in the
-- reconciliation_required state is deletable only when it lies at or below the table's retention horizon AND inside a month
-- with a recorded evidence_exports row of its organization. Acknowledged rows keep their own, earlier policy.
CREATE TRIGGER webhook_inbox_reconciliation_delete_requires_export BEFORE DELETE ON webhook_inbox
WHEN OLD.state = 'reconciliation_required'
  AND (OLD.received_at > COALESCE((SELECT exported_through FROM retention_horizon WHERE table_name = 'webhook_inbox'), '')
    OR NOT EXISTS (SELECT 1 FROM evidence_exports ex WHERE ex.organization_id = OLD.organization_id AND ex.table_name = 'webhook_inbox'
         AND ex.period_start <= OLD.received_at AND OLD.received_at < ex.period_end))
BEGIN SELECT RAISE(ABORT, 'a reconciliation-required inbox event is deletable only after a verified export'); END;
