-- Original047/118/147/167/173/200 product intent data/identity/static constraints.
-- UNSERVED source correction only: a prototype JSON data-change value or missing original parent is refused,
-- never rewritten or assigned invented history. The source capture must be reimported into this exact schema.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE _0451_workflow_runs AS SELECT * FROM product_workflow_runs;
DROP TABLE product_workflow_runs;
CREATE TABLE _0451_product_intents AS SELECT * FROM product_command_intents;
DROP TABLE product_command_intents;
CREATE TABLE product_command_intents (
  organization_id                  TEXT    NOT NULL,
  operation_id                     TEXT    NOT NULL,
  event_type                       TEXT    NOT NULL CHECK (event_type GLOB '*V[0-9]*' AND length(event_type) BETWEEN 8 AND 128),
  project_id                       TEXT    NOT NULL,
  environment_id                   TEXT    NOT NULL,
  billing_epoch_id                 TEXT    NOT NULL,
  installation_id                  TEXT,
  repository_owner                 TEXT,
  repository_name                  TEXT,
  plan_id                          TEXT,
  source_connection_id             TEXT,
  deployment_id                    TEXT,
  target_deployment_id             TEXT,
  target_revision_id               TEXT,
  target_artifact_id               TEXT,
  expected_etag                    TEXT,
  cleanup_run_id                   TEXT,
  source_environment_id            TEXT,
  source_deployment_id             TEXT,
  source_revision_id               TEXT,
  source_artifact_id               TEXT,
  source_artifact_sha256           BLOB CHECK (source_artifact_sha256 IS NULL OR length(source_artifact_sha256) = 32),
  expected_source_head_version     INTEGER,
  expected_target_head_version     INTEGER,
  requested_handle                 TEXT,
  data_change                      TEXT CHECK (data_change IS NULL OR data_change IN ('isolate_prod_keeps_data','isolate_dev_keeps_data','share_prod_keeps_data','reset_dev')),
  data_change_snapshot             TEXT CHECK (data_change_snapshot IS NULL OR json_valid(data_change_snapshot)),
  binding_refresh_snapshot         TEXT CHECK (binding_refresh_snapshot IS NULL OR json_valid(binding_refresh_snapshot)),
  binding_refresh_snapshot_sha256  BLOB CHECK (binding_refresh_snapshot_sha256 IS NULL OR length(binding_refresh_snapshot_sha256) = 32),
  source_generation                INTEGER,
  created_at                       TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, environment_id, operation_id),
  UNIQUE(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type),
  FOREIGN KEY (organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,environment_id) REFERENCES environment_identities(project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,plan_id) REFERENCES deployment_plans(organization_id,project_id,plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,source_connection_id) REFERENCES repository_grants(organization_id,project_id,source_connection_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,operation_id,deployment_id) REFERENCES deployments(organization_id,project_id,operation_id,deployment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,target_deployment_id,target_revision_id) REFERENCES deployment_revisions(organization_id,project_id,deployment_id,revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,target_artifact_id) REFERENCES build_artifacts(organization_id,project_id,artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,operation_id,cleanup_run_id) REFERENCES cleanup_runs(organization_id,project_id,operation_id,cleanup_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,source_environment_id) REFERENCES environments(organization_id,project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,source_deployment_id,source_revision_id) REFERENCES deployment_revisions(organization_id,project_id,deployment_id,revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,project_id,source_artifact_id) REFERENCES build_artifacts(organization_id,project_id,artifact_id) ON DELETE RESTRICT,
  CHECK(source_generation IS NULL OR source_generation BETWEEN 0 AND 2147483647),
  CHECK(expected_source_head_version IS NULL OR expected_source_head_version BETWEEN -2147483648 AND 2147483647),
  CHECK(expected_target_head_version IS NULL OR expected_target_head_version BETWEEN -2147483648 AND 2147483647),
  CHECK((installation_id IS NULL OR (installation_id=trim(installation_id) AND length(installation_id) BETWEEN 1 AND 255))
    AND (repository_owner IS NULL OR (repository_owner=trim(repository_owner) AND length(repository_owner) BETWEEN 1 AND 255))
    AND (repository_name IS NULL OR (repository_name=trim(repository_name) AND length(repository_name) BETWEEN 1 AND 255))
    AND (expected_etag IS NULL OR (expected_etag=trim(expected_etag) AND length(expected_etag) BETWEEN 1 AND 255)))
  ,CHECK(((event_type='SourceLinkRequestedV1' AND installation_id IS NOT NULL AND repository_owner IS NOT NULL AND repository_name IS NOT NULL AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL AND expected_etag IS NULL AND cleanup_run_id IS NULL AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL AND requested_handle IS NULL AND data_change IS NULL AND data_change_snapshot IS NULL)
    OR (event_type='DeploymentRequestedV1' AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL AND plan_id IS NOT NULL AND source_connection_id IS NOT NULL AND deployment_id IS NOT NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL AND expected_etag IS NULL AND cleanup_run_id IS NULL AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL AND requested_handle IS NULL AND data_change IS NULL AND data_change_snapshot IS NULL)
    OR (event_type='DeploymentRollbackRequestedV1' AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NOT NULL AND target_deployment_id IS NOT NULL AND target_revision_id IS NOT NULL AND target_artifact_id IS NOT NULL AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL AND requested_handle IS NULL AND data_change IS NULL AND data_change_snapshot IS NULL)
    OR (event_type='DeploymentPromotionRequestedV1' AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NOT NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL AND source_environment_id IS NOT NULL AND source_deployment_id IS NOT NULL AND source_revision_id IS NOT NULL AND source_artifact_id IS NOT NULL AND source_artifact_sha256 IS NOT NULL AND expected_source_head_version IS NOT NULL AND expected_target_head_version IS NOT NULL AND requested_handle IS NULL AND data_change IS NULL AND data_change_snapshot IS NULL AND length(source_artifact_sha256)=32 AND expected_source_head_version>=0 AND expected_target_head_version>=0)
    OR (event_type='ProjectHandleChangeRequestedV1' AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL AND requested_handle IS NOT NULL AND data_change IS NULL AND data_change_snapshot IS NULL AND length(requested_handle) BETWEEN 3 AND 59 AND requested_handle NOT GLOB '*[^a-z0-9-]*' AND substr(requested_handle,1,1) GLOB '[a-z0-9]' AND substr(requested_handle,-1,1) GLOB '[a-z0-9]' AND requested_handle NOT LIKE '%--%' AND length(requested_handle)-length(replace(requested_handle,'-',''))<=4)
    OR (event_type='ProjectDeletionRequestedV1' AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL AND expected_etag IS NOT NULL AND cleanup_run_id IS NOT NULL AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL AND requested_handle IS NULL AND data_change IS NULL AND data_change_snapshot IS NULL)
    OR (event_type='ProjectDataChangeRequestedV1' AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL AND expected_etag IS NOT NULL AND cleanup_run_id IS NOT NULL AND source_environment_id IS NULL AND source_deployment_id IS NULL AND source_revision_id IS NULL AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL AND requested_handle IS NULL AND data_change IS NOT NULL AND data_change_snapshot IS NOT NULL AND json_type(data_change_snapshot)='object' AND json_type(data_change_snapshot,'$.transition')='object' AND json_type(data_change_snapshot,'$.environmentHeads')='array' AND json_array_length(data_change_snapshot,'$.environmentHeads')=2 AND json_type(data_change_snapshot,'$.registrationGenerations')='array')) IS TRUE)
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX product_command_intents_original_identity ON product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type);
CREATE TRIGGER product_command_intents_no_update BEFORE UPDATE ON product_command_intents
BEGIN SELECT RAISE(ABORT,'product_command_intents is append-only'); END;
CREATE TRIGGER product_command_intents_no_delete BEFORE DELETE ON product_command_intents
BEGIN SELECT RAISE(ABORT,'product_command_intents is append-only'); END;
-- Equivalent original jsonb key-set checks use SELECT predicates, not JSON normalization or value rewriting.
CREATE TRIGGER product_command_intents_data_snapshot_shape BEFORE INSERT ON product_command_intents
WHEN NEW.data_change_snapshot IS NOT NULL AND ((SELECT count(*) FROM json_each(NEW.data_change_snapshot))<>3
  OR EXISTS(SELECT 1 FROM json_each(NEW.data_change_snapshot) WHERE key NOT IN ('transition','environmentHeads','registrationGenerations')))
