-- Complete the latest original deployment/accepted-plan static parent graph (native PG18 catalog at400).
-- This is initial UNSERVED target construction/qualification. No activated authority reopens import or silently
-- re-admits existing historical receipts through current-state predicates. All source fields are copied unchanged.
INSERT INTO guard_fail(code) SELECT 'precondition_changed'
  WHERE EXISTS (SELECT 1 FROM core_authority_activation);

-- FK children are staged and restored in this SAME atomic schema batch. Workerd rejects dropping a RESTRICT parent
-- with children even when INSERT constraints are deferred. The eventual cyclic deployment/revision INSERTs use
-- native deferred validation; no fields become invented NULLs and every FK remains enabled at the final commit.
CREATE TABLE action_confirmations_copy_0336 AS SELECT * FROM action_confirmations;
DROP TABLE action_confirmations;
CREATE TABLE github_push_deployments_copy_0336 AS SELECT * FROM github_push_deployments;
DROP TABLE github_push_deployments;
CREATE TABLE repository_grant_revocations_copy_0336 AS SELECT * FROM repository_grant_revocations;
DROP TABLE repository_grant_revocations;
CREATE TABLE project_source_bindings_copy_0336 AS SELECT * FROM project_source_bindings;
DROP TABLE project_source_bindings;
CREATE TABLE deployment_revisions_copy_0336 AS SELECT * FROM deployment_revisions;
DROP TABLE deployment_revisions;
CREATE TABLE wfp_candidate_cleanup_receipts_copy_0336 AS SELECT * FROM wfp_candidate_cleanup_receipts;
DROP TABLE wfp_candidate_cleanup_receipts;
CREATE TABLE wfp_publish_receipts_copy_0336 AS SELECT * FROM wfp_publish_receipts;
DROP TABLE wfp_publish_receipts;
CREATE TABLE shared_gateway_route_revisions_copy_0336 AS SELECT * FROM shared_gateway_route_revisions;
DROP TABLE shared_gateway_route_revisions;
CREATE TABLE wfp_candidate_receipts_copy_0336 AS SELECT * FROM wfp_candidate_receipts;
DROP TABLE wfp_candidate_receipts;
CREATE TABLE deployments_copy_0336 AS SELECT * FROM deployments;
DROP TABLE deployments;
CREATE TABLE deployment_plans_copy_0336 AS SELECT * FROM deployment_plans;
DROP TABLE deployment_plans;
CREATE TABLE repository_grants_copy_0336 AS SELECT * FROM repository_grants;
DROP TABLE repository_grants;
CREATE TABLE source_connections_copy_0336 AS SELECT * FROM source_connections;
DROP TABLE source_connections;

