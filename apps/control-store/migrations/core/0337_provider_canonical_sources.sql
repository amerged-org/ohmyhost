-- Original raw provider authority:047/058/083/096/097/101/106/108/109/180/192.
-- Hints remain unpriced metadata. Raw observations are append-only, full int8 and six-digit instants.
CREATE TABLE project_r2_bucket_receipts (
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'), project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(length(operation_id)=26 AND operation_id GLOB '[0-7]*' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'), claim_id TEXT NOT NULL CHECK(length(claim_id)=26 AND claim_id GLOB '[0-7]*' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  bucket_name TEXT NOT NULL UNIQUE, provider_bucket_id TEXT NOT NULL UNIQUE,
  jurisdiction TEXT NOT NULL CHECK(jurisdiction IN ('eu','us')),
  storage_class TEXT NOT NULL CHECK(storage_class='Standard'), public_access INTEGER NOT NULL CHECK(public_access=0),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,environment_id),
  FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id) ON DELETE RESTRICT,
  CHECK(bucket_name='ohmyho-'||lower(project_id)||'-'||lower(environment_id)
    AND length(provider_bucket_id)=32 AND provider_bucket_id NOT GLOB '*[^0-9a-f]*')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER project_r2_bucket_receipts_no_update BEFORE UPDATE ON project_r2_bucket_receipts
BEGIN SELECT RAISE(ABORT,'R2 bucket receipts are append-only'); END;
CREATE TRIGGER project_r2_bucket_receipts_no_delete BEFORE DELETE ON project_r2_bucket_receipts
BEGIN SELECT RAISE(ABORT,'R2 bucket receipts are append-only'); END;

