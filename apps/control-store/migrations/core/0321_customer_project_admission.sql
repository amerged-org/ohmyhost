-- The child recipe keeps the original publication foreign key (171/174). These are production dependency tables;
-- no publication writer or template executor is exposed by this migration.
CREATE UNIQUE INDEX operations_creation_recipe_scope ON operations(organization_id,project_id,operation_id,billing_epoch_id);
CREATE UNIQUE INDEX billing_epochs_creation_recipe_scope ON billing_epochs(billing_epoch_id,project_id,organization_id);

CREATE TABLE managed_source_repositories (
  source_connection_id TEXT PRIMARY KEY CHECK(length(source_connection_id)=26 AND source_connection_id GLOB '[0-7]*' AND source_connection_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, billing_epoch_id TEXT NOT NULL,
  namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 128 AND namespace NOT GLOB '*[^A-Za-z0-9_-]*'),
  repository_name TEXT NOT NULL CHECK(length(repository_name) BETWEEN 1 AND 128 AND repository_name NOT GLOB '*[^A-Za-z0-9_-]*'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(namespace,repository_name), UNIQUE(organization_id,project_id,source_connection_id),
  FOREIGN KEY(billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER managed_source_repositories_no_update BEFORE UPDATE ON managed_source_repositories
BEGIN SELECT RAISE(ABORT,'managed_source_repositories is append-only'); END;
CREATE TRIGGER managed_source_repositories_no_delete BEFORE DELETE ON managed_source_repositories
BEGIN SELECT RAISE(ABORT,'managed_source_repositories is append-only'); END;

CREATE TABLE managed_source_publications (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, billing_epoch_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, source_connection_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('initialize','commit','switch')),
  delegation_grant_id TEXT CHECK(delegation_grant_id IS NULL OR (length(delegation_grant_id)=36 AND substr(delegation_grant_id,9,1)='-' AND substr(delegation_grant_id,14,1)='-' AND substr(delegation_grant_id,19,1)='-' AND substr(delegation_grant_id,24,1)='-' AND length(replace(delegation_grant_id,'-',''))=32 AND replace(delegation_grant_id,'-','') NOT GLOB '*[^0-9a-f]*')), delegation_client_id TEXT, delegation_consent_sha256 TEXT,
  expected_source_connection_id TEXT CHECK(expected_source_connection_id IS NULL OR (length(expected_source_connection_id)=26 AND expected_source_connection_id GLOB '[0-7]*' AND expected_source_connection_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  expected_source_generation INTEGER NOT NULL CHECK(expected_source_generation BETWEEN 0 AND 2147483647),
  expected_managed_commit TEXT CHECK(expected_managed_commit IS NULL OR (length(expected_managed_commit)=40 AND expected_managed_commit NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK(state IN ('staging','sealed','committed','failed')),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 1024),
  manifest_sha256 TEXT CHECK(manifest_sha256 IS NULL OR (length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*')),
  manifest TEXT CHECK(manifest IS NULL OR json_valid(manifest)),
  commit_sha TEXT CHECK(commit_sha IS NULL OR (length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*' AND commit_sha <> '0000000000000000000000000000000000000000')),
  tree_sha TEXT CHECK(tree_sha IS NULL OR (length(tree_sha)=40 AND tree_sha NOT GLOB '*[^0-9a-f]*' AND tree_sha <> '0000000000000000000000000000000000000000')),
  error_code TEXT,
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.??????Z' AND expires_at > created_at),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z'),
  FOREIGN KEY(organization_id,project_id,operation_id,billing_epoch_id) REFERENCES operations(organization_id,project_id,operation_id,billing_epoch_id),
  FOREIGN KEY(organization_id,project_id,source_connection_id) REFERENCES managed_source_repositories(organization_id,project_id,source_connection_id),
  CHECK((manifest IS NULL)=(manifest_sha256 IS NULL)), CHECK((commit_sha IS NULL)=(tree_sha IS NULL)),
  CHECK((delegation_grant_id IS NULL AND delegation_client_id IS NULL AND delegation_consent_sha256 IS NULL)
    OR (delegation_grant_id IS NOT NULL AND delegation_client_id IS NOT NULL AND length(delegation_consent_sha256)=64 AND delegation_consent_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK((state='failed')=(error_code IS NOT NULL)), CHECK(state<>'committed' OR (manifest IS NOT NULL AND commit_sha IS NOT NULL)),
  CHECK((mode='initialize' AND expected_source_connection_id IS NULL AND expected_source_generation=0 AND expected_managed_commit IS NULL)
    OR (mode='switch' AND expected_source_connection_id IS NOT NULL AND expected_source_generation>0 AND expected_managed_commit IS NULL)
    OR (mode='commit' AND expected_source_connection_id=source_connection_id AND expected_source_generation>0 AND expected_managed_commit IS NOT NULL))
) STRICT, WITHOUT ROWID;

-- The managed-source recipe of a customer project (core-v1 only). The original PostgreSQL schema (migration 174) keeps one
-- `managed_source_initializations` row per project that asked for a managed Git template: it is written in the SAME
-- transaction as the project, in state `waiting`, so a template request can never be dropped, and it records the exact
-- creation delegation (grant, client and consent hash) that proves the permission of the original create call.
-- In the shared core the row commits in the same batch as the project, its receipt and its domain claim (see
-- catalog/projects/customer-projects.ts). The row is the RECIPE only: the consumer that turns `waiting` into a template
-- publication (queued, initializing, initialized, failed) is not ported to D1 and writes nothing here yet.
-- Keys follow the core's composite organization scoping; the identity columns are immutable like the original trigger.

CREATE TABLE managed_source_initializations (
  organization_id            TEXT NOT NULL,
  parent_operation_id        TEXT NOT NULL CHECK (length(parent_operation_id) = 26),
  project_id                 TEXT NOT NULL,
  billing_epoch_id           TEXT NOT NULL,
  source_connection_id       TEXT NOT NULL UNIQUE CHECK (length(source_connection_id) = 26 AND source_connection_id GLOB '[0-7]*' AND source_connection_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  initialization_event_id    TEXT NOT NULL UNIQUE CHECK (length(initialization_event_id) = 26 AND initialization_event_id GLOB '[0-7]*' AND initialization_event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  principal_id               TEXT NOT NULL CHECK (principal_id GLOB 'user:*' AND length(principal_id) BETWEEN 6 AND 255 AND substr(principal_id,6) NOT GLOB '*[^A-Za-z0-9_:-]*'),
  template                   TEXT NOT NULL CHECK (template IN ('vite-react', 'empty')),
  region                     TEXT NOT NULL CHECK (region IN ('us', 'eu')),
  request_id                 TEXT NOT NULL,
  state                      TEXT NOT NULL CHECK (state IN ('waiting', 'queued', 'initializing', 'initialized', 'failed')),
  child_operation_id         TEXT UNIQUE REFERENCES managed_source_publications(operation_id),
  delegation_grant_id        TEXT CHECK (delegation_grant_id IS NULL OR (length(delegation_grant_id)=36 AND substr(delegation_grant_id,9,1)='-' AND substr(delegation_grant_id,14,1)='-' AND substr(delegation_grant_id,19,1)='-' AND substr(delegation_grant_id,24,1)='-' AND length(replace(delegation_grant_id,'-',''))=32 AND replace(delegation_grant_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  delegation_client_id       TEXT CHECK (delegation_client_id IS NULL OR length(delegation_client_id) BETWEEN 1 AND 2048),
  delegation_consent_sha256  TEXT CHECK (delegation_consent_sha256 IS NULL
                                         OR (length(delegation_consent_sha256) = 64 AND delegation_consent_sha256 NOT GLOB '*[^0-9a-f]*')),
  error_code                 TEXT,
  created_at                 TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at                 TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, parent_operation_id),
  UNIQUE (parent_operation_id),
  UNIQUE (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id, parent_operation_id, billing_epoch_id) REFERENCES operations (organization_id, project_id, operation_id, billing_epoch_id),
  FOREIGN KEY (billing_epoch_id, project_id, organization_id) REFERENCES billing_epochs (billing_epoch_id, project_id, organization_id),
  FOREIGN KEY (organization_id, delegation_grant_id) REFERENCES mcp_client_grants (organization_id, grant_id),
  CHECK ((delegation_grant_id IS NULL AND delegation_client_id IS NULL AND delegation_consent_sha256 IS NULL)
      OR (delegation_grant_id IS NOT NULL AND delegation_client_id IS NOT NULL AND delegation_consent_sha256 IS NOT NULL)),
  CHECK ((state = 'failed') = (error_code IS NOT NULL)),
  CHECK (state NOT IN ('initializing', 'initialized') OR child_operation_id IS NOT NULL),
  CHECK (updated_at >= created_at)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER managed_source_initialization_identity BEFORE UPDATE ON managed_source_initializations
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.parent_operation_id IS NOT OLD.parent_operation_id
    OR NEW.project_id IS NOT OLD.project_id OR NEW.billing_epoch_id IS NOT OLD.billing_epoch_id
    OR NEW.source_connection_id IS NOT OLD.source_connection_id OR NEW.initialization_event_id IS NOT OLD.initialization_event_id
    OR NEW.principal_id IS NOT OLD.principal_id OR NEW.template IS NOT OLD.template OR NEW.region IS NOT OLD.region
    OR NEW.request_id IS NOT OLD.request_id OR NEW.delegation_grant_id IS NOT OLD.delegation_grant_id
    OR NEW.delegation_client_id IS NOT OLD.delegation_client_id
    OR NEW.delegation_consent_sha256 IS NOT OLD.delegation_consent_sha256 OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.child_operation_id IS NOT NULL AND NEW.child_operation_id IS NOT OLD.child_operation_id)
BEGIN SELECT RAISE(ABORT, 'Managed source initialization identity is immutable'); END;
