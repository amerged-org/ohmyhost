-- Original062/069/144 immutable staged delivery and terminal evidence. No initializer or runtime activation.
-- Typed TEXT[] is represented as JSON arrays; history retains its original nullable legacy gateway/scope fields.
CREATE TABLE runtime_secret_delivery_stages (
  stage_receipt_id TEXT NOT NULL CHECK(length(stage_receipt_id)=26 AND substr(stage_receipt_id,1,1) BETWEEN '0' AND '7' AND stage_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  operation_id TEXT NOT NULL CHECK(length(operation_id)=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  product_deployment_id TEXT NOT NULL CHECK(length(product_deployment_id)=26 AND substr(product_deployment_id,1,1) BETWEEN '0' AND '7' AND product_deployment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  candidate_receipt_id TEXT NOT NULL CHECK(length(candidate_receipt_id)=26 AND substr(candidate_receipt_id,1,1) BETWEEN '0' AND '7' AND candidate_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  lease_id TEXT NOT NULL CHECK(length(lease_id)=26 AND substr(lease_id,1,1) BETWEEN '0' AND '7' AND lease_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  generation INTEGER NOT NULL CHECK(generation>=0),
  release_sequence INTEGER NOT NULL CHECK(release_sequence>0),
  trigger TEXT NOT NULL CHECK(trigger IN ('deploy','rollback','promotion','reconcile')),
  provider_tag TEXT NOT NULL CHECK(length(provider_tag) BETWEEN 1 AND 128 AND substr(provider_tag,1,1) GLOB '[A-Za-z0-9]' AND provider_tag NOT GLOB '*[^A-Za-z0-9._:/-]*'),
  applied_secret_names TEXT NOT NULL CHECK(json_valid(applied_secret_names) AND json_type(applied_secret_names)='array'),
  manifest_sha256 BLOB NOT NULL CHECK(length(manifest_sha256)=32),
  manifest_secret_count INTEGER NOT NULL CHECK(manifest_secret_count BETWEEN 0 AND 100),
  staged_at TEXT NOT NULL CHECK(staged_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(stage_receipt_id), UNIQUE(lease_id),
  -- Original069 deliberately removes operation_id: a rollback stages an existing candidate under its new operation.
  FOREIGN KEY(organization_id,project_id,environment_id,candidate_receipt_id,product_deployment_id)
    REFERENCES wfp_candidate_receipts(organization_id,project_id,environment_id,candidate_receipt_id,product_deployment_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER runtime_secret_delivery_stages_names BEFORE INSERT ON runtime_secret_delivery_stages
WHEN NEW.manifest_secret_count<>(SELECT count(*) FROM json_tree(NEW.applied_secret_names) WHERE type<>'array')
 OR EXISTS(SELECT 1 FROM json_tree(NEW.applied_secret_names) WHERE type NOT IN ('array','text','null'))
BEGIN SELECT RAISE(ABORT,'Runtime secret stage names/cardinality are invalid'); END;
CREATE TRIGGER runtime_secret_delivery_stages_no_update BEFORE UPDATE ON runtime_secret_delivery_stages
BEGIN SELECT RAISE(ABORT,'Runtime secret stages are append-only'); END;
CREATE TRIGGER runtime_secret_delivery_stages_no_delete BEFORE DELETE ON runtime_secret_delivery_stages
BEGIN SELECT RAISE(ABORT,'Runtime secret stages are append-only'); END;
CREATE TABLE runtime_secret_delivery_stage_activations (
  activation_receipt_id TEXT NOT NULL CHECK(length(activation_receipt_id)=26 AND substr(activation_receipt_id,1,1) BETWEEN '0' AND '7' AND activation_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  stage_receipt_id TEXT NOT NULL CHECK(length(stage_receipt_id)=26 AND substr(stage_receipt_id,1,1) BETWEEN '0' AND '7' AND stage_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  gateway_version_id TEXT,
  gateway_deployment_id TEXT,
  activated_at TEXT NOT NULL CHECK(activated_at GLOB '????-??-??T??:??:??.??????Z'),
  organization_id TEXT CHECK(organization_id IS NULL OR (length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  project_id TEXT CHECK(project_id IS NULL OR (length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  environment_id TEXT CHECK(environment_id IS NULL OR (length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  shared_gateway_revision INTEGER,
  PRIMARY KEY(activation_receipt_id), UNIQUE(stage_receipt_id),
  FOREIGN KEY(stage_receipt_id) REFERENCES runtime_secret_delivery_stages(stage_receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,environment_id,shared_gateway_revision)
    REFERENCES shared_gateway_route_revisions(organization_id,project_id,environment_id,revision)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER runtime_secret_delivery_stage_activations_no_update BEFORE UPDATE ON runtime_secret_delivery_stage_activations
BEGIN SELECT RAISE(ABORT,'Runtime secret activations are append-only'); END;
CREATE TRIGGER runtime_secret_delivery_stage_activations_no_delete BEFORE DELETE ON runtime_secret_delivery_stage_activations
BEGIN SELECT RAISE(ABORT,'Runtime secret activations are append-only'); END;
CREATE TABLE runtime_secret_delivery_stage_compensations (
  compensation_receipt_id TEXT NOT NULL CHECK(length(compensation_receipt_id)=26 AND substr(compensation_receipt_id,1,1) BETWEEN '0' AND '7' AND compensation_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  stage_receipt_id TEXT NOT NULL CHECK(length(stage_receipt_id)=26 AND substr(stage_receipt_id,1,1) BETWEEN '0' AND '7' AND stage_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  failure_code TEXT NOT NULL CHECK(length(failure_code) BETWEEN 1 AND 64 AND substr(failure_code,1,1) GLOB '[A-Z]' AND failure_code NOT GLOB '*[^A-Z0-9_]*'),
  compensated_at TEXT NOT NULL CHECK(compensated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(compensation_receipt_id), UNIQUE(stage_receipt_id),
  FOREIGN KEY(stage_receipt_id) REFERENCES runtime_secret_delivery_stages(stage_receipt_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER runtime_secret_delivery_stage_compensations_no_update BEFORE UPDATE ON runtime_secret_delivery_stage_compensations
BEGIN SELECT RAISE(ABORT,'Runtime secret compensations are append-only'); END;
CREATE TRIGGER runtime_secret_delivery_stage_compensations_no_delete BEFORE DELETE ON runtime_secret_delivery_stage_compensations
BEGIN SELECT RAISE(ABORT,'Runtime secret compensations are append-only'); END;
CREATE TRIGGER runtime_secret_delivery_stage_activation_terminal_check BEFORE INSERT ON runtime_secret_delivery_stage_activations
WHEN EXISTS(SELECT 1 FROM runtime_secret_delivery_stage_compensations WHERE stage_receipt_id=NEW.stage_receipt_id)
BEGIN SELECT RAISE(ABORT,'Compensated runtime secret stage cannot activate'); END;
CREATE TRIGGER runtime_secret_delivery_stage_compensation_terminal_check BEFORE INSERT ON runtime_secret_delivery_stage_compensations
WHEN EXISTS(SELECT 1 FROM runtime_secret_delivery_stage_activations WHERE stage_receipt_id=NEW.stage_receipt_id)
BEGIN SELECT RAISE(ABORT,'Activated runtime secret stage cannot compensate'); END;

-- Only this exact historical family joins0362. No Runtime RPC opens loading; an ever-activated Core cannot reopen.
DROP TRIGGER core_historical_import_open;
CREATE TRIGGER core_historical_import_open BEFORE INSERT ON core_historical_import
BEGIN
  SELECT RAISE(ABORT, 'an ever-activated authority can never open historical import')
    WHERE EXISTS (SELECT 1 FROM core_authority_activation);
  SELECT RAISE(ABORT, 'historical import begins loading, never already qualified')
    WHERE NEW.closed_at IS NOT NULL OR NEW.comparison_sha256 IS NOT NULL OR NEW.restored_runtime_schema_sha256 IS NOT NULL;
  SELECT RAISE(ABORT, 'historical temporal admission has a closed exact table allowlist')
    WHERE EXISTS (SELECT 1 FROM json_each(NEW.temporal_tables)
      WHERE type <> 'text' OR value NOT IN ('wfp_candidate_receipts','wfp_candidate_cleanup_receipts','wfp_publish_receipts','wfp_rollback_activation_receipts','runtime_secret_delivery_stage_activations'))
      OR (SELECT count(*) FROM json_each(NEW.temporal_tables))
        <> (SELECT count(DISTINCT value) FROM json_each(NEW.temporal_tables));
END;

-- Native static CHECK/FKs and mutual-terminal/append guards ALWAYS apply. Original144's legacy backfill disabled
-- the INSERT trigger, retained old gateway strings and could bind a rollback stage to candidate-operation route1.
-- Those bytes are history, not a new live operation equality. Only the exact attested unserved family bypasses
-- the live predicate below. Live Core writers supply scope from the exact stage, as originalPG's trigger did.
CREATE TRIGGER shared_gateway_stage_activation BEFORE INSERT ON runtime_secret_delivery_stage_activations
WHEN NOT(NOT EXISTS(SELECT 1 FROM core_authority_activation) AND EXISTS(
 SELECT 1 FROM core_historical_import historical,json_each(historical.temporal_tables) allowed
 WHERE historical.closed_at IS NULL AND allowed.value='runtime_secret_delivery_stage_activations'))
 AND NOT(NEW.gateway_version_id IS NULL AND NEW.gateway_deployment_id IS NULL AND EXISTS(
 SELECT 1 FROM runtime_secret_delivery_stages stage
 JOIN environments environment ON environment.organization_id=stage.organization_id AND environment.project_id=stage.project_id AND environment.environment_id=stage.environment_id
 JOIN projects project ON project.organization_id=stage.organization_id AND project.project_id=stage.project_id AND project.lifecycle_state='active'
 JOIN cloudflare_project_domains domain ON domain.organization_id=stage.organization_id AND domain.project_id=stage.project_id AND domain.deleted_at IS NULL AND domain.handle=project.handle
 JOIN shared_gateway_route_revisions route ON route.organization_id=stage.organization_id AND route.project_id=stage.project_id AND route.environment_id=stage.environment_id
   AND route.revision=NEW.shared_gateway_revision AND route.active=1 AND route.candidate_receipt_id=stage.candidate_receipt_id AND route.operation_id=stage.operation_id
 JOIN wfp_candidate_receipts candidate ON candidate.organization_id=route.organization_id AND candidate.project_id=route.project_id AND candidate.environment_id=route.environment_id AND candidate.candidate_receipt_id=route.candidate_receipt_id
 WHERE stage.stage_receipt_id=NEW.stage_receipt_id AND NEW.organization_id=stage.organization_id AND NEW.project_id=stage.project_id AND NEW.environment_id=stage.environment_id
 AND route.handle=project.handle AND route.public_origin='https://'||CASE environment.name WHEN 'dev' THEN domain.development_domain ELSE domain.production_domain END
 AND CASE WHEN domain.production_domain=project.handle||'.check.omh.st' THEN candidate.dispatch_namespace='ohmyho-production' ELSE candidate.dispatch_namespace IN ('sandbox','ohmyho-sandbox','ohmyho-poc-private-fullstack') END
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=stage.candidate_receipt_id)
 AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions newer WHERE newer.organization_id=route.organization_id AND newer.project_id=route.project_id AND newer.environment_id=route.environment_id AND newer.revision>route.revision)))
BEGIN SELECT RAISE(ABORT,'Secret activation requires its exact current stage and shared gateway'); END;