BEGIN SELECT RAISE(ABORT,'product data change snapshot keys differ'); END;
CREATE TRIGGER product_command_intents_original_ulids BEFORE INSERT ON product_command_intents
WHEN (NEW.organization_id IS NOT NULL AND (length(NEW.organization_id)<>26 OR NEW.organization_id NOT GLOB '[0-7]*' OR NEW.organization_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.project_id IS NOT NULL AND (length(NEW.project_id)<>26 OR NEW.project_id NOT GLOB '[0-7]*' OR NEW.project_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.environment_id IS NOT NULL AND (length(NEW.environment_id)<>26 OR NEW.environment_id NOT GLOB '[0-7]*' OR NEW.environment_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.operation_id IS NOT NULL AND (length(NEW.operation_id)<>26 OR NEW.operation_id NOT GLOB '[0-7]*' OR NEW.operation_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.billing_epoch_id IS NOT NULL AND (length(NEW.billing_epoch_id)<>26 OR NEW.billing_epoch_id NOT GLOB '[0-7]*' OR NEW.billing_epoch_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.plan_id IS NOT NULL AND (length(NEW.plan_id)<>26 OR NEW.plan_id NOT GLOB '[0-7]*' OR NEW.plan_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.source_connection_id IS NOT NULL AND (length(NEW.source_connection_id)<>26 OR NEW.source_connection_id NOT GLOB '[0-7]*' OR NEW.source_connection_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.deployment_id IS NOT NULL AND (length(NEW.deployment_id)<>26 OR NEW.deployment_id NOT GLOB '[0-7]*' OR NEW.deployment_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.target_deployment_id IS NOT NULL AND (length(NEW.target_deployment_id)<>26 OR NEW.target_deployment_id NOT GLOB '[0-7]*' OR NEW.target_deployment_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.target_revision_id IS NOT NULL AND (length(NEW.target_revision_id)<>26 OR NEW.target_revision_id NOT GLOB '[0-7]*' OR NEW.target_revision_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.target_artifact_id IS NOT NULL AND (length(NEW.target_artifact_id)<>26 OR NEW.target_artifact_id NOT GLOB '[0-7]*' OR NEW.target_artifact_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.cleanup_run_id IS NOT NULL AND (length(NEW.cleanup_run_id)<>26 OR NEW.cleanup_run_id NOT GLOB '[0-7]*' OR NEW.cleanup_run_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.source_environment_id IS NOT NULL AND (length(NEW.source_environment_id)<>26 OR NEW.source_environment_id NOT GLOB '[0-7]*' OR NEW.source_environment_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.source_deployment_id IS NOT NULL AND (length(NEW.source_deployment_id)<>26 OR NEW.source_deployment_id NOT GLOB '[0-7]*' OR NEW.source_deployment_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.source_revision_id IS NOT NULL AND (length(NEW.source_revision_id)<>26 OR NEW.source_revision_id NOT GLOB '[0-7]*' OR NEW.source_revision_id GLOB '*[^0-9A-HJKMNP-TV-Z]*')) OR
  (NEW.source_artifact_id IS NOT NULL AND (length(NEW.source_artifact_id)<>26 OR NEW.source_artifact_id NOT GLOB '[0-7]*' OR NEW.source_artifact_id GLOB '*[^0-9A-HJKMNP-TV-Z]*'))
BEGIN SELECT RAISE(ABORT,'product intent original ulid is invalid'); END;

-- Original valid_binding_refresh_snapshot and the source-plan/deployment self-scope check.
CREATE TRIGGER product_binding_refresh_snapshot_original_shape BEFORE INSERT ON product_command_intents
WHEN NEW.binding_refresh_snapshot IS NOT NULL AND (
  NEW.event_type<>'DeploymentRequestedV1'
  OR json_type(NEW.binding_refresh_snapshot)<>'object'
  OR (SELECT count(*) FROM json_each(NEW.binding_refresh_snapshot))<>15
  OR EXISTS(SELECT 1 FROM json_each(NEW.binding_refresh_snapshot) WHERE key NOT IN ('sourceDeploymentId','sourceRevisionId','sourceCandidateReceiptId','sourceArtifactId','sourcePlanId','sourceBuildExecutionId','sourceArtifactSha256','sourceNamespace','sourceScriptName','sourceProviderTag','expectedHeadVersion','expectedGatewayRevision','dataEnvironmentId','assignmentVersion','registrationVersion'))
  OR json_type(NEW.binding_refresh_snapshot,'$.sourceDeploymentId') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.sourceDeploymentId'))<>26
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceDeploymentId') NOT GLOB '[0-7]*'
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceDeploymentId') GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.sourceRevisionId') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.sourceRevisionId'))<>26
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceRevisionId') NOT GLOB '[0-7]*'
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceRevisionId') GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.sourceCandidateReceiptId') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.sourceCandidateReceiptId'))<>26
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceCandidateReceiptId') NOT GLOB '[0-7]*'
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceCandidateReceiptId') GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.sourceArtifactId') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.sourceArtifactId'))<>26
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceArtifactId') NOT GLOB '[0-7]*'
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceArtifactId') GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.sourcePlanId') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.sourcePlanId'))<>26
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourcePlanId') NOT GLOB '[0-7]*'
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourcePlanId') GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.sourceBuildExecutionId') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.sourceBuildExecutionId'))<>26
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceBuildExecutionId') NOT GLOB '[0-7]*'
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceBuildExecutionId') GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.dataEnvironmentId') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.dataEnvironmentId'))<>26
  OR json_extract(NEW.binding_refresh_snapshot,'$.dataEnvironmentId') NOT GLOB '[0-7]*'
  OR json_extract(NEW.binding_refresh_snapshot,'$.dataEnvironmentId') GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.sourceArtifactSha256') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.sourceArtifactSha256'))<>64
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceArtifactSha256') GLOB '*[^a-f0-9]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.sourceProviderTag') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.sourceProviderTag'))<>32
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceProviderTag') GLOB '*[^a-f0-9]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.sourceNamespace') IS NOT 'text'
  OR length(json_extract(NEW.binding_refresh_snapshot,'$.sourceNamespace')) NOT BETWEEN 1 AND 64
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceNamespace') GLOB '*[^a-z0-9-]*'
  OR json_type(NEW.binding_refresh_snapshot,'$.sourceScriptName') IS NOT 'text'
  OR NOT(substr(json_extract(NEW.binding_refresh_snapshot,'$.sourceScriptName'),1,2)='p-' AND substr(json_extract(NEW.binding_refresh_snapshot,'$.sourceScriptName'),3,26) NOT GLOB '*[^0-9a-z]*' AND substr(json_extract(NEW.binding_refresh_snapshot,'$.sourceScriptName'),29,1)='-' AND substr(json_extract(NEW.binding_refresh_snapshot,'$.sourceScriptName'),-26) NOT GLOB '*[^0-9a-z]*' AND ((length(json_extract(NEW.binding_refresh_snapshot,'$.sourceScriptName'))=59 AND substr(json_extract(NEW.binding_refresh_snapshot,'$.sourceScriptName'),30,4)='dev-') OR (length(json_extract(NEW.binding_refresh_snapshot,'$.sourceScriptName'))=60 AND substr(json_extract(NEW.binding_refresh_snapshot,'$.sourceScriptName'),30,5)='prod-')))
  OR json_type(NEW.binding_refresh_snapshot,'$.expectedHeadVersion') NOT IN ('integer','real')
  OR json_extract(NEW.binding_refresh_snapshot,'$.expectedHeadVersion')<1
  OR json_extract(NEW.binding_refresh_snapshot,'$.expectedHeadVersion')>9007199254740991
  OR json_extract(NEW.binding_refresh_snapshot,'$.expectedHeadVersion')<>CAST(json_extract(NEW.binding_refresh_snapshot,'$.expectedHeadVersion') AS INTEGER)
  OR json_type(NEW.binding_refresh_snapshot,'$.expectedGatewayRevision') NOT IN ('integer','real')
  OR json_extract(NEW.binding_refresh_snapshot,'$.expectedGatewayRevision')<1
  OR json_extract(NEW.binding_refresh_snapshot,'$.expectedGatewayRevision')>9007199254740991
  OR json_extract(NEW.binding_refresh_snapshot,'$.expectedGatewayRevision')<>CAST(json_extract(NEW.binding_refresh_snapshot,'$.expectedGatewayRevision') AS INTEGER)
  OR json_type(NEW.binding_refresh_snapshot,'$.assignmentVersion') NOT IN ('integer','real')
  OR json_extract(NEW.binding_refresh_snapshot,'$.assignmentVersion')<1
  OR json_extract(NEW.binding_refresh_snapshot,'$.assignmentVersion')>9007199254740991
  OR json_extract(NEW.binding_refresh_snapshot,'$.assignmentVersion')<>CAST(json_extract(NEW.binding_refresh_snapshot,'$.assignmentVersion') AS INTEGER)
  OR json_type(NEW.binding_refresh_snapshot,'$.registrationVersion') NOT IN ('integer','real')
  OR json_extract(NEW.binding_refresh_snapshot,'$.registrationVersion')<0
  OR json_extract(NEW.binding_refresh_snapshot,'$.registrationVersion')>9007199254740991
  OR json_extract(NEW.binding_refresh_snapshot,'$.registrationVersion')<>CAST(json_extract(NEW.binding_refresh_snapshot,'$.registrationVersion') AS INTEGER)
  -- Preserve original numeric/trunc semantics before SQLite double conversion can round a fractional safe-int edge.
  OR EXISTS(
    WITH tokens AS (
      SELECT key,NEW.binding_refresh_snapshot -> ('$.'||key) AS raw FROM json_each(NEW.binding_refresh_snapshot)
       WHERE key IN ('expectedHeadVersion','expectedGatewayRevision','assignmentVersion','registrationVersion')
    ),parts AS (
      SELECT key,CASE WHEN instr(lower(raw),'e')=0 THEN raw ELSE substr(raw,1,instr(lower(raw),'e')-1) END AS mantissa,
        CASE WHEN instr(lower(raw),'e')=0 THEN 0 ELSE CAST(substr(raw,instr(lower(raw),'e')+1) AS INTEGER) END AS exponent FROM tokens
    ),digits AS (
      SELECT replace(replace(mantissa,'.',''),'-','') AS digits,
        (CASE WHEN instr(mantissa,'.')=0 THEN 0 ELSE length(mantissa)-instr(mantissa,'.') END)-exponent AS scale FROM parts
    ) SELECT 1 FROM digits WHERE scale>0 AND
      replace(substr(digits,CASE WHEN scale>=length(digits) THEN 1 ELSE length(digits)-scale+1 END),'0','')<>''
  )
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourcePlanId')<>NEW.plan_id
  OR json_extract(NEW.binding_refresh_snapshot,'$.sourceDeploymentId')=NEW.deployment_id)
BEGIN SELECT RAISE(ABORT,'binding refresh snapshot is invalid'); END;

INSERT INTO product_command_intents SELECT * FROM _0451_product_intents;
CREATE TABLE product_workflow_runs (
  organization_id TEXT NOT NULL, operation_id TEXT NOT NULL, event_type TEXT NOT NULL,
  workflow_id TEXT NOT NULL CHECK(workflow_id=trim(workflow_id) AND length(workflow_id) BETWEEN 1 AND 255),
  event_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, billing_epoch_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','reconciliation_required','completed')),
  terminal_evidence TEXT CHECK(terminal_evidence IS NULL OR json_valid(terminal_evidence)),
  intermediate_evidence TEXT CHECK(intermediate_evidence IS NULL OR json_valid(intermediate_evidence)),
  evidence_archive_key TEXT, reconciliation_code TEXT,
  active_reconciliation_attempt_id TEXT, active_replay_attempt_id TEXT,
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at>=created_at),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(workflow_id),
  UNIQUE(workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type),
  UNIQUE(organization_id,project_id,environment_id,operation_id),
  FOREIGN KEY(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type)
    REFERENCES product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type),
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
  FOREIGN KEY(event_id,organization_id,project_id,operation_id,billing_epoch_id)
    REFERENCES outbox_events(event_id,organization_id,project_id,operation_id,billing_epoch_id),
  FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
  CHECK(event_type IN ('SourceLinkRequestedV1','DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1','ProjectDeletionRequestedV1','ProjectDataChangeRequestedV1','ProjectHandleChangeRequestedV1')),
  CHECK((state='queued' AND terminal_evidence IS NULL AND reconciliation_code IS NULL AND completed_at IS NULL)
    OR (state='completed' AND json_type(terminal_evidence)='object' AND reconciliation_code IS NULL AND completed_at IS NOT NULL)
    OR (state='reconciliation_required' AND terminal_evidence IS NULL AND reconciliation_code=trim(reconciliation_code) AND length(reconciliation_code) BETWEEN 1 AND 128 AND completed_at IS NULL))
) STRICT, WITHOUT ROWID;

INSERT INTO product_workflow_runs SELECT * FROM _0451_workflow_runs;
DROP TABLE _0451_workflow_runs;
DROP TABLE _0451_product_intents;
