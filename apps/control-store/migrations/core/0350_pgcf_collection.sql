-- Native provider observations and collection progress (original204/197/227), never monetary authority.
CREATE TABLE pgcf_usage_hours (
  provider_project_id TEXT NOT NULL, database_id TEXT NOT NULL,
  hour_start TEXT NOT NULL CHECK(hour_start GLOB '????-??-??T??:00:00.000000Z'),
  hour_end TEXT NOT NULL CHECK(hour_end = strftime('%Y-%m-%dT%H:00:00.000000Z',hour_start,'+1 hour')),
  final INTEGER NOT NULL CHECK(final IN(0,1)),
  raw_metrics TEXT NOT NULL CHECK(json_valid(raw_metrics) AND json_type(raw_metrics)='object'),
  gaps TEXT NOT NULL CHECK(json_valid(gaps) AND json_type(gaps)='array'),
  memory_mib_milliseconds INTEGER CHECK(memory_mib_milliseconds>=0),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  organization_id TEXT, project_id TEXT, environment_id TEXT, billing_epoch_id TEXT,
  scope TEXT NOT NULL CHECK(scope IN('customer','platform','unattributed','before_activation')),
  PRIMARY KEY(provider_project_id,database_id,hour_start),
  CHECK((scope='customer')=(organization_id IS NOT NULL AND project_id IS NOT NULL AND billing_epoch_id IS NOT NULL)),
  CHECK(memory_mib_milliseconds IS NULL OR final=1)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pgcf_usage_hours_quantity_insert BEFORE INSERT ON pgcf_usage_hours
WHEN NEW.memory_mib_milliseconds IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(NEW.gaps) WHERE value IN('memory_mib_seconds','lifecycle','resource_snapshot','rollup_pending'))
BEGIN SELECT RAISE(ABORT,'PGCF memory requires complete final evidence'); END;
CREATE TRIGGER pgcf_usage_hours_quantity_update BEFORE UPDATE ON pgcf_usage_hours
WHEN NEW.memory_mib_milliseconds IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(NEW.gaps) WHERE value IN('memory_mib_seconds','lifecycle','resource_snapshot','rollup_pending'))
BEGIN SELECT RAISE(ABORT,'PGCF memory requires complete final evidence'); END;
CREATE TRIGGER pgcf_usage_hours_final BEFORE UPDATE ON pgcf_usage_hours WHEN OLD.final=1
BEGIN SELECT RAISE(ABORT,'Final PGCF usage must be retained'); END;
CREATE TRIGGER pgcf_usage_hours_no_delete BEFORE DELETE ON pgcf_usage_hours
BEGIN SELECT RAISE(ABORT,'Final PGCF usage must be retained'); END;

CREATE TABLE pgcf_collection_cursors (
  provider_project_id TEXT NOT NULL PRIMARY KEY,
  completed_through TEXT NOT NULL CHECK(completed_through GLOB '????-??-??T??:00:00.000000Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
CREATE TABLE pgcf_platform_database_activations (
  provider_project_id TEXT NOT NULL CHECK(length(provider_project_id)=24 AND provider_project_id GLOB 'prj_*' AND substr(provider_project_id,5) NOT GLOB '*[^a-z0-9]*'),
  database_id TEXT NOT NULL CHECK(length(database_id)=20 AND substr(database_id,1,1) GLOB '[a-z]' AND database_id NOT GLOB '*[^a-z0-9]*'),
  activated_at TEXT NOT NULL CHECK(activated_at GLOB '????-??-??T??:??:??.??????Z'),
  manifest_sha256 BLOB NOT NULL CHECK(length(manifest_sha256)=32),
  recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(provider_project_id,database_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pgcf_platform_activations_no_update BEFORE UPDATE ON pgcf_platform_database_activations
BEGIN SELECT RAISE(ABORT,'Platform activation is append-only'); END;
CREATE TRIGGER pgcf_platform_activations_no_delete BEFORE DELETE ON pgcf_platform_database_activations
BEGIN SELECT RAISE(ABORT,'Platform activation is append-only'); END;

-- Typed collection attempt/page receipts replace the original caller's volatile page-ACK set. They contain no price.
-- A page is acknowledged only after its raw facts and every eligible task are durable. Cursor completion checks the chain.
CREATE TABLE pgcf_collection_runs (
  run_id TEXT PRIMARY KEY CHECK(length(run_id)=26 AND run_id GLOB '[0-7]*' AND run_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  provider_project_id TEXT NOT NULL,
  from_hour TEXT NOT NULL CHECK(from_hour GLOB '????-??-??T??:00:00.000000Z'),
  through_hour TEXT NOT NULL CHECK(through_hour GLOB '????-??-??T??:00:00.000000Z' AND through_hour>from_hour),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  expected_members TEXT NOT NULL CHECK(json_valid(expected_members) AND json_type(expected_members)='array'),
  platform_databases TEXT NOT NULL CHECK(json_valid(platform_databases) AND json_type(platform_databases)='array'),
  scope_fingerprint TEXT NOT NULL CHECK(length(scope_fingerprint)=64),
  scope_document TEXT NOT NULL CHECK(json_valid(scope_document)),
  state TEXT NOT NULL CHECK(state IN('collecting','completed')),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  CHECK((state='completed')=(completed_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pgcf_collection_run_identity BEFORE UPDATE ON pgcf_collection_runs
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.provider_project_id IS NOT OLD.provider_project_id OR NEW.from_hour IS NOT OLD.from_hour
  OR NEW.through_hour IS NOT OLD.through_hour OR NEW.observed_at IS NOT OLD.observed_at OR NEW.expected_members IS NOT OLD.expected_members
  OR NEW.platform_databases IS NOT OLD.platform_databases OR NEW.scope_fingerprint IS NOT OLD.scope_fingerprint OR NEW.scope_document IS NOT OLD.scope_document OR OLD.state='completed'
BEGIN SELECT RAISE(ABORT,'Collection run identity is immutable'); END;
CREATE TRIGGER pgcf_collection_run_no_delete BEFORE DELETE ON pgcf_collection_runs
BEGIN SELECT RAISE(ABORT,'Collection run evidence must be retained'); END;
CREATE TABLE pgcf_collection_page_receipts (
  run_id TEXT NOT NULL REFERENCES pgcf_collection_runs(run_id), cursor_key TEXT NOT NULL,
  next_cursor TEXT, rows_sha256 TEXT NOT NULL CHECK(length(rows_sha256)=64),
  members TEXT NOT NULL CHECK(json_valid(members) AND json_type(members)='array'),
  acknowledged_at TEXT NOT NULL CHECK(acknowledged_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(run_id,cursor_key)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pgcf_collection_page_no_update BEFORE UPDATE ON pgcf_collection_page_receipts
BEGIN SELECT RAISE(ABORT,'Collection page acknowledgement is immutable'); END;
CREATE TRIGGER pgcf_collection_page_no_delete BEFORE DELETE ON pgcf_collection_page_receipts
BEGIN SELECT RAISE(ABORT,'Collection page acknowledgement is immutable'); END;