CREATE TABLE source_connections (
  organization_id TEXT NOT NULL,
  source_connection_id TEXT NOT NULL PRIMARY KEY CHECK (length(source_connection_id)=26 AND source_connection_id GLOB '[0-7]*'
    AND source_connection_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL,
  billing_epoch_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github','managed')),
  external_repository_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,source_connection_id),
  UNIQUE(organization_id,project_id,source_connection_id),
  UNIQUE(organization_id,project_id,source_connection_id,provider),
  UNIQUE(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id),
  FOREIGN KEY (organization_id,project_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,project_id,billing_epoch_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER source_connections_no_update BEFORE UPDATE ON source_connections
BEGIN SELECT RAISE(ABORT,'source connections are append-only'); END;
CREATE TRIGGER source_connections_no_delete BEFORE DELETE ON source_connections
BEGIN SELECT RAISE(ABORT,'source connections are append-only'); END;

CREATE TABLE repository_grants (
  organization_id TEXT NOT NULL,
  grant_id TEXT NOT NULL PRIMARY KEY CHECK (length(grant_id)=26 AND grant_id GLOB '[0-7]*'
    AND grant_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL,
  billing_epoch_id TEXT NOT NULL,
  source_connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  github_installation_id TEXT,
  external_repository_id TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  permission TEXT NOT NULL,
  granted_at TEXT NOT NULL CHECK (granted_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,grant_id),
  UNIQUE(organization_id,project_id,grant_id),
  UNIQUE(organization_id,project_id,source_connection_id),
  FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id)
    REFERENCES source_connections(organization_id,project_id,billing_epoch_id,source_connection_id,external_repository_id),
  CHECK ((provider='github' AND permission='contents:read' AND github_installation_id IS NOT NULL
    AND length(github_installation_id) BETWEEN 1 AND 20 AND substr(github_installation_id,1,1) GLOB '[1-9]'
    AND github_installation_id NOT GLOB '*[^0-9]*' AND length(external_repository_id) BETWEEN 1 AND 16
    AND substr(external_repository_id,1,1) GLOB '[1-9]' AND external_repository_id NOT GLOB '*[^0-9]*'
    AND length(repository_owner) BETWEEN 1 AND 39 AND substr(repository_owner,1,1) GLOB '[A-Za-z0-9]'
    AND substr(repository_owner,-1) GLOB '[A-Za-z0-9]' AND repository_owner NOT GLOB '*[^A-Za-z0-9-]*'
    AND repository_name=trim(repository_name) AND length(repository_name) BETWEEN 1 AND 100)
   OR (provider='managed' AND permission='contents:read' AND github_installation_id IS NULL
    AND length(repository_owner) BETWEEN 1 AND 128 AND repository_owner NOT GLOB '*[^A-Za-z0-9_-]*'
    AND length(repository_name) BETWEEN 1 AND 128 AND repository_name NOT GLOB '*[^A-Za-z0-9_-]*'
    AND external_repository_id=repository_owner||'/'||repository_name))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER repository_grants_no_update BEFORE UPDATE ON repository_grants
BEGIN SELECT RAISE(ABORT,'repository grants are append-only'); END;
CREATE TRIGGER repository_grants_no_delete BEFORE DELETE ON repository_grants
BEGIN SELECT RAISE(ABORT,'repository grants are append-only'); END;

CREATE TABLE deployment_plans (
  organization_id TEXT NOT NULL,
  plan_id TEXT NOT NULL PRIMARY KEY CHECK (length(plan_id)=26 AND plan_id GLOB '[0-7]*'
    AND plan_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL,
  source_connection_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL CHECK (length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  source_sha256 BLOB NOT NULL CHECK (length(source_sha256)=32),
  build_plan_sha256 BLOB NOT NULL CHECK (length(build_plan_sha256)=32),
  runtime TEXT NOT NULL CHECK (runtime=trim(runtime) AND length(runtime) BETWEEN 1 AND 64),
  impacts TEXT NOT NULL CHECK (json_valid(impacts) AND json_type(impacts)='array'),
  risks TEXT NOT NULL CHECK (json_valid(risks) AND json_type(risks)='array'),
  cost_estimate TEXT NOT NULL CHECK (json_valid(cost_estimate) AND json_type(cost_estimate)='object'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z'),
  plan_sha256 BLOB NOT NULL CHECK (length(plan_sha256)=32),
  framework_plan TEXT CHECK (framework_plan IS NULL OR (json_valid(framework_plan) AND json_type(framework_plan)='object')),
  environment_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1 CHECK (source_generation BETWEEN 1 AND 2147483647),
  UNIQUE(organization_id,plan_id),
  UNIQUE(organization_id,project_id,plan_id),
  FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,source_connection_id) REFERENCES repository_grants(organization_id,project_id,source_connection_id) ON DELETE RESTRICT,
  CHECK (expires_at>created_at AND expires_at<=strftime('%Y-%m-%dT%H:%M:%S',created_at,'+24 hours')||substr(created_at,20))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER deployment_plans_no_update BEFORE UPDATE ON deployment_plans
BEGIN SELECT RAISE(ABORT, 'deployment_plans is append-only'); END;
CREATE TRIGGER deployment_plans_no_delete BEFORE DELETE ON deployment_plans
BEGIN SELECT RAISE(ABORT, 'deployment_plans is append-only'); END;

CREATE TABLE deployments (
  organization_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL PRIMARY KEY CHECK (length(deployment_id)=26 AND deployment_id GLOB '[0-7]*'
    AND deployment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'deploy' CHECK (kind IN ('deploy','promotion','rollback')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','reconciliation_required')),
  active_revision_id TEXT,
  active_version INTEGER NOT NULL DEFAULT 0 CHECK (active_version BETWEEN 0 AND 2147483647),
  rollback_target_deployment_id TEXT,
  rollback_target_revision_id TEXT,
  promotion_source_environment_id TEXT,
  promotion_source_deployment_id TEXT,
  promotion_source_revision_id TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,deployment_id),
  UNIQUE(organization_id,project_id,deployment_id),
  UNIQUE(organization_id,project_id,operation_id,deployment_id),
  UNIQUE(organization_id,project_id,environment_id,deployment_id),
  FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,environment_id) REFERENCES environment_identities(project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,deployment_id,active_revision_id)
    REFERENCES deployment_revisions(organization_id,project_id,deployment_id,revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,rollback_target_deployment_id,rollback_target_revision_id)
    REFERENCES deployment_revisions(organization_id,project_id,deployment_id,revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,promotion_source_environment_id)
    REFERENCES environments(organization_id,project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,promotion_source_deployment_id,promotion_source_revision_id)
    REFERENCES deployment_revisions(organization_id,project_id,deployment_id,revision_id) ON DELETE RESTRICT,
  CHECK (updated_at>=created_at AND ((active_version=0 AND active_revision_id IS NULL)
    OR (active_version>0 AND active_revision_id IS NOT NULL))),
  CHECK ((kind='deploy' AND rollback_target_deployment_id IS NULL AND rollback_target_revision_id IS NULL
      AND promotion_source_environment_id IS NULL AND promotion_source_deployment_id IS NULL AND promotion_source_revision_id IS NULL)
    OR (kind='rollback' AND rollback_target_deployment_id IS NOT NULL AND rollback_target_revision_id IS NOT NULL
      AND promotion_source_environment_id IS NULL AND promotion_source_deployment_id IS NULL AND promotion_source_revision_id IS NULL)
    OR (kind='promotion' AND rollback_target_deployment_id IS NULL AND rollback_target_revision_id IS NULL
      AND promotion_source_environment_id IS NOT NULL AND promotion_source_deployment_id IS NOT NULL AND promotion_source_revision_id IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX deployments_by_environment ON deployments (organization_id, project_id, environment_id, created_at DESC, deployment_id DESC);

CREATE TABLE deployment_revisions (
  organization_id TEXT NOT NULL,
  revision_id TEXT NOT NULL PRIMARY KEY CHECK (length(revision_id)=26 AND revision_id GLOB '[0-7]*'
    AND revision_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES deployment_plans(plan_id) ON DELETE RESTRICT,
  build_execution_id TEXT NOT NULL REFERENCES build_executions(build_execution_id) ON DELETE RESTRICT,
  artifact_id TEXT NOT NULL REFERENCES build_artifacts(artifact_id) ON DELETE RESTRICT,
  wfp_receipt_id TEXT NOT NULL REFERENCES wfp_publish_receipts(wfp_receipt_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,revision_id),
  UNIQUE(organization_id,project_id,deployment_id,revision_id),
  FOREIGN KEY (organization_id,project_id,operation_id,deployment_id)
    REFERENCES deployments(organization_id,project_id,operation_id,deployment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,plan_id) REFERENCES deployment_plans(organization_id,project_id,plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,build_execution_id) REFERENCES build_executions(organization_id,project_id,build_execution_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,artifact_id) REFERENCES build_artifacts(organization_id,project_id,artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,wfp_receipt_id) REFERENCES wfp_publish_receipts(organization_id,project_id,wfp_receipt_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX deployment_revisions_by_deployment ON deployment_revisions (organization_id, deployment_id, revision_id);
CREATE TRIGGER deployment_revisions_no_update BEFORE UPDATE ON deployment_revisions
BEGIN SELECT RAISE(ABORT,'deployment revisions are append-only'); END;
CREATE TRIGGER deployment_revisions_no_delete BEFORE DELETE ON deployment_revisions
BEGIN SELECT RAISE(ABORT,'deployment revisions are append-only'); END;

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
  FOREIGN KEY (inbox_event_id) REFERENCES webhook_inbox (inbox_event_id),
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

CREATE TABLE wfp_candidate_receipts (
  candidate_receipt_id TEXT NOT NULL PRIMARY KEY CHECK (length(candidate_receipt_id)=26 AND candidate_receipt_id GLOB '[0-7]*'
    AND candidate_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  product_deployment_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  dispatch_namespace TEXT NOT NULL CHECK (length(dispatch_namespace) BETWEEN 1 AND 64),
  immutable_script_name TEXT NOT NULL CHECK (
    substr(immutable_script_name,1,2)='p-'
    AND substr(immutable_script_name,3,26) NOT GLOB '*[^0-9a-z]*'
    AND ((length(immutable_script_name)=59 AND substr(immutable_script_name,29,5)='-dev-')
      OR (length(immutable_script_name)=60 AND substr(immutable_script_name,29,6)='-prod-'))
    AND substr(immutable_script_name,-26) NOT GLOB '*[^0-9a-z]*'),
  artifact_sha256 BLOB NOT NULL CHECK (length(artifact_sha256)=32),
  provider_tag TEXT NOT NULL CHECK (provider_tag=trim(provider_tag) AND length(provider_tag) BETWEEN 1 AND 255),
  build_reused INTEGER NOT NULL CHECK (build_reused IN (0,1)),
  staged_at TEXT NOT NULL CHECK (staged_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,project_id,candidate_receipt_id),
  UNIQUE(organization_id,project_id,candidate_receipt_id,operation_id),
  UNIQUE(organization_id,project_id,environment_id,candidate_receipt_id,operation_id,product_deployment_id),
  UNIQUE(organization_id,project_id,environment_id,candidate_receipt_id,product_deployment_id),
  UNIQUE(organization_id,project_id,product_deployment_id),
  UNIQUE(dispatch_namespace,immutable_script_name,provider_tag),
  FOREIGN KEY (organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,environment_id) REFERENCES environment_identities(project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,operation_id,product_deployment_id) REFERENCES deployments(organization_id,project_id,operation_id,deployment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,artifact_id) REFERENCES build_artifacts(organization_id,project_id,artifact_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX wfp_candidate_receipts_script_idx ON wfp_candidate_receipts(immutable_script_name);

CREATE TRIGGER wfp_candidate_receipts_no_update BEFORE UPDATE ON wfp_candidate_receipts
BEGIN SELECT RAISE(ABORT,'WFP candidate receipts are append-only'); END;

CREATE TRIGGER wfp_candidate_receipts_no_delete BEFORE DELETE ON wfp_candidate_receipts
BEGIN SELECT RAISE(ABORT,'WFP candidate receipts are append-only'); END;

CREATE TABLE shared_gateway_route_revisions (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision>0),
  predecessor_revision INTEGER,
  operation_id TEXT NOT NULL,
  candidate_receipt_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('activate','remove','compensate')),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  handle TEXT NOT NULL,
  public_origin TEXT NOT NULL CHECK (substr(public_origin,1,8)='https://' AND length(public_origin)>8
    AND substr(public_origin,9) NOT GLOB '*[^a-z0-9.-]*'),
  egress_allowed_origins TEXT NOT NULL CHECK (json_valid(egress_allowed_origins)
    AND json_type(egress_allowed_origins)='array' AND json_array_length(egress_allowed_origins)<=16),
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
    CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  browser_policy TEXT CHECK (browser_policy IS NULL OR json_valid(browser_policy)),
  PRIMARY KEY(organization_id,project_id,environment_id,revision),
  UNIQUE(organization_id,project_id,environment_id,operation_id,action),
  FOREIGN KEY (organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id),
  FOREIGN KEY (project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
  FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
  FOREIGN KEY (organization_id,project_id,candidate_receipt_id) REFERENCES wfp_candidate_receipts(organization_id,project_id,candidate_receipt_id),
  FOREIGN KEY (organization_id,project_id,environment_id,predecessor_revision)
    REFERENCES shared_gateway_route_revisions(organization_id,project_id,environment_id,revision),
  CHECK (predecessor_revision IS NULL OR predecessor_revision<revision),
  CHECK (predecessor_revision IS NOT NULL OR revision=1 OR action='activate'),
  CHECK (action<>'remove' OR active=0)
) STRICT, WITHOUT ROWID;

CREATE INDEX shared_gateway_routes_origin_idx ON shared_gateway_route_revisions(public_origin);

CREATE TRIGGER shared_gateway_route_revisions_no_update BEFORE UPDATE ON shared_gateway_route_revisions
BEGIN SELECT RAISE(ABORT,'shared gateway revisions are append-only'); END;

CREATE TRIGGER shared_gateway_route_revisions_no_delete BEFORE DELETE ON shared_gateway_route_revisions
BEGIN SELECT RAISE(ABORT,'shared gateway revisions are append-only'); END;

CREATE TABLE wfp_publish_receipts (
  wfp_receipt_id TEXT NOT NULL PRIMARY KEY CHECK (length(wfp_receipt_id)=26 AND wfp_receipt_id GLOB '[0-7]*'
    AND wfp_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES build_artifacts(artifact_id) ON DELETE RESTRICT,
  dispatch_namespace TEXT NOT NULL CHECK (length(dispatch_namespace) BETWEEN 1 AND 64),
  script_name TEXT NOT NULL CHECK (length(script_name) BETWEEN 1 AND 255),
  provider_version_id TEXT NOT NULL CHECK (length(provider_version_id) BETWEEN 1 AND 255),
  deployment_url TEXT NOT NULL CHECK (substr(deployment_url,1,8)='https://'),
  published_at TEXT NOT NULL CHECK (published_at GLOB '????-??-??T??:??:??.??????Z'),
  environment_id TEXT NOT NULL,
  gateway_contract_version TEXT,
  gateway_script_name TEXT,
  gateway_target_script_name TEXT,
  gateway_workers_dev_subdomain TEXT,
  gateway_provider_tag BLOB,
  gateway_module_sha256 BLOB,
  gateway_public_origin TEXT,
  gateway_compatibility_date TEXT,
  gateway_observed_at TEXT CHECK (gateway_observed_at IS NULL OR gateway_observed_at GLOB '????-??-??T??:??:??.??????Z'),
  gateway_egress_policy_sha256 BLOB,
  gateway_dev_access_service TEXT,
  gateway_dev_access_entrypoint TEXT,
  gateway_dev_access_key_id BLOB,
  gateway_dev_access_public_key_sha256 BLOB,
  candidate_receipt_id TEXT NOT NULL UNIQUE,
  product_deployment_id TEXT NOT NULL,
  gateway_version_id TEXT,
  gateway_deployment_id TEXT,
  gateway_internal_origin TEXT,
  shared_gateway_revision INTEGER,
  UNIQUE(organization_id,project_id,wfp_receipt_id),
  FOREIGN KEY (organization_id,project_id,artifact_id) REFERENCES build_artifacts(organization_id,project_id,artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,candidate_receipt_id) REFERENCES wfp_candidate_receipts(organization_id,project_id,candidate_receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,environment_id) REFERENCES environment_identities(project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,product_deployment_id) REFERENCES deployments(organization_id,project_id,deployment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,environment_id,shared_gateway_revision)
    REFERENCES shared_gateway_route_revisions(organization_id,project_id,environment_id,revision)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER wfp_publish_receipts_no_update BEFORE UPDATE ON wfp_publish_receipts
BEGIN SELECT RAISE(ABORT,'WFP publish receipts are append-only'); END;

CREATE TRIGGER wfp_publish_receipts_no_delete BEFORE DELETE ON wfp_publish_receipts
BEGIN SELECT RAISE(ABORT,'WFP publish receipts are append-only'); END;

CREATE TABLE wfp_candidate_cleanup_receipts (
  cleanup_receipt_id TEXT NOT NULL PRIMARY KEY CHECK (length(cleanup_receipt_id)=26 AND cleanup_receipt_id GLOB '[0-7]*'
    AND cleanup_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  candidate_receipt_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  compensated_target_script_name TEXT,
  gateway_version_id TEXT,
  gateway_deployment_id TEXT,
  observed_provider_tag TEXT NOT NULL,
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  environment_id TEXT,
  shared_gateway_revision INTEGER,
  FOREIGN KEY (organization_id,project_id,candidate_receipt_id) REFERENCES wfp_candidate_receipts(organization_id,project_id,candidate_receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,environment_id,shared_gateway_revision)
    REFERENCES shared_gateway_route_revisions(organization_id,project_id,environment_id,revision)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER wfp_candidate_cleanup_receipts_no_update BEFORE UPDATE ON wfp_candidate_cleanup_receipts
BEGIN SELECT RAISE(ABORT,'WFP cleanup receipts are append-only'); END;

CREATE TRIGGER wfp_candidate_cleanup_receipts_no_delete BEFORE DELETE ON wfp_candidate_cleanup_receipts
BEGIN SELECT RAISE(ABORT,'WFP cleanup receipts are append-only'); END;

-- The original 062 identity guard and organization-scoped environment FK are static and NEVER bypassed during import.
-- Unlike the main deployment/publication environment FK, original062/143 retain organization in this relationship.
CREATE TRIGGER wfp_candidate_receipts_exact_identity BEFORE INSERT ON wfp_candidate_receipts
BEGIN
  SELECT RAISE(ABORT,'WFP candidate requires the exact scoped deployment, artifact and environment identity')
  WHERE NOT EXISTS (
    SELECT 1 FROM environments e
      JOIN build_artifacts a ON a.organization_id=e.organization_id AND a.project_id=e.project_id AND a.artifact_id=NEW.artifact_id
      JOIN deployments d ON d.organization_id=e.organization_id AND d.project_id=e.project_id AND d.deployment_id=NEW.product_deployment_id
    WHERE e.organization_id=NEW.organization_id AND e.project_id=NEW.project_id AND e.environment_id=NEW.environment_id
      AND d.operation_id=NEW.operation_id AND a.artifact_sha256=NEW.artifact_sha256
      AND NEW.immutable_script_name='p-'||lower(NEW.project_id)||'-'||e.name||'-'||lower(NEW.product_deployment_id));

END;

-- Exact final-144 cleanup row shape, including legacy gateway fields. SQL NULL CHECK semantics are retained.
CREATE TRIGGER wfp_candidate_cleanup_receipts_shape BEFORE INSERT ON wfp_candidate_cleanup_receipts
WHEN NOT (
  (NEW.shared_gateway_revision IS NULL AND (
    NEW.outcome IN ('removed','not_found') AND NEW.observed_provider_tag=trim(NEW.observed_provider_tag)
    AND length(NEW.observed_provider_tag) BETWEEN 1 AND 255
    AND ((NEW.compensated_target_script_name IS NULL AND NEW.gateway_version_id IS NULL AND NEW.gateway_deployment_id IS NULL)
      OR (substr(NEW.compensated_target_script_name,1,2)='p-'
        AND substr(NEW.compensated_target_script_name,3,26) NOT GLOB '*[^0-9a-z]*'
        AND ((length(NEW.compensated_target_script_name)=59 AND substr(NEW.compensated_target_script_name,29,5)='-dev-')
          OR (length(NEW.compensated_target_script_name)=60 AND substr(NEW.compensated_target_script_name,29,6)='-prod-'))
        AND substr(NEW.compensated_target_script_name,-26) NOT GLOB '*[^0-9a-z]*'
        AND NEW.gateway_version_id=trim(NEW.gateway_version_id) AND length(NEW.gateway_version_id) BETWEEN 1 AND 255
        AND NEW.gateway_deployment_id=trim(NEW.gateway_deployment_id) AND length(NEW.gateway_deployment_id) BETWEEN 1 AND 255))))
  OR (NEW.shared_gateway_revision IS NOT NULL AND (
    (NEW.gateway_version_id IS NULL AND NEW.gateway_deployment_id IS NULL)
    OR (NEW.outcome IN ('removed','not_found') AND NEW.observed_provider_tag=trim(NEW.observed_provider_tag)
      AND length(NEW.observed_provider_tag) BETWEEN 1 AND 255
      AND ((NEW.compensated_target_script_name IS NULL AND NEW.gateway_version_id IS NULL AND NEW.gateway_deployment_id IS NULL)
        OR (substr(NEW.compensated_target_script_name,1,2)='p-'
          AND substr(NEW.compensated_target_script_name,3,26) NOT GLOB '*[^0-9a-z]*'
          AND ((length(NEW.compensated_target_script_name)=59 AND substr(NEW.compensated_target_script_name,29,5)='-dev-')
            OR (length(NEW.compensated_target_script_name)=60 AND substr(NEW.compensated_target_script_name,29,6)='-prod-'))
          AND substr(NEW.compensated_target_script_name,-26) NOT GLOB '*[^0-9a-z]*'
          AND NEW.gateway_version_id=trim(NEW.gateway_version_id) AND length(NEW.gateway_version_id) BETWEEN 1 AND 255
          AND NEW.gateway_deployment_id=trim(NEW.gateway_deployment_id) AND length(NEW.gateway_deployment_id) BETWEEN 1 AND 255)))))
)
BEGIN SELECT RAISE(ABORT,'WFP cleanup receipt shape'); END;

CREATE TRIGGER wfp_publish_receipts_exact_identity BEFORE INSERT ON wfp_publish_receipts
BEGIN
  SELECT RAISE(ABORT,'WFP publication requires its exact immutable candidate and uncleaned target')
  WHERE NOT EXISTS (
    SELECT 1 FROM wfp_candidate_receipts c WHERE c.candidate_receipt_id=NEW.candidate_receipt_id
      AND c.organization_id=NEW.organization_id AND c.project_id=NEW.project_id
      AND c.product_deployment_id=NEW.product_deployment_id AND c.environment_id=NEW.environment_id
      AND c.artifact_id=NEW.artifact_id AND c.dispatch_namespace=NEW.dispatch_namespace
      AND c.immutable_script_name=NEW.script_name AND c.provider_tag=NEW.provider_version_id
      AND c.staged_at<=NEW.published_at)
    OR EXISTS (SELECT 1 FROM wfp_candidate_cleanup_receipts WHERE candidate_receipt_id=NEW.candidate_receipt_id);
  SELECT RAISE(ABORT,'WFP publication requires the exact static shared-route receipt')
  WHERE NEW.shared_gateway_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM shared_gateway_route_revisions r JOIN wfp_candidate_receipts c
      ON c.organization_id=r.organization_id AND c.project_id=r.project_id AND c.candidate_receipt_id=r.candidate_receipt_id
    WHERE r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id AND r.environment_id=NEW.environment_id
      AND r.revision=NEW.shared_gateway_revision AND r.candidate_receipt_id=NEW.candidate_receipt_id
      AND r.active=1 AND r.operation_id=c.operation_id AND NEW.deployment_url=r.public_origin);
  SELECT RAISE(ABORT,'new WFP publication requires the exact active current route, project and domain')
  WHERE NOT EXISTS (
    SELECT 1 FROM core_historical_import i JOIN json_each(i.temporal_tables) t
    WHERE i.closed_at IS NULL AND t.value='wfp_publish_receipts' AND NOT EXISTS (SELECT 1 FROM core_authority_activation))
    AND NOT EXISTS (
      SELECT 1 FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id
        JOIN cloudflare_project_domains d ON d.organization_id=e.organization_id AND d.project_id=e.project_id
        JOIN shared_gateway_route_revisions r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.environment_id=e.environment_id
        JOIN wfp_candidate_receipts c ON c.organization_id=r.organization_id AND c.project_id=r.project_id AND c.candidate_receipt_id=r.candidate_receipt_id
      WHERE e.organization_id=NEW.organization_id AND e.project_id=NEW.project_id AND e.environment_id=NEW.environment_id
        AND p.lifecycle_state='active' AND d.deleted_at IS NULL AND d.handle=p.handle
        AND r.revision=NEW.shared_gateway_revision AND r.active=1 AND r.candidate_receipt_id=NEW.candidate_receipt_id
        AND r.public_origin='https://'||CASE e.name WHEN 'dev' THEN d.development_domain WHEN 'prod' THEN d.production_domain END
        AND r.handle=p.handle AND c.environment_id=e.environment_id
        AND CASE WHEN d.production_domain=p.handle||'.check.omh.st' THEN c.dispatch_namespace='ohmyho-production'
          ELSE c.dispatch_namespace IN ('sandbox','ohmyho-sandbox','ohmyho-poc-private-fullstack') END
        AND NOT EXISTS (SELECT 1 FROM shared_gateway_route_revisions n WHERE n.organization_id=r.organization_id
          AND n.project_id=r.project_id AND n.environment_id=r.environment_id AND n.revision>r.revision));
END;

CREATE TRIGGER wfp_candidate_cleanup_receipts_exact_identity BEFORE INSERT ON wfp_candidate_cleanup_receipts
BEGIN
  SELECT RAISE(ABORT,'published WFP candidate cannot be cleaned')
    WHERE EXISTS (SELECT 1 FROM wfp_publish_receipts WHERE candidate_receipt_id=NEW.candidate_receipt_id);
  SELECT RAISE(ABORT,'WFP cleanup requires the exact scoped candidate and observed provider tag')
  WHERE NOT EXISTS (
    SELECT 1 FROM wfp_candidate_receipts c WHERE c.organization_id=NEW.organization_id AND c.project_id=NEW.project_id
      AND c.candidate_receipt_id=NEW.candidate_receipt_id AND c.provider_tag=NEW.observed_provider_tag
      AND (NEW.environment_id IS NULL OR c.environment_id=NEW.environment_id) AND NEW.outcome IN ('removed','not_found'));
  SELECT RAISE(ABORT,'WFP compensation requires its exact static restored candidate')
  WHERE NEW.shared_gateway_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM shared_gateway_route_revisions r JOIN wfp_candidate_receipts c
      ON c.organization_id=r.organization_id AND c.project_id=r.project_id AND c.candidate_receipt_id=r.candidate_receipt_id
    WHERE r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id AND r.environment_id=NEW.environment_id
      AND r.revision=NEW.shared_gateway_revision AND r.active=1 AND c.environment_id=r.environment_id
      AND r.candidate_receipt_id<>NEW.candidate_receipt_id AND c.immutable_script_name=NEW.compensated_target_script_name
      AND NOT EXISTS (SELECT 1 FROM wfp_candidate_cleanup_receipts WHERE candidate_receipt_id=c.candidate_receipt_id));
  SELECT RAISE(ABORT,'new WFP cleanup requires exact current shared-gateway evidence')
  WHERE NOT EXISTS (
    SELECT 1 FROM core_historical_import i JOIN json_each(i.temporal_tables) t
    WHERE i.closed_at IS NULL AND t.value='wfp_candidate_cleanup_receipts' AND NOT EXISTS (SELECT 1 FROM core_authority_activation))
    AND (NEW.environment_id IS NULL OR NEW.gateway_version_id IS NOT NULL OR NEW.gateway_deployment_id IS NOT NULL
      OR (NEW.shared_gateway_revision IS NULL AND (NEW.compensated_target_script_name IS NOT NULL OR EXISTS (
        SELECT 1 FROM shared_gateway_route_revisions r WHERE r.organization_id=NEW.organization_id
          AND r.project_id=NEW.project_id AND r.environment_id=NEW.environment_id AND r.active=1
          AND NOT EXISTS (SELECT 1 FROM shared_gateway_route_revisions n WHERE n.organization_id=r.organization_id
            AND n.project_id=r.project_id AND n.environment_id=r.environment_id AND n.revision>r.revision))))
      OR (NEW.shared_gateway_revision IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id
          JOIN cloudflare_project_domains d ON d.organization_id=e.organization_id AND d.project_id=e.project_id
          JOIN shared_gateway_route_revisions r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.environment_id=e.environment_id
          JOIN wfp_candidate_receipts c ON c.organization_id=r.organization_id AND c.project_id=r.project_id AND c.candidate_receipt_id=r.candidate_receipt_id
        WHERE e.organization_id=NEW.organization_id AND e.project_id=NEW.project_id AND e.environment_id=NEW.environment_id
          AND p.lifecycle_state='active' AND d.deleted_at IS NULL AND d.handle=p.handle
          AND r.revision=NEW.shared_gateway_revision AND r.active=1
          AND r.public_origin='https://'||CASE e.name WHEN 'dev' THEN d.development_domain WHEN 'prod' THEN d.production_domain END
          AND r.handle=p.handle AND c.environment_id=e.environment_id
          AND CASE WHEN d.production_domain=p.handle||'.check.omh.st' THEN c.dispatch_namespace='ohmyho-production'
            ELSE c.dispatch_namespace IN ('sandbox','ohmyho-sandbox','ohmyho-poc-private-fullstack') END
          AND NOT EXISTS (SELECT 1 FROM shared_gateway_route_revisions n WHERE n.organization_id=r.organization_id
            AND n.project_id=r.project_id AND n.environment_id=r.environment_id AND n.revision>r.revision))));
END;

-- Final144 legacy receipt shape is retained even though new publication requires the shared protocol. The script
-- grammar is already an unconditional candidate/receipt identity invariant above. NULL CHECK semantics are preserved.
CREATE TRIGGER wfp_publish_receipts_legacy_shape BEFORE INSERT ON wfp_publish_receipts
WHEN NOT ((NEW.shared_gateway_revision IS NULL AND (NEW.gateway_script_name IS NOT NULL AND NEW.gateway_target_script_name IS NOT NULL
AND NEW.gateway_workers_dev_subdomain IS NOT NULL AND NEW.gateway_provider_tag IS NOT NULL
AND NEW.gateway_module_sha256 IS NOT NULL AND NEW.gateway_egress_policy_sha256 IS NOT NULL
AND NEW.gateway_public_origin IS NOT NULL AND NEW.gateway_compatibility_date IS NOT NULL
AND NEW.gateway_observed_at IS NOT NULL AND NEW.gateway_target_script_name=NEW.script_name
AND (length(NEW.gateway_workers_dev_subdomain) BETWEEN 1 AND 63 AND substr(NEW.gateway_workers_dev_subdomain,1,1) GLOB '[a-z0-9]' AND substr(NEW.gateway_workers_dev_subdomain,-1) GLOB '[a-z0-9]' AND NEW.gateway_workers_dev_subdomain NOT GLOB '*[^a-z0-9-]*')
AND length(NEW.gateway_provider_tag)=32 AND length(NEW.gateway_module_sha256)=32
AND length(NEW.gateway_egress_policy_sha256)=32
AND (NEW.gateway_dev_access_service IS NULL OR (length(NEW.gateway_dev_access_service) BETWEEN 1 AND 63 AND substr(NEW.gateway_dev_access_service,1,1) GLOB '[a-z0-9]' AND substr(NEW.gateway_dev_access_service,-1) GLOB '[a-z0-9]' AND NEW.gateway_dev_access_service NOT GLOB '*[^a-z0-9-]*'))
AND (NEW.gateway_dev_access_entrypoint IS NULL OR NEW.gateway_dev_access_entrypoint='DevAccessService')
AND (NEW.gateway_dev_access_key_id IS NULL OR length(NEW.gateway_dev_access_key_id)=32)
AND (NEW.gateway_dev_access_public_key_sha256 IS NULL OR length(NEW.gateway_dev_access_public_key_sha256)=32)
AND NEW.deployment_url=NEW.gateway_public_origin
AND NEW.gateway_compatibility_date>='2024-09-23' AND date(NEW.gateway_compatibility_date)=NEW.gateway_compatibility_date
AND NEW.gateway_version_id=trim(NEW.gateway_version_id) AND length(NEW.gateway_version_id) BETWEEN 1 AND 255
AND NEW.gateway_deployment_id=trim(NEW.gateway_deployment_id) AND length(NEW.gateway_deployment_id) BETWEEN 1 AND 255
AND ((NEW.gateway_contract_version='ohmyhost.project-gateway/v6' AND NEW.gateway_internal_origin IS NULL
  AND NEW.gateway_public_origin='https://'||NEW.gateway_script_name||'.'||NEW.gateway_workers_dev_subdomain||'.workers.dev')
 OR (NEW.gateway_contract_version='ohmyhost.project-gateway/v7'
  AND NEW.gateway_internal_origin='https://'||NEW.gateway_script_name||'.'||NEW.gateway_workers_dev_subdomain||'.workers.dev'
  AND (NEW.gateway_public_origin='https://'||NEW.gateway_script_name||'.poc.aixyte.com'
    OR (substr(NEW.gateway_public_origin,1,8)='https://' AND NEW.gateway_public_origin GLOB '*[.]check[.]omh[.]st'))))))
  OR (NEW.shared_gateway_revision IS NOT NULL AND ((NEW.gateway_contract_version IS NULL AND NEW.gateway_script_name IS NULL AND NEW.gateway_target_script_name IS NULL AND NEW.gateway_workers_dev_subdomain IS NULL AND NEW.gateway_provider_tag IS NULL AND NEW.gateway_module_sha256 IS NULL AND NEW.gateway_public_origin IS NULL AND NEW.gateway_compatibility_date IS NULL AND NEW.gateway_observed_at IS NULL AND NEW.gateway_egress_policy_sha256 IS NULL AND NEW.gateway_dev_access_service IS NULL AND NEW.gateway_dev_access_entrypoint IS NULL AND NEW.gateway_dev_access_key_id IS NULL AND NEW.gateway_dev_access_public_key_sha256 IS NULL AND NEW.gateway_version_id IS NULL AND NEW.gateway_deployment_id IS NULL AND NEW.gateway_internal_origin IS NULL) OR (NEW.gateway_script_name IS NOT NULL AND NEW.gateway_target_script_name IS NOT NULL
AND NEW.gateway_workers_dev_subdomain IS NOT NULL AND NEW.gateway_provider_tag IS NOT NULL
AND NEW.gateway_module_sha256 IS NOT NULL AND NEW.gateway_egress_policy_sha256 IS NOT NULL
AND NEW.gateway_public_origin IS NOT NULL AND NEW.gateway_compatibility_date IS NOT NULL
AND NEW.gateway_observed_at IS NOT NULL AND NEW.gateway_target_script_name=NEW.script_name
AND (length(NEW.gateway_workers_dev_subdomain) BETWEEN 1 AND 63 AND substr(NEW.gateway_workers_dev_subdomain,1,1) GLOB '[a-z0-9]' AND substr(NEW.gateway_workers_dev_subdomain,-1) GLOB '[a-z0-9]' AND NEW.gateway_workers_dev_subdomain NOT GLOB '*[^a-z0-9-]*')
AND length(NEW.gateway_provider_tag)=32 AND length(NEW.gateway_module_sha256)=32
AND length(NEW.gateway_egress_policy_sha256)=32
AND (NEW.gateway_dev_access_service IS NULL OR (length(NEW.gateway_dev_access_service) BETWEEN 1 AND 63 AND substr(NEW.gateway_dev_access_service,1,1) GLOB '[a-z0-9]' AND substr(NEW.gateway_dev_access_service,-1) GLOB '[a-z0-9]' AND NEW.gateway_dev_access_service NOT GLOB '*[^a-z0-9-]*'))
AND (NEW.gateway_dev_access_entrypoint IS NULL OR NEW.gateway_dev_access_entrypoint='DevAccessService')
AND (NEW.gateway_dev_access_key_id IS NULL OR length(NEW.gateway_dev_access_key_id)=32)
AND (NEW.gateway_dev_access_public_key_sha256 IS NULL OR length(NEW.gateway_dev_access_public_key_sha256)=32)
AND NEW.deployment_url=NEW.gateway_public_origin
AND NEW.gateway_compatibility_date>='2024-09-23' AND date(NEW.gateway_compatibility_date)=NEW.gateway_compatibility_date
AND NEW.gateway_version_id=trim(NEW.gateway_version_id) AND length(NEW.gateway_version_id) BETWEEN 1 AND 255
AND NEW.gateway_deployment_id=trim(NEW.gateway_deployment_id) AND length(NEW.gateway_deployment_id) BETWEEN 1 AND 255
AND ((NEW.gateway_contract_version='ohmyhost.project-gateway/v6' AND NEW.gateway_internal_origin IS NULL
  AND NEW.gateway_public_origin='https://'||NEW.gateway_script_name||'.'||NEW.gateway_workers_dev_subdomain||'.workers.dev')
 OR (NEW.gateway_contract_version='ohmyhost.project-gateway/v7'
  AND NEW.gateway_internal_origin='https://'||NEW.gateway_script_name||'.'||NEW.gateway_workers_dev_subdomain||'.workers.dev'
  AND (NEW.gateway_public_origin='https://'||NEW.gateway_script_name||'.poc.aixyte.com'
    OR (substr(NEW.gateway_public_origin,1,8)='https://' AND NEW.gateway_public_origin GLOB '*[.]check[.]omh[.]st'))))))))
BEGIN SELECT RAISE(ABORT,'WFP legacy gateway receipt shape'); END;

-- The v7 legacy public-origin regular expression, compiled to SQLite's exact ASCII predicates. This checks the
-- whole handle, including optional dev- prefix / .dev zone and the original at-most-five handle words.
CREATE TRIGGER wfp_publish_receipts_legacy_v7_origin BEFORE INSERT ON wfp_publish_receipts
WHEN NEW.gateway_contract_version='ohmyhost.project-gateway/v7'
  AND NEW.gateway_public_origin IS NOT NULL
  AND NEW.gateway_public_origin<>'https://'||NEW.gateway_script_name||'.poc.aixyte.com'
BEGIN
  SELECT RAISE(ABORT,'WFP legacy v7 public origin shape') WHERE NOT (
    WITH authority AS (SELECT substr(NEW.gateway_public_origin,9) AS value),
    handles AS (SELECT CASE WHEN value GLOB '*[.]dev[.]check[.]omh[.]st' THEN substr(value,1,length(value)-17)
      WHEN value GLOB '*[.]check[.]omh[.]st' THEN substr(value,1,length(value)-13) END AS value FROM authority),
    words AS (SELECT CASE WHEN substr(value,1,4)='dev-' THEN substr(value,5) ELSE value END AS value FROM handles)
    SELECT substr(NEW.gateway_public_origin,1,8)='https://' AND value IS NOT NULL AND length(value)>0
      AND substr(value,1,1) GLOB '[a-z0-9]' AND substr(value,-1) GLOB '[a-z0-9]'
      AND value NOT GLOB '*[^a-z0-9-]*' AND instr(value,'--')=0
      AND length(value)-length(replace(value,'-',''))<=4 FROM words);
END;

-- 163 valid_browser_policy, compiled to exact SQLite JSON/ASCII predicates. This is a static receipt constraint;
-- historical admission never bypasses it. The eight origin arrays keep their original16 bound and strict ordering.
CREATE TRIGGER shared_gateway_route_browser_policy BEFORE INSERT ON shared_gateway_route_revisions
WHEN NEW.browser_policy IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'shared gateway browser policy shape')
  WHERE coalesce(json_type(NEW.browser_policy),'missing')<>'object'
    OR (SELECT count(*) FROM json_each(NEW.browser_policy))<>9
    OR EXISTS (SELECT 1 FROM json_each(NEW.browser_policy)
      WHERE key NOT IN ('connect','scripts','styles','images','fonts','frames','frameAncestors','workers','cors'))
    OR coalesce(json_type(NEW.browser_policy,'$.workers'),'missing')<>'object'
    OR (SELECT count(*) FROM json_each(NEW.browser_policy,'$.workers'))<>2
    OR EXISTS (SELECT 1 FROM json_each(NEW.browser_policy,'$.workers') WHERE key NOT IN ('self','blob'))
    OR coalesce(json_type(NEW.browser_policy,'$.workers.self'),'missing') NOT IN ('true','false')
    OR coalesce(json_type(NEW.browser_policy,'$.workers.blob'),'missing') NOT IN ('true','false')
    OR coalesce(json_type(NEW.browser_policy,'$.cors'),'missing')<>'object'
    OR (SELECT count(*) FROM json_each(NEW.browser_policy,'$.cors'))<>2
    OR EXISTS (SELECT 1 FROM json_each(NEW.browser_policy,'$.cors') WHERE key NOT IN ('origins','credentials'))
    OR coalesce(json_type(NEW.browser_policy,'$.cors.credentials'),'missing') NOT IN ('true','false')
    OR EXISTS (
      WITH categories(path) AS (VALUES('$.connect'),('$.scripts'),('$.styles'),('$.images'),('$.fonts'),('$.frames'),('$.frameAncestors'),('$.cors.origins'))
      SELECT 1 FROM categories WHERE coalesce(json_type(NEW.browser_policy,path),'missing')<>'array'
        OR json_array_length(NEW.browser_policy,path)>16);
  SELECT RAISE(ABORT,'shared gateway browser origin shape')
  WHERE EXISTS (
    WITH categories(name,path) AS (VALUES('connect','$.connect'),('scripts','$.scripts'),('styles','$.styles'),
      ('images','$.images'),('fonts','$.fonts'),('frames','$.frames'),('frameAncestors','$.frameAncestors'),('cors','$.cors.origins')),
    origins AS (SELECT c.name,e.type,e.value,lag(e.value) OVER (PARTITION BY c.name ORDER BY CAST(e.key AS INTEGER)) AS previous
      FROM categories c JOIN json_each(NEW.browser_policy,c.path) e),
    authorities AS (SELECT *,CASE WHEN substr(value,1,8)='https://' THEN substr(value,9)
      WHEN substr(value,1,6)='wss://' THEN substr(value,7) END AS authority FROM origins),
    parts AS (SELECT *,CASE WHEN instr(authority,':')>0 THEN substr(authority,1,instr(authority,':')-1) ELSE authority END AS hostname,
      CASE WHEN instr(authority,':')>0 THEN substr(authority,instr(authority,':')+1) ELSE '' END AS port,
      instr(authority,':')>0 AS has_port FROM authorities)
    SELECT 1 FROM parts WHERE type<>'text' OR NOT (
      ((substr(value,1,8)='https://') OR (name='connect' AND substr(value,1,6)='wss://'))
      AND length(value)<=256 AND instr(value,char(0))=0
      AND (previous IS NULL OR previous<value)
      AND length(hostname)>0 AND instr(hostname,'.')>0
      AND hostname NOT GLOB '*[^a-z0-9.-]*' AND hostname NOT GLOB '*[.]local' AND hostname NOT GLOB '*[.]internal'
      AND NOT (hostname NOT GLOB '*[^0-9.]*' AND length(hostname)-length(replace(hostname,'.',''))=3)
      AND NOT EXISTS (SELECT 1 FROM json_each('["'||replace(hostname,'.','","')||'"]') label
        WHERE length(label.value) NOT BETWEEN 1 AND 63 OR substr(label.value,1,1) NOT GLOB '[a-z0-9]'
          OR substr(label.value,-1) NOT GLOB '[a-z0-9]' OR label.value GLOB '*[^a-z0-9-]*')
      AND (has_port=0 OR (length(port) BETWEEN 1 AND 5 AND substr(port,1,1) GLOB '[1-9]'
        AND port NOT GLOB '*[^0-9]*' AND CAST(port AS INTEGER)<=65535 AND port<>'443'))));
END;
-- Final v5/170/181 framework CHECK, compiled from the original scalar rules. JSON is read only: the stored
-- framework bytes and original plan digest are never normalized or recomputed. Astro uses the source's validation-only
-- adapter alias, and its extra restrictions remain on the original document. All checks also run in historical import.
CREATE TRIGGER deployment_plans_framework_shape BEFORE INSERT ON deployment_plans
WHEN NEW.framework_plan IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'deployment framework plan shape') WHERE NOT (
   WITH original(doc) AS (SELECT NEW.framework_plan),
   aliased(doc) AS (SELECT CASE WHEN json_extract(doc,'$.adapter')='astro' THEN
     CASE WHEN json_extract(doc,'$.runtime')='static' THEN json_set(doc,'$.adapter','vite-static')
       ELSE json_set(doc,'$.adapter','tanstack-start','$.serverEntryPoint','dist/server/index.js') END ELSE doc END FROM original),
   plan(p) AS (SELECT json_remove(doc,'$.ssgCacheMaxBytes') FROM aliased)
   SELECT (json_type(p)='object' AND json_extract(p,'$.schemaVersion')='ohmyhost.framework-plan/v5'
 AND coalesce(json_type(p,'$.applicationRoot'),'missing')='text' AND length(CAST(json_extract(p,'$.applicationRoot') AS BLOB))<=64
 AND (json_extract(p,'$.applicationRoot')='.' OR (json_extract(p,'$.applicationRoot') NOT GLOB '*[^A-Za-z0-9._/-]*' AND length(json_extract(p,'$.applicationRoot'))>0
   AND NOT EXISTS (SELECT 1 FROM json_each('["'||replace(json_extract(p,'$.applicationRoot'),'/','","')||'"]') segment
     WHERE length(segment.value) NOT BETWEEN 1 AND 63 OR substr(segment.value,1,1) NOT GLOB '[A-Za-z0-9]')
   AND length(json_extract(p,'$.applicationRoot'))-length(replace(json_extract(p,'$.applicationRoot'),'/',''))<8))
 AND (((json_type(json_extract(p,'$.database'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.database')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.database')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(p,'$.database'),'$.enabled')='false') OR ((json_type(json_extract(p,'$.database'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.database')))=2 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.database')) WHERE key NOT IN ('enabled','migrations'))) AND json_type(json_extract(p,'$.database'),'$.enabled')='true'
   AND coalesce(json_type(json_extract(p,'$.database'),'$.migrations'),'missing')='text' AND length(json_extract(json_extract(p,'$.database'),'$.migrations')) BETWEEN 1 AND 512
   AND substr(json_extract(json_extract(p,'$.database'),'$.migrations'),1,1)<>'/' AND instr(json_extract(json_extract(p,'$.database'),'$.migrations'),':')=0
   AND instr('/'||json_extract(json_extract(p,'$.database'),'$.migrations')||'/','/../')=0))
 AND (((json_type(json_extract(p,'$.auth'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.auth')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.auth')) WHERE key NOT IN ('provider'))) AND json_extract(json_extract(p,'$.auth'),'$.provider')='none') OR ((json_type(json_extract(p,'$.auth'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.auth')))=7 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.auth')) WHERE key NOT IN ('provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName')))
   AND json_extract(json_extract(p,'$.auth'),'$.provider')='better-auth' AND json_extract(json_extract(p,'$.auth'),'$.version') IN ('1.7.1','1.7.7')
   AND json_extract(json_extract(p,'$.auth'),'$.deployment') IN ('embedded','companion') AND json_extract(json_extract(p,'$.auth'),'$.routePath')='/api/auth'
   AND json_extract(json_extract(p,'$.auth'),'$.databaseSchema')='auth' AND json_extract(json_extract(p,'$.auth'),'$.databaseBindingName')='OHMYHOST_DATABASE'
   AND json_extract(json_extract(p,'$.auth'),'$.authSecretName')='BETTER_AUTH_SECRET'))
 AND (json_type(json_extract(p,'$.mail'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.mail')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.mail')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(p,'$.mail'),'$.enabled') IN ('true','false')
 AND (((json_type(json_extract(p,'$.storage'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.storage')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.storage')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(p,'$.storage'),'$.enabled')='false') OR ((json_type(json_extract(p,'$.storage'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.storage')))=4 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.storage')) WHERE key NOT IN ('enabled','provider','jurisdiction','public')))
   AND json_type(json_extract(p,'$.storage'),'$.enabled')='true' AND json_extract(json_extract(p,'$.storage'),'$.provider')='r2'
   AND json_extract(json_extract(p,'$.storage'),'$.jurisdiction') IN ('eu','us') AND json_type(json_extract(p,'$.storage'),'$.public')='false'))
 AND (json_extract(json_extract(p,'$.auth'),'$.provider')='none' OR json_type(json_extract(p,'$.database'),'$.enabled')='true')) IS TRUE FROM plan);
END;
CREATE TRIGGER deployment_plans_framework_kind BEFORE INSERT ON deployment_plans
WHEN NEW.framework_plan IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'deployment framework adapter shape') WHERE NOT (
   WITH original(doc) AS (SELECT NEW.framework_plan),
   aliased(doc) AS (SELECT CASE WHEN json_extract(doc,'$.adapter')='astro' THEN
     CASE WHEN json_extract(doc,'$.runtime')='static' THEN json_set(doc,'$.adapter','vite-static')
       ELSE json_set(doc,'$.adapter','tanstack-start','$.serverEntryPoint','dist/server/index.js') END ELSE doc END FROM original),
   plan(p) AS (SELECT json_remove(doc,'$.ssgCacheMaxBytes') FROM aliased)
   SELECT ((
 ((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=12 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage'))) AND ((json_extract(p,'$.installCommand')='bun install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='bun run build') OR (json_extract(p,'$.installCommand')='npm ci --ignore-scripts' AND json_extract(p,'$.buildCommand')='npm run build') OR (json_extract(p,'$.installCommand')='pnpm install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='pnpm run build') OR (json_extract(p,'$.installCommand')='yarn install --immutable --mode=skip-build' AND json_extract(p,'$.buildCommand')='yarn run build')) AND json_extract(p,'$.adapter') IN ('vite-static','tanstack-start') AND json_extract(p,'$.runtime')='static'
  AND ((json_extract(p,'$.adapter')='vite-static' AND json_extract(p,'$.outputDirectory')='dist') OR (json_extract(p,'$.adapter')='tanstack-start' AND json_extract(p,'$.outputDirectory')='dist/client')) AND ((json_type(json_extract(p,'$.storage'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.storage')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.storage')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(p,'$.storage'),'$.enabled')='false'))
 OR (((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=17 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags'))) OR (json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=18 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags','functions')))) AND ((json_extract(p,'$.installCommand')='bun install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='bun run build') OR (json_extract(p,'$.installCommand')='npm ci --ignore-scripts' AND json_extract(p,'$.buildCommand')='npm run build') OR (json_extract(p,'$.installCommand')='pnpm install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='pnpm run build') OR (json_extract(p,'$.installCommand')='yarn install --immutable --mode=skip-build' AND json_extract(p,'$.buildCommand')='yarn run build')) AND json_extract(p,'$.adapter')='tanstack-start' AND json_extract(p,'$.runtime')='edge' AND NEW.runtime='cloudflare_workers_edge_ssr'
  AND json_extract(p,'$.outputDirectory')='dist/client' AND json_extract(p,'$.serverOutputDirectory')='dist/server' AND json_extract(p,'$.serverEntryPoint')='dist/server/index.js'
  AND json_extract(p,'$.serverConfigPath')='dist/server/wrangler.json' AND (CASE coalesce(json_type(p,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (p->'$.compatibilityDate') WHEN 'real' THEN (p->'$.compatibilityDate') ELSE CAST(json_extract(p,'$.compatibilityDate') AS TEXT) END)>='2025-04-01' AND (coalesce(json_type(p,'$.compatibilityFlags'),'missing')='array' AND json_array_length(p,'$.compatibilityFlags')=1 AND json_extract(p,'$.compatibilityFlags[0]')='nodejs_compat'))
 OR (((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=17 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags'))) OR (json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=18 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags','functions')))) AND ((json_extract(p,'$.installCommand')='bun install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='bun run build') OR (json_extract(p,'$.installCommand')='npm ci --ignore-scripts' AND json_extract(p,'$.buildCommand')='npm run build') OR (json_extract(p,'$.installCommand')='pnpm install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='pnpm run build') OR (json_extract(p,'$.installCommand')='yarn install --immutable --mode=skip-build' AND json_extract(p,'$.buildCommand')='yarn run build')) AND json_extract(p,'$.adapter')='nextjs' AND json_extract(p,'$.runtime')='edge' AND NEW.runtime='cloudflare_workers_edge_ssr'
  AND json_extract(p,'$.outputDirectory')='.open-next/assets' AND json_extract(p,'$.serverOutputDirectory')='.ohmyhost-worker' AND json_extract(p,'$.serverEntryPoint')='.ohmyhost-worker/worker.js'
  AND json_extract(p,'$.serverConfigPath')='wrangler.jsonc' AND (CASE coalesce(json_type(p,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (p->'$.compatibilityDate') WHEN 'real' THEN (p->'$.compatibilityDate') ELSE CAST(json_extract(p,'$.compatibilityDate') AS TEXT) END)>='2024-09-23' AND (coalesce(json_type(p,'$.compatibilityFlags'),'missing')='array' AND json_array_length(p,'$.compatibilityFlags')=1 AND json_extract(p,'$.compatibilityFlags[0]')='nodejs_compat'))
 OR (((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=17 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags'))) OR (json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=18 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags','functions')))) AND ((json_extract(p,'$.installCommand')='bun install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='bun run build') OR (json_extract(p,'$.installCommand')='npm ci --ignore-scripts' AND json_extract(p,'$.buildCommand')='npm run build') OR (json_extract(p,'$.installCommand')='pnpm install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='pnpm run build') OR (json_extract(p,'$.installCommand')='yarn install --immutable --mode=skip-build' AND json_extract(p,'$.buildCommand')='yarn run build')) AND json_extract(p,'$.adapter')='vite-static' AND json_extract(p,'$.runtime')='edge' AND NEW.runtime='cloudflare_workers_edge_ssr'
  AND json_extract(p,'$.outputDirectory')='dist' AND json_extract(p,'$.serverOutputDirectory')='.ohmyhost/vite-companion' AND json_extract(p,'$.serverEntryPoint')='.ohmyhost/vite-companion/worker.js'
  AND json_extract(p,'$.serverConfigPath')='.ohmyhost/vite-companion/wrangler.jsonc' AND (CASE coalesce(json_type(p,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (p->'$.compatibilityDate') WHEN 'real' THEN (p->'$.compatibilityDate') ELSE CAST(json_extract(p,'$.compatibilityDate') AS TEXT) END)='2025-01-01' AND (coalesce(json_type(p,'$.compatibilityFlags'),'missing')='array' AND json_array_length(p,'$.compatibilityFlags')=1 AND json_extract(p,'$.compatibilityFlags[0]')='nodejs_compat')
  AND (json_extract(json_extract(p,'$.auth'),'$.provider')='none' OR json_extract(json_extract(p,'$.auth'),'$.deployment')='companion'))
 OR (((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=12 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','compatibilityDate','compatibilityFlags'))) OR (json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=13 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','compatibilityDate','compatibilityFlags','functions')))) AND json_extract(p,'$.adapter')='functions' AND json_extract(p,'$.runtime')='functions' AND NEW.runtime='cloudflare_workers_edge_ssr'
  AND json_extract(p,'$.installCommand') IN ('bun install --frozen-lockfile --ignore-scripts','npm ci --ignore-scripts','pnpm install --frozen-lockfile --ignore-scripts','yarn install --immutable --mode=skip-build') AND (CASE coalesce(json_type(p,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (p->'$.compatibilityDate') WHEN 'real' THEN (p->'$.compatibilityDate') ELSE CAST(json_extract(p,'$.compatibilityDate') AS TEXT) END)>='2025-01-01' AND (coalesce(json_type(p,'$.compatibilityFlags'),'missing')='array' AND json_array_length(p,'$.compatibilityFlags')=1 AND json_extract(p,'$.compatibilityFlags[0]')='nodejs_compat')
  AND (json_extract(json_extract(p,'$.auth'),'$.provider')='none' OR json_extract(json_extract(p,'$.auth'),'$.deployment')='companion'))
)) IS TRUE FROM plan);
 SELECT RAISE(ABORT,'Astro framework plan shape') WHERE json_extract(NEW.framework_plan,'$.adapter')='astro' AND ((
   json_type(NEW.framework_plan,'$.ssgCacheMaxBytes') IS NULL
   AND (json_extract(NEW.framework_plan,'$.runtime')='static' OR (json_extract(NEW.framework_plan,'$.serverEntryPoint')='dist/server/entry.mjs' AND (CASE coalesce(json_type(NEW.framework_plan,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (NEW.framework_plan->'$.compatibilityDate') WHEN 'real' THEN (NEW.framework_plan->'$.compatibilityDate') ELSE CAST(json_extract(NEW.framework_plan,'$.compatibilityDate') AS TEXT) END)>='2026-10-12'))
   AND (json_extract(NEW.framework_plan,'$.runtime')<>'static' OR (((json_type(json_extract(NEW.framework_plan,'$.database'))='object' AND (SELECT count(*) FROM json_each(json_extract(NEW.framework_plan,'$.database')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(NEW.framework_plan,'$.database')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(NEW.framework_plan,'$.database'),'$.enabled')='false') AND ((json_type(json_extract(NEW.framework_plan,'$.auth'))='object' AND (SELECT count(*) FROM json_each(json_extract(NEW.framework_plan,'$.auth')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(NEW.framework_plan,'$.auth')) WHERE key NOT IN ('provider'))) AND json_extract(json_extract(NEW.framework_plan,'$.auth'),'$.provider')='none') AND ((json_type(json_extract(NEW.framework_plan,'$.mail'))='object' AND (SELECT count(*) FROM json_each(json_extract(NEW.framework_plan,'$.mail')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(NEW.framework_plan,'$.mail')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(NEW.framework_plan,'$.mail'),'$.enabled')='false')))) IS NOT TRUE);
END;
CREATE TRIGGER deployment_plans_function_crons BEFORE INSERT ON deployment_plans
WHEN json_type(NEW.framework_plan,'$.functions') IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'deployment function cron shape') WHERE ((json_type(json_extract(NEW.framework_plan,'$.functions'))='object' AND (SELECT count(*) FROM json_each(json_extract(NEW.framework_plan,'$.functions')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(NEW.framework_plan,'$.functions')) WHERE key NOT IN ('crons'))) AND json_type(json_extract(NEW.framework_plan,'$.functions'),'$.crons')='array' AND json_array_length(json_extract(NEW.framework_plan,'$.functions'),'$.crons') BETWEEN 1 AND 8) IS NOT TRUE;
 SELECT RAISE(ABORT,'deployment function cron value') WHERE EXISTS (
   WITH crons AS (SELECT type,value,lag(value) OVER (ORDER BY CAST(key AS INTEGER)) AS previous FROM json_each(json_extract(NEW.framework_plan,'$.functions'),'$.crons'))
   SELECT 1 FROM crons cron WHERE cron.type<>'text' OR cron.value GLOB '*[^0-9*/ ]*' OR (cron.previous IS NOT NULL AND cron.previous>=cron.value)
     OR length(cron.value)-length(replace(cron.value,' ',''))<>4
     OR EXISTS (SELECT 1 FROM json_each('["'||replace(cron.value,' ','","')||'"]') field WHERE
       CASE CAST(field.key AS INTEGER)
        WHEN 0 THEN NOT ((length(field.value)>0 AND field.value NOT GLOB '*[^0-9]*' AND CAST(field.value AS INTEGER) BETWEEN 0 AND 59 AND CAST(CAST(field.value AS INTEGER) AS TEXT)=field.value) OR (substr(field.value,1,2)='*/' AND (length(substr(field.value,3))>0 AND substr(field.value,3) NOT GLOB '*[^0-9]*' AND CAST(substr(field.value,3) AS INTEGER) BETWEEN 5 AND 59 AND CAST(CAST(substr(field.value,3) AS INTEGER) AS TEXT)=substr(field.value,3))))
        WHEN 1 THEN NOT (field.value='*' OR (length(field.value)>0 AND field.value NOT GLOB '*[^0-9]*' AND CAST(field.value AS INTEGER) BETWEEN 0 AND 23 AND CAST(CAST(field.value AS INTEGER) AS TEXT)=field.value))
        WHEN 2 THEN NOT (field.value='*' OR (length(field.value)>0 AND field.value NOT GLOB '*[^0-9]*' AND CAST(field.value AS INTEGER) BETWEEN 1 AND 31 AND CAST(CAST(field.value AS INTEGER) AS TEXT)=field.value))
        WHEN 3 THEN NOT (field.value='*' OR (length(field.value)>0 AND field.value NOT GLOB '*[^0-9]*' AND CAST(field.value AS INTEGER) BETWEEN 1 AND 12 AND CAST(CAST(field.value AS INTEGER) AS TEXT)=field.value))
        WHEN 4 THEN NOT (field.value='*' OR (length(field.value)>0 AND field.value NOT GLOB '*[^0-9]*' AND CAST(field.value AS INTEGER) BETWEEN 0 AND 6 AND CAST(CAST(field.value AS INTEGER) AS TEXT)=field.value)) ELSE 1 END));
END;
CREATE TRIGGER deployment_plans_ssg_cache BEFORE INSERT ON deployment_plans
WHEN json_type(NEW.framework_plan,'$.ssgCacheMaxBytes') IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'deployment SSG cache shape') WHERE json_extract(NEW.framework_plan,'$.adapter') IS NOT 'nextjs' OR json_extract(NEW.framework_plan,'$.runtime') IS NOT 'edge' OR json_type(NEW.framework_plan,'$.ssgCacheMaxBytes') NOT IN ('integer','real');
 SELECT RAISE(ABORT,'deployment SSG cache precision/range') WHERE NOT EXISTS (
   WITH RECURSIVE limits(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM limits WHERE n<64),
   raw(token) AS (SELECT lower(NEW.framework_plan->'$.ssgCacheMaxBytes')),
   parts(mantissa,exponent) AS (SELECT CASE WHEN instr(token,'e')>0 THEN substr(token,1,instr(token,'e')-1) ELSE token END,CASE WHEN instr(token,'e')>0 THEN CAST(substr(token,instr(token,'e')+1) AS INTEGER) ELSE 0 END FROM raw),
   decimal(digits,scale) AS (SELECT ltrim(replace(mantissa,'.',''),'0'),exponent-CASE WHEN instr(mantissa,'.')>0 THEN length(mantissa)-instr(mantissa,'.') ELSE 0 END FROM parts),
   normalized(coefficient,scale) AS (SELECT rtrim(digits,'0'),scale+length(digits)-length(rtrim(digits,'0')) FROM decimal),
   wanted(value) AS (SELECT CAST(n*1048576 AS TEXT) FROM limits)
   SELECT 1 FROM normalized JOIN wanted ON coefficient=rtrim(value,'0') AND normalized.scale=length(value)-length(rtrim(value,'0')));
END;

-- Exact original valid_runtime_policy. Egress uses its original hostname/IP rules, which differ from browser
-- origins: public IPv4 is retained, there is no added origin length/label cap, and a JSON null iteration resets
-- previous just as jsonb_array_elements_text/PLpgSQL did. A stricter new-product policy is not invented here.
CREATE TRIGGER deployment_plans_runtime_policy BEFORE INSERT ON deployment_plans
WHEN NEW.framework_plan IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'deployment runtime policy shape') WHERE NOT (
    WITH policy(p) AS (SELECT json_extract(NEW.framework_plan,'$.runtimePolicy'))
    SELECT json_type(p)='object' AND (SELECT count(*) FROM json_each(p)) IN (2,3)
      AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('healthCheckPath','egressAllowedOrigins','browser'))
      AND coalesce(json_type(p,'$.healthCheckPath'),'missing')='text'
      AND length(json_extract(p,'$.healthCheckPath')) BETWEEN 1 AND 256
      AND substr(json_extract(p,'$.healthCheckPath'),1,1)='/' AND substr(json_extract(p,'$.healthCheckPath'),2,1)<>'/'
      AND instr(json_extract(p,'$.healthCheckPath'),'?')=0 AND instr(json_extract(p,'$.healthCheckPath'),'#')=0
      AND instr('/'||json_extract(p,'$.healthCheckPath')||'/','/./')=0
      AND instr('/'||json_extract(p,'$.healthCheckPath')||'/','/../')=0
      AND coalesce(json_type(p,'$.egressAllowedOrigins'),'missing')='array'
      AND json_array_length(p,'$.egressAllowedOrigins')<=16 FROM policy) IS TRUE;
  SELECT RAISE(ABORT,'deployment egress origin shape') WHERE EXISTS (
    WITH origins AS (SELECT type,value,lag(value) OVER (ORDER BY CAST(key AS INTEGER)) AS previous
      FROM json_each(NEW.framework_plan,'$.runtimePolicy.egressAllowedOrigins')),
    authorities AS (SELECT *,substr(value,9) AS authority FROM origins WHERE type<>'null'),
    parts AS (SELECT *,CASE WHEN instr(authority,':')>0 THEN substr(authority,1,instr(authority,':')-1) ELSE authority END AS hostname,
      CASE WHEN instr(authority,':')>0 THEN substr(authority,instr(authority,':')+1) ELSE '' END AS port,
      instr(authority,':')>0 AS has_port FROM authorities)
    SELECT 1 FROM parts WHERE NOT (
      substr(value,1,8)='https://' AND instr(value,char(0))=0
      AND length(hostname)>0 AND substr(hostname,1,1) GLOB '[a-z0-9]' AND substr(hostname,-1) GLOB '[a-z0-9]'
      AND hostname NOT GLOB '*[^a-z0-9.-]*' AND hostname<>'localhost'
      AND hostname NOT GLOB '*[.]local' AND hostname NOT GLOB '*[.]internal'
      AND (previous IS NULL OR previous<value)
      AND (has_port=0 OR (length(port) BETWEEN 1 AND 5 AND substr(port,1,1) GLOB '[1-9]'
        AND port NOT GLOB '*[^0-9]*' AND CAST(port AS INTEGER)<=65535 AND port<>'443'))));
  SELECT RAISE(ABORT,'deployment egress IPv4 shape') WHERE EXISTS (
    WITH origins AS (SELECT value FROM json_each(NEW.framework_plan,'$.runtimePolicy.egressAllowedOrigins') WHERE type='text'),
    authorities AS (SELECT substr(value,9) AS authority FROM origins),
    hosts AS (SELECT CASE WHEN instr(authority,':')>0 THEN substr(authority,1,instr(authority,':')-1) ELSE authority END AS hostname FROM authorities),
    possible AS (SELECT '["'||replace(hostname,'.','","')||'"]' AS parts FROM hosts
      WHERE hostname NOT GLOB '*[^0-9.]*' AND length(hostname)-length(replace(hostname,'.',''))=3),
    ips AS (SELECT parts,CAST(json_extract(parts,'$[0]') AS INTEGER) AS a,CAST(json_extract(parts,'$[1]') AS INTEGER) AS b
      FROM possible WHERE NOT EXISTS (SELECT 1 FROM json_each(parts) WHERE length(value) NOT BETWEEN 1 AND 3))
    SELECT 1 FROM ips WHERE EXISTS (SELECT 1 FROM json_each(parts) WHERE CAST(value AS INTEGER)>255)
      OR a IN (0,10,127) OR (a=169 AND b=254) OR (a=172 AND b BETWEEN 16 AND 31)
      OR (a=192 AND b=168) OR a BETWEEN 224 AND 239);
END;
-- 163 valid_browser_policy, compiled to exact SQLite JSON/ASCII predicates. This is a static receipt constraint;
-- historical admission never bypasses it. The eight origin arrays keep their original16 bound and strict ordering.
CREATE TRIGGER deployment_plans_browser_policy BEFORE INSERT ON deployment_plans
WHEN json_type(NEW.framework_plan,'$.runtimePolicy.browser') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'shared gateway browser policy shape')
  WHERE coalesce(json_type(json_extract(NEW.framework_plan,'$.runtimePolicy.browser')),'missing')<>'object'
    OR (SELECT count(*) FROM json_each(json_extract(NEW.framework_plan,'$.runtimePolicy.browser')))<>9
    OR EXISTS (SELECT 1 FROM json_each(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'))
      WHERE key NOT IN ('connect','scripts','styles','images','fonts','frames','frameAncestors','workers','cors'))
    OR coalesce(json_type(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),'$.workers'),'missing')<>'object'
    OR (SELECT count(*) FROM json_each(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),'$.workers'))<>2
    OR EXISTS (SELECT 1 FROM json_each(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),'$.workers') WHERE key NOT IN ('self','blob'))
    OR coalesce(json_type(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),'$.workers.self'),'missing') NOT IN ('true','false')
    OR coalesce(json_type(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),'$.workers.blob'),'missing') NOT IN ('true','false')
    OR coalesce(json_type(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),'$.cors'),'missing')<>'object'
    OR (SELECT count(*) FROM json_each(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),'$.cors'))<>2
    OR EXISTS (SELECT 1 FROM json_each(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),'$.cors') WHERE key NOT IN ('origins','credentials'))
    OR coalesce(json_type(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),'$.cors.credentials'),'missing') NOT IN ('true','false')
    OR EXISTS (
      WITH categories(path) AS (VALUES('$.connect'),('$.scripts'),('$.styles'),('$.images'),('$.fonts'),('$.frames'),('$.frameAncestors'),('$.cors.origins'))
      SELECT 1 FROM categories WHERE coalesce(json_type(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),path),'missing')<>'array'
        OR json_array_length(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),path)>16);
  SELECT RAISE(ABORT,'shared gateway browser origin shape')
  WHERE EXISTS (
    WITH categories(name,path) AS (VALUES('connect','$.connect'),('scripts','$.scripts'),('styles','$.styles'),
      ('images','$.images'),('fonts','$.fonts'),('frames','$.frames'),('frameAncestors','$.frameAncestors'),('cors','$.cors.origins')),
    origins AS (SELECT c.name,e.type,e.value,lag(e.value) OVER (PARTITION BY c.name ORDER BY CAST(e.key AS INTEGER)) AS previous
      FROM categories c JOIN json_each(json_extract(NEW.framework_plan,'$.runtimePolicy.browser'),c.path) e),
    authorities AS (SELECT *,CASE WHEN substr(value,1,8)='https://' THEN substr(value,9)
      WHEN substr(value,1,6)='wss://' THEN substr(value,7) END AS authority FROM origins),
    parts AS (SELECT *,CASE WHEN instr(authority,':')>0 THEN substr(authority,1,instr(authority,':')-1) ELSE authority END AS hostname,
      CASE WHEN instr(authority,':')>0 THEN substr(authority,instr(authority,':')+1) ELSE '' END AS port,
      instr(authority,':')>0 AS has_port FROM authorities)
    SELECT 1 FROM parts WHERE type<>'text' OR NOT (
      ((substr(value,1,8)='https://') OR (name='connect' AND substr(value,1,6)='wss://'))
      AND length(value)<=256 AND instr(value,char(0))=0
      AND (previous IS NULL OR previous<value)
      AND length(hostname)>0 AND instr(hostname,'.')>0
      AND hostname NOT GLOB '*[^a-z0-9.-]*' AND hostname NOT GLOB '*[.]local' AND hostname NOT GLOB '*[.]internal'
      AND NOT (hostname NOT GLOB '*[^0-9.]*' AND length(hostname)-length(replace(hostname,'.',''))=3)
      AND NOT EXISTS (SELECT 1 FROM json_each('["'||replace(hostname,'.','","')||'"]') label
        WHERE length(label.value) NOT BETWEEN 1 AND 63 OR substr(label.value,1,1) NOT GLOB '[a-z0-9]'
          OR substr(label.value,-1) NOT GLOB '[a-z0-9]' OR label.value GLOB '*[^a-z0-9-]*')
      AND (has_port=0 OR (length(port) BETWEEN 1 AND 5 AND substr(port,1,1) GLOB '[1-9]'
        AND port NOT GLOB '*[^0-9]*' AND CAST(port AS INTEGER)<=65535 AND port<>'443'))));
END;
CREATE TRIGGER project_source_bindings_original_int4_insert BEFORE INSERT ON project_source_bindings
  WHEN NEW.generation>2147483647
BEGIN SELECT RAISE(ABORT,'source binding generation exceeds original int4'); END;
CREATE TRIGGER project_source_bindings_original_int4_update BEFORE UPDATE ON project_source_bindings
  WHEN NEW.generation>2147483647
BEGIN SELECT RAISE(ABORT,'source binding generation exceeds original int4'); END;
PRAGMA defer_foreign_keys=ON;
INSERT INTO source_connections SELECT * FROM source_connections_copy_0336;
INSERT INTO project_source_bindings SELECT * FROM project_source_bindings_copy_0336;
INSERT INTO repository_grants SELECT * FROM repository_grants_copy_0336;
INSERT INTO deployment_plans SELECT * FROM deployment_plans_copy_0336;
INSERT INTO deployments SELECT * FROM deployments_copy_0336;
INSERT INTO wfp_candidate_receipts SELECT * FROM wfp_candidate_receipts_copy_0336;
INSERT INTO shared_gateway_route_revisions SELECT * FROM shared_gateway_route_revisions_copy_0336;
INSERT INTO wfp_publish_receipts SELECT * FROM wfp_publish_receipts_copy_0336;
INSERT INTO wfp_candidate_cleanup_receipts SELECT * FROM wfp_candidate_cleanup_receipts_copy_0336;
INSERT INTO deployment_revisions SELECT * FROM deployment_revisions_copy_0336;
INSERT INTO action_confirmations SELECT * FROM action_confirmations_copy_0336;
INSERT INTO github_push_deployments SELECT * FROM github_push_deployments_copy_0336;
INSERT INTO repository_grant_revocations SELECT * FROM repository_grant_revocations_copy_0336;
DROP TABLE action_confirmations_copy_0336;
DROP TABLE github_push_deployments_copy_0336;
DROP TABLE repository_grant_revocations_copy_0336;
DROP TABLE project_source_bindings_copy_0336;
DROP TABLE deployment_revisions_copy_0336;
DROP TABLE wfp_candidate_cleanup_receipts_copy_0336;
DROP TABLE wfp_publish_receipts_copy_0336;
DROP TABLE shared_gateway_route_revisions_copy_0336;
DROP TABLE wfp_candidate_receipts_copy_0336;
DROP TABLE deployments_copy_0336;
DROP TABLE deployment_plans_copy_0336;
DROP TABLE repository_grants_copy_0336;
DROP TABLE source_connections_copy_0336;
-- Existing bytes are copied before adding this original173 NEW-insert binder. It is not a replay of old
-- source events. A subsequent verified import accounts/restores the captured final binding state exactly.
CREATE TRIGGER github_grant_bind_source AFTER INSERT ON repository_grants
WHEN NEW.provider='github'
BEGIN
  INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at)
    VALUES(NEW.organization_id,NEW.project_id,NEW.source_connection_id,'github',1,NULL,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'))
    ON CONFLICT(organization_id,project_id) DO UPDATE SET source_connection_id=excluded.source_connection_id,
      generation=CASE WHEN project_source_bindings.source_connection_id=excluded.source_connection_id THEN project_source_bindings.generation ELSE project_source_bindings.generation+1 END,
      updated_at=excluded.updated_at
    WHERE project_source_bindings.provider='github' AND project_source_bindings.source_connection_id=excluded.source_connection_id;
END;


