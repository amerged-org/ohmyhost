-- Original immutable lifetime evidence and its real historical parents (007 / 058 / 062 / 127 / 143 / 144 / 163).
-- Current authority is an INSERT admission, not the identity of old evidence. The exact temporal predicates below
-- recognize only the closed UNSERVED attestation of 0335. All static identity/FK/shape/append-only checks stay active.
CREATE UNIQUE INDEX IF NOT EXISTS environment_identities_project_environment
  ON environment_identities(project_id,environment_id);

-- 058 makes a deployment's environment identity stable across ownership changes. Rebuild only that parent;
-- foreign_key_check after the full schema is mandatory. Child rows are staged/restored in the one atomic
-- migration; there is never a foreign_keys=OFF mode, and every final FK addresses the same table name.
-- Real workerd refuses temporary RESTRICT violations even with defer_foreign_keys. Stage both existing children
-- and restore their IDENTICAL DDL/bytes in this same atomic migration, like qualified0325.
CREATE TABLE deployment_revisions_copy_0334 AS SELECT * FROM deployment_revisions;
DROP TABLE deployment_revisions;
CREATE TABLE action_confirmations_copy_0334 AS SELECT * FROM action_confirmations;
DROP TABLE action_confirmations;
CREATE TABLE deployments_history_parent (
  organization_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL CHECK (length(deployment_id)=26 AND deployment_id GLOB '[0-7]*'
    AND deployment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deploy','promotion','rollback')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','reconciliation_required')),
  active_revision_id TEXT CHECK (active_revision_id IS NULL OR length(active_revision_id)=26),
  active_version INTEGER NOT NULL CHECK (active_version>=0),
  rollback_target_deployment_id TEXT,
  rollback_target_revision_id TEXT,
  promotion_source_environment_id TEXT,
  promotion_source_deployment_id TEXT,
  promotion_source_revision_id TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id,deployment_id),
  FOREIGN KEY (project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
  FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id)
) STRICT, WITHOUT ROWID;
INSERT INTO deployments_history_parent SELECT * FROM deployments;
DROP TABLE deployments;
ALTER TABLE deployments_history_parent RENAME TO deployments;
CREATE INDEX deployments_by_environment ON deployments (organization_id, project_id, environment_id, created_at DESC, deployment_id DESC);
CREATE UNIQUE INDEX deployments_global_id ON deployments(deployment_id);
CREATE UNIQUE INDEX deployments_project_scope ON deployments(organization_id,project_id,deployment_id);
CREATE UNIQUE INDEX deployments_operation_scope ON deployments(organization_id,project_id,operation_id,deployment_id);