CREATE TABLE neon_consumption_observations (
  provider_organization_id TEXT NOT NULL CHECK(length(provider_organization_id) BETWEEN 5 AND 60
    AND substr(provider_organization_id,1,4)='org-' AND substr(provider_organization_id,5) NOT GLOB '*[^a-z0-9-]*'),
  provider_project_id TEXT NOT NULL CHECK(length(provider_project_id) BETWEEN 1 AND 60 AND provider_project_id NOT GLOB '*[^a-z0-9-]*'),
  period_id TEXT NOT NULL CHECK(length(period_id)=36 AND period_id GLOB '????????-????-????-????-????????????' AND length(replace(period_id,'-',''))=32 AND replace(period_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  period_plan TEXT NOT NULL CHECK(length(period_plan) BETWEEN 1 AND 64 AND period_plan GLOB '[a-z]*' AND period_plan NOT GLOB '*[^a-z0-9_-]*'),
  period_start TEXT NOT NULL CHECK(period_start GLOB '????-??-??T??:??:??.??????Z'),
  timeframe_start TEXT NOT NULL CHECK(timeframe_start GLOB '????-??-??T??:??:??.??????Z'),
  timeframe_end TEXT NOT NULL CHECK(timeframe_end GLOB '????-??-??T??:??:??.??????Z'),
  metric TEXT NOT NULL CHECK(metric IN ('compute_unit_seconds','root_branch_bytes_month','child_branch_bytes_month','instant_restore_bytes_month','snapshot_storage_bytes_month','public_network_transfer_bytes','private_network_transfer_bytes','extra_branches_month')),
  unit TEXT NOT NULL CHECK(unit IN ('cu_second','byte_month','byte','branch_hour')),
  quantity INTEGER NOT NULL CHECK(quantity>=0), list_cost_micros INTEGER CHECK(list_cost_micros>=0), cost_basis_version TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('platform','project_shared','project_environment','unattributed')),
  organization_id TEXT REFERENCES organizations(organization_id), project_id TEXT REFERENCES project_identities(project_id),
  billing_epoch_id TEXT, environment_ids TEXT NOT NULL CHECK(json_valid(environment_ids) AND json_type(environment_ids)='array'),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(provider_organization_id,provider_project_id,period_id,timeframe_start,metric,observed_at),
  FOREIGN KEY(organization_id,project_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,project_id,billing_epoch_id),
  CHECK(timeframe_end=strftime('%Y-%m-%dT%H:%M:%S',timeframe_start,'+1 hour')||substr(timeframe_start,20)
    AND period_start<timeframe_end AND observed_at>=timeframe_end),
  CHECK((scope='project_shared' AND organization_id IS NOT NULL AND project_id IS NOT NULL AND billing_epoch_id IS NOT NULL AND json_array_length(environment_ids)=2)
    OR (scope='project_environment' AND organization_id IS NOT NULL AND project_id IS NOT NULL AND billing_epoch_id IS NOT NULL AND json_array_length(environment_ids)=1 AND json_extract(environment_ids,'$[0]') IS NOT NULL)
    OR (scope='platform' AND organization_id IS NULL AND project_id IS NULL AND billing_epoch_id IS NULL AND json_array_length(environment_ids)=0)
    OR (scope='unattributed' AND organization_id IS NULL AND billing_epoch_id IS NULL AND json_array_length(environment_ids)=0))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER neon_consumption_environment_ids BEFORE INSERT ON neon_consumption_observations
WHEN EXISTS(SELECT 1 FROM json_each(NEW.environment_ids) WHERE type<>'null' AND
  (type<>'text' OR length(value)<>26 OR value NOT GLOB '[0-7]*' OR value GLOB '*[^0-9A-HJKMNP-TV-Z]*'))
BEGIN SELECT RAISE(ABORT,'Neon environment identities are ULIDs'); END;
CREATE TRIGGER neon_consumption_no_update BEFORE UPDATE ON neon_consumption_observations
BEGIN SELECT RAISE(ABORT,'Neon consumption is append-only'); END;
CREATE TRIGGER neon_consumption_no_delete BEFORE DELETE ON neon_consumption_observations
BEGIN SELECT RAISE(ABORT,'Neon consumption is append-only'); END;

CREATE TABLE r2_consumption_observations (
  account_id TEXT NOT NULL CHECK(length(account_id)=32 AND account_id NOT GLOB '*[^0-9a-f]*'),
  bucket_name TEXT NOT NULL REFERENCES project_r2_bucket_receipts(bucket_name),
  jurisdiction TEXT NOT NULL CHECK(jurisdiction IN ('eu','us')),
  timeframe_start TEXT NOT NULL CHECK(timeframe_start GLOB '????-??-??T??:??:??.??????Z'),
  timeframe_end TEXT NOT NULL CHECK(timeframe_end GLOB '????-??-??T??:??:??.??????Z'),
  meter TEXT NOT NULL CHECK(meter IN ('r2.storage.standard','r2.storage.observed','r2.class_a','r2.class_b')),
  unit TEXT NOT NULL CHECK(unit IN ('byte_peak_day','request')), quantity INTEGER NOT NULL CHECK(quantity>=0),
  exact INTEGER NOT NULL CHECK(exact IN (0,1)), project_id TEXT NOT NULL REFERENCES project_identities(project_id),
  organization_id TEXT, environment_id TEXT, billing_epoch_id TEXT,
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(account_id,bucket_name,jurisdiction,timeframe_start,meter,observed_at),
  FOREIGN KEY(organization_id,project_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,project_id,billing_epoch_id),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id),
  CHECK((organization_id IS NULL AND billing_epoch_id IS NULL AND environment_id IS NULL) OR (organization_id IS NOT NULL AND billing_epoch_id IS NOT NULL)),
  CHECK((meter IN ('r2.storage.standard','r2.storage.observed') AND unit='byte_peak_day'
    AND timeframe_start=substr(timeframe_start,1,10)||'T00:00:00.000000Z'
    AND timeframe_end=strftime('%Y-%m-%dT%H:%M:%S',timeframe_start,'+1 day')||substr(timeframe_start,20))
    OR (meter IN ('r2.class_a','r2.class_b') AND unit='request'
      AND timeframe_start=substr(timeframe_start,1,13)||':00:00.000000Z'
      AND timeframe_end=strftime('%Y-%m-%dT%H:%M:%S',timeframe_start,'+1 hour')||substr(timeframe_start,20))),
  CHECK(observed_at>=timeframe_end),CHECK(meter<>'r2.storage.observed' OR NOT exact)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER r2_consumption_no_update BEFORE UPDATE ON r2_consumption_observations
BEGIN SELECT RAISE(ABORT,'R2 consumption is append-only'); END;
CREATE TRIGGER r2_consumption_no_delete BEFORE DELETE ON r2_consumption_observations
BEGIN SELECT RAISE(ABORT,'R2 consumption is append-only'); END;

CREATE TABLE project_database_compute_changes (
  operation_id TEXT NOT NULL PRIMARY KEY CHECK(length(operation_id)=26), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL, data_environment_id TEXT NOT NULL, billing_epoch_id TEXT NOT NULL,
  provider_project_id TEXT NOT NULL CHECK(length(provider_project_id) BETWEEN 1 AND 60 AND provider_project_id NOT GLOB '*[^a-z0-9-]*'),
  default_branch_id TEXT NOT NULL CHECK(length(default_branch_id) BETWEEN 4 AND 60 AND substr(default_branch_id,1,3)='br-' AND substr(default_branch_id,4) NOT GLOB '*[^a-z0-9-]*'),
  endpoint_id TEXT NOT NULL CHECK(length(endpoint_id) BETWEEN 4 AND 60 AND substr(endpoint_id,1,3)='ep-' AND substr(endpoint_id,4) NOT GLOB '*[^a-z0-9-]*'),
  profile TEXT NOT NULL CHECK(profile IN ('free','paid','performance')), compute_units TEXT NOT NULL,
  suspend_timeout_seconds INTEGER NOT NULL, requested_preset TEXT CHECK(requested_preset IN ('standard','performance')),
  requested_at TEXT NOT NULL CHECK(requested_at GLOB '????-??-??T??:??:??.??????Z'),
  claim_id TEXT CHECK(claim_id IS NULL OR (length(claim_id)=36 AND claim_id GLOB '????????-????-????-????-????????????' AND length(replace(claim_id,'-',''))=32 AND replace(claim_id,'-','') NOT GLOB '*[^0-9a-f]*')),claim_expires_at TEXT,
  patch_started_at TEXT,last_attempted_at TEXT,provider_operation_ids TEXT CHECK(provider_operation_ids IS NULL OR (json_valid(provider_operation_ids) AND json_type(provider_operation_ids)='array' AND json_array_length(provider_operation_ids)<=16)),
  provider_observed_at TEXT,completed_at TEXT,failure_code TEXT,
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
  FOREIGN KEY(organization_id,project_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,project_id,billing_epoch_id),
  FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,data_environment_id) REFERENCES neon_project_placement_receipts(organization_id,project_id,environment_id),
  CHECK((profile='free' AND compute_units='0.25' AND suspend_timeout_seconds IN (0,60))
    OR (profile='paid' AND compute_units='0.50' AND suspend_timeout_seconds IN (0,60,120))
    OR (profile='performance' AND compute_units='1.00' AND suspend_timeout_seconds IN (0,300))),
  CHECK((claim_id IS NULL)=(claim_expires_at IS NULL)),CHECK(patch_started_at IS NULL OR patch_started_at>=requested_at),
  CHECK(provider_observed_at IS NULL OR provider_observed_at>=requested_at),
  CHECK(completed_at IS NULL OR (completed_at>=requested_at AND claim_id IS NULL)),
  CHECK(failure_code IS NULL OR (completed_at IS NOT NULL AND failure_code IN ('DATABASE_COMPUTE_FAILED','DATABASE_COMPUTE_PLAN_CHANGED','DATABASE_COMPUTE_REJECTED')))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX project_database_compute_changes_unfinished ON project_database_compute_changes(project_id,data_environment_id) WHERE completed_at IS NULL;
CREATE TRIGGER project_database_compute_changes_no_delete BEFORE DELETE ON project_database_compute_changes
BEGIN SELECT RAISE(ABORT,'Compute change history is retained'); END;
CREATE TRIGGER project_database_compute_changes_guard BEFORE UPDATE ON project_database_compute_changes
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.environment_id IS NOT OLD.environment_id OR NEW.data_environment_id IS NOT OLD.data_environment_id
  OR NEW.billing_epoch_id IS NOT OLD.billing_epoch_id OR NEW.provider_project_id IS NOT OLD.provider_project_id
  OR NEW.default_branch_id IS NOT OLD.default_branch_id OR NEW.endpoint_id IS NOT OLD.endpoint_id OR NEW.profile IS NOT OLD.profile
  OR NEW.compute_units IS NOT OLD.compute_units OR NEW.suspend_timeout_seconds IS NOT OLD.suspend_timeout_seconds
  OR NEW.requested_at IS NOT OLD.requested_at OR NEW.requested_preset IS NOT OLD.requested_preset
  OR (OLD.patch_started_at IS NOT NULL AND NEW.patch_started_at IS NOT OLD.patch_started_at)
  OR (OLD.provider_operation_ids IS NOT NULL AND NEW.provider_operation_ids IS NOT OLD.provider_operation_ids)
  OR (OLD.completed_at IS NOT NULL AND (NEW.claim_id IS NOT OLD.claim_id OR NEW.claim_expires_at IS NOT OLD.claim_expires_at
    OR NEW.patch_started_at IS NOT OLD.patch_started_at OR NEW.last_attempted_at IS NOT OLD.last_attempted_at
    OR NEW.provider_operation_ids IS NOT OLD.provider_operation_ids OR NEW.provider_observed_at IS NOT OLD.provider_observed_at
    OR NEW.completed_at IS NOT OLD.completed_at OR NEW.failure_code IS NOT OLD.failure_code))
BEGIN SELECT RAISE(ABORT,'Compute change identity cannot change'); END;

CREATE VIEW latest_neon_consumption AS SELECT r.* FROM neon_consumption_observations r WHERE NOT EXISTS(SELECT 1 FROM neon_consumption_observations newer WHERE newer.provider_organization_id=r.provider_organization_id AND newer.provider_project_id=r.provider_project_id AND newer.period_id=r.period_id AND newer.timeframe_start=r.timeframe_start AND newer.metric=r.metric AND newer.observed_at>r.observed_at);
CREATE TRIGGER neon_consumption_observations_metering_hint AFTER INSERT ON neon_consumption_observations
BEGIN
  INSERT OR IGNORE INTO organization_metering_work(organization_id) SELECT NEW.organization_id WHERE NEW.organization_id IS NOT NULL;
  INSERT INTO neon_metering_source_hints(provider_organization_id, provider_project_id, period_id, timeframe_start, metric,financial_source_reference,latest_observed_at,routed_organization_id,available_at)
    VALUES(NEW.provider_organization_id, NEW.provider_project_id, NEW.period_id, NEW.timeframe_start, NEW.metric,NEW.provider_organization_id||'/'||NEW.provider_project_id||'/'||NEW.period_id||'/'||substr(NEW.timeframe_start,1,23)||'Z'||'/'||NEW.metric,NEW.observed_at,NEW.organization_id,CASE WHEN NEW.organization_id IS NOT NULL THEN (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') END)
    ON CONFLICT(provider_organization_id, provider_project_id, period_id, timeframe_start, metric) DO UPDATE SET latest_observed_at=excluded.latest_observed_at,
      revision=neon_metering_source_hints.revision+1,routed_organization_id=excluded.routed_organization_id,
      available_at=CASE WHEN excluded.routed_organization_id IS NULL THEN NULL WHEN neon_metering_source_hints.available_at IS NULL THEN excluded.available_at ELSE min(neon_metering_source_hints.available_at,excluded.available_at) END,
      attempts=0,last_failure_code=NULL WHERE neon_metering_source_hints.latest_observed_at<excluded.latest_observed_at;
END;
CREATE TRIGGER neon_metering_source_hints_financial_reference BEFORE INSERT ON neon_metering_source_hints
WHEN NEW.financial_source_reference<>(NEW.provider_organization_id||'/'||NEW.provider_project_id||'/'||NEW.period_id||'/'||substr(NEW.timeframe_start,1,23)||'Z'||'/'||NEW.metric)
BEGIN SELECT RAISE(ABORT,'Provider financial reference must match its exact raw key'); END;
CREATE TRIGGER usage_valuations_neon_hint_wake AFTER INSERT ON usage_valuations WHEN NEW.source_kind='neon'
BEGIN
  SELECT RAISE(ABORT,'Provider financial source matches too many raw source keys')
    WHERE (SELECT count(*) FROM (SELECT 1 FROM neon_metering_source_hints WHERE financial_source_reference=NEW.source_reference AND routed_organization_id IS NOT NULL LIMIT 17))>16;
  UPDATE neon_metering_source_hints SET revision=revision+1,available_at=CASE WHEN available_at IS NULL THEN (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') ELSE min(available_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) END
    WHERE financial_source_reference=NEW.source_reference AND routed_organization_id IS NOT NULL;
END;

CREATE VIEW latest_r2_consumption AS SELECT r.* FROM r2_consumption_observations r WHERE NOT EXISTS(SELECT 1 FROM r2_consumption_observations newer WHERE newer.account_id=r.account_id AND newer.bucket_name=r.bucket_name AND newer.jurisdiction=r.jurisdiction AND newer.timeframe_start=r.timeframe_start AND newer.meter=r.meter AND newer.observed_at>r.observed_at);
CREATE TRIGGER r2_consumption_observations_metering_hint AFTER INSERT ON r2_consumption_observations
BEGIN
  INSERT OR IGNORE INTO organization_metering_work(organization_id) SELECT NEW.organization_id WHERE NEW.organization_id IS NOT NULL;
  INSERT INTO r2_metering_source_hints(account_id, bucket_name, jurisdiction, timeframe_start, meter,financial_source_reference,latest_observed_at,routed_organization_id,available_at)
    VALUES(NEW.account_id, NEW.bucket_name, NEW.jurisdiction, NEW.timeframe_start, NEW.meter,NEW.account_id||'/'||NEW.jurisdiction||'/'||NEW.bucket_name||'/'||substr(NEW.timeframe_start,1,23)||'Z'||'/'||NEW.meter,NEW.observed_at,NEW.organization_id,CASE WHEN NEW.organization_id IS NOT NULL THEN (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') END)
    ON CONFLICT(account_id, bucket_name, jurisdiction, timeframe_start, meter) DO UPDATE SET latest_observed_at=excluded.latest_observed_at,
      revision=r2_metering_source_hints.revision+1,routed_organization_id=excluded.routed_organization_id,
      available_at=CASE WHEN excluded.routed_organization_id IS NULL THEN NULL WHEN r2_metering_source_hints.available_at IS NULL THEN excluded.available_at ELSE min(r2_metering_source_hints.available_at,excluded.available_at) END,
      attempts=0,last_failure_code=NULL WHERE r2_metering_source_hints.latest_observed_at<excluded.latest_observed_at;
END;
CREATE TRIGGER r2_metering_source_hints_financial_reference BEFORE INSERT ON r2_metering_source_hints
WHEN NEW.financial_source_reference<>(NEW.account_id||'/'||NEW.jurisdiction||'/'||NEW.bucket_name||'/'||substr(NEW.timeframe_start,1,23)||'Z'||'/'||NEW.meter)
BEGIN SELECT RAISE(ABORT,'Provider financial reference must match its exact raw key'); END;
CREATE TRIGGER usage_valuations_r2_hint_wake AFTER INSERT ON usage_valuations WHEN NEW.source_kind='r2'
BEGIN
  SELECT RAISE(ABORT,'Provider financial source matches too many raw source keys')
    WHERE (SELECT count(*) FROM (SELECT 1 FROM r2_metering_source_hints WHERE financial_source_reference=NEW.source_reference AND routed_organization_id IS NOT NULL LIMIT 17))>16;
  UPDATE r2_metering_source_hints SET revision=revision+1,available_at=CASE WHEN available_at IS NULL THEN (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') ELSE min(available_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) END
    WHERE financial_source_reference=NEW.source_reference AND routed_organization_id IS NOT NULL;
END;