CREATE TABLE deployment_revisions (
  organization_id     TEXT NOT NULL,
  revision_id         TEXT NOT NULL CHECK (length(revision_id) = 26),
  project_id          TEXT NOT NULL,
  deployment_id       TEXT NOT NULL,
  plan_id             TEXT NOT NULL,
  build_execution_id  TEXT NOT NULL,
  artifact_id         TEXT NOT NULL,
  wfp_receipt_id      TEXT NOT NULL,
  operation_id        TEXT NOT NULL,
  created_at          TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, revision_id),
  FOREIGN KEY (organization_id, deployment_id) REFERENCES deployments (organization_id, deployment_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX deployment_revisions_by_deployment ON deployment_revisions (organization_id, deployment_id, revision_id);

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
INSERT INTO deployment_revisions SELECT * FROM deployment_revisions_copy_0334;
DROP TABLE deployment_revisions_copy_0334;
INSERT INTO action_confirmations SELECT * FROM action_confirmations_copy_0334;
DROP TABLE action_confirmations_copy_0334;

CREATE TABLE build_source_uploads (
  upload_id TEXT NOT NULL PRIMARY KEY CHECK (length(upload_id)=26 AND upload_id GLOB '[0-7]*'
    AND upload_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  source_connection_id TEXT NOT NULL CHECK (length(source_connection_id)=26 AND source_connection_id GLOB '[0-7]*'
    AND source_connection_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'
    AND commit_sha<>'0000000000000000000000000000000000000000'),
  bucket_name TEXT NOT NULL CHECK (bucket_name=trim(bucket_name) AND length(bucket_name) BETWEEN 3 AND 63),
  object_key TEXT NOT NULL CHECK (object_key=trim(object_key) AND length(object_key) BETWEEN 1 AND 1024),
  object_version_id TEXT,
  multipart_upload_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('uploading','completed','aborted','reconciliation_required')),
  claim_id TEXT NOT NULL CHECK (length(claim_id)=26 AND claim_id GLOB '[0-7]*'
    AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  claimed_at TEXT NOT NULL CHECK (claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at TEXT NOT NULL CHECK (lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,project_id,upload_id),
  UNIQUE(organization_id,project_id,operation_id,source_connection_id,commit_sha),
  FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
  CHECK (lease_expires_at>claimed_at AND updated_at>=created_at
    AND ((state='completed' AND object_version_id IS NOT NULL)
      OR (state<>'completed' AND object_version_id IS NULL)))
) STRICT, WITHOUT ROWID;
CREATE TABLE build_source_upload_parts (
  upload_id TEXT NOT NULL REFERENCES build_source_uploads(upload_id) ON DELETE RESTRICT,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL CHECK (length(etag) BETWEEN 1 AND 256),
  byte_length INTEGER NOT NULL CHECK (byte_length>0),
  sha256 BLOB NOT NULL CHECK (length(sha256)=32),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(upload_id,part_number)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER build_source_upload_parts_no_update BEFORE UPDATE ON build_source_upload_parts
BEGIN SELECT RAISE(ABORT,'build source parts are append-only'); END;
CREATE TRIGGER build_source_upload_parts_no_delete BEFORE DELETE ON build_source_upload_parts
BEGIN SELECT RAISE(ABORT,'build source parts are append-only'); END;

CREATE TABLE build_executions (
  build_execution_id TEXT NOT NULL PRIMARY KEY CHECK (length(build_execution_id)=26 AND build_execution_id GLOB '[0-7]*'
    AND build_execution_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  source_upload_id TEXT NOT NULL REFERENCES build_source_uploads(upload_id) ON DELETE RESTRICT,
  build_plan_sha256 BLOB NOT NULL CHECK (length(build_plan_sha256)=32),
  build_project_name TEXT NOT NULL,
  provider_build_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','failed','reconciliation_required')),
  claim_id TEXT CHECK (claim_id IS NULL OR (length(claim_id)=26 AND claim_id GLOB '[0-7]*'
    AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  claimed_at TEXT CHECK (claimed_at IS NULL OR claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,project_id,build_execution_id),
  UNIQUE(source_upload_id,build_plan_sha256),
  FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,source_upload_id) REFERENCES build_source_uploads(organization_id,project_id,upload_id) ON DELETE RESTRICT,
  CHECK (updated_at>=created_at AND
    ((state IN ('pending','running') AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at)
      OR (state NOT IN ('pending','running') AND claim_id IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)))
) STRICT, WITHOUT ROWID;
CREATE TABLE build_artifacts (
  artifact_id TEXT NOT NULL PRIMARY KEY CHECK (length(artifact_id)=26 AND artifact_id GLOB '[0-7]*'
    AND artifact_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  build_execution_id TEXT NOT NULL REFERENCES build_executions(build_execution_id) ON DELETE RESTRICT,
  artifact_sha256 BLOB NOT NULL CHECK (length(artifact_sha256)=32),
  manifest_sha256 BLOB NOT NULL CHECK (length(manifest_sha256)=32),
  sbom_sha256 BLOB NOT NULL CHECK (length(sbom_sha256)=32),
  object_version_ref TEXT NOT NULL CHECK (length(object_version_ref) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,project_id,artifact_id),
  UNIQUE(build_execution_id,artifact_sha256),
  FOREIGN KEY (organization_id,project_id,build_execution_id) REFERENCES build_executions(organization_id,project_id,build_execution_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER build_artifacts_no_update BEFORE UPDATE ON build_artifacts
BEGIN SELECT RAISE(ABORT,'build artifacts are append-only'); END;
CREATE TRIGGER build_artifacts_no_delete BEFORE DELETE ON build_artifacts
BEGIN SELECT RAISE(ABORT,'build artifacts are append-only'); END;

CREATE TABLE run_cleanup_attempts (
  cleanup_attempt_id TEXT NOT NULL PRIMARY KEY CHECK (length(cleanup_attempt_id)=26 AND cleanup_attempt_id GLOB '[0-7]*'
    AND cleanup_attempt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  external_ref_hash BLOB NOT NULL CHECK (length(external_ref_hash)=32),
  outcome TEXT NOT NULL CHECK (outcome IN ('removed','not_found','failed')),
  error_code TEXT,
  attempted_at TEXT NOT NULL CHECK (attempted_at GLOB '????-??-??T??:??:??.??????Z'),
  FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
  CHECK ((outcome='failed' AND error_code IS NOT NULL) OR (outcome<>'failed' AND error_code IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX run_cleanup_attempts_lifetime ON run_cleanup_attempts(organization_id,project_id,resource_kind,external_ref_hash,attempted_at)
  WHERE outcome IN ('removed','not_found');
CREATE TRIGGER run_cleanup_attempts_no_update BEFORE UPDATE ON run_cleanup_attempts
BEGIN SELECT RAISE(ABORT,'cleanup attempts are append-only'); END;
CREATE TRIGGER run_cleanup_attempts_no_delete BEFORE DELETE ON run_cleanup_attempts
BEGIN SELECT RAISE(ABORT,'cleanup attempts are append-only'); END;

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
