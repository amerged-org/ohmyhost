-- Native migration206 parity: an episode belongs to the physical PGCF database and activation, not a size revision.
-- No history is restated. Copy exact prior rows and retain the original target-revision FK; incompatible old facts fail closed.
DROP TRIGGER pgcf_serving_interval_on_head_insert;
DROP TRIGGER pgcf_serving_interval_on_head_update;
DROP TRIGGER pgcf_serving_interval_close_only;
DROP TRIGGER pgcf_serving_interval_no_delete;
ALTER TABLE pgcf_database_serving_intervals RENAME TO pgcf_database_serving_intervals_previous;
CREATE TABLE pgcf_database_serving_intervals (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  target_version           INTEGER NOT NULL,
  provider_project_id      TEXT    NOT NULL,
  database_id              TEXT    NOT NULL,
  started_at               TEXT    NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.??????Z'),
  billable_from            TEXT    NOT NULL CHECK (billable_from = strftime('%Y-%m-%dT%H:00:00.000000Z', substr(started_at,1,13)||':00:00Z', '+1 hour')),
  ended_at                 TEXT    CHECK (ended_at IS NULL OR (ended_at GLOB '????-??-??T??:??:??.??????Z' AND ended_at >= started_at)),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, started_at),
  FOREIGN KEY (organization_id, project_id, physical_environment_id, target_version)
    REFERENCES database_provider_target_revisions (organization_id, project_id, physical_environment_id, target_version)
) STRICT, WITHOUT ROWID;
INSERT INTO pgcf_database_serving_intervals SELECT * FROM pgcf_database_serving_intervals_previous;
DROP TABLE pgcf_database_serving_intervals_previous;
CREATE UNIQUE INDEX pgcf_serving_interval_open_physical ON pgcf_database_serving_intervals (organization_id, project_id, physical_environment_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX pgcf_serving_interval_open_database ON pgcf_database_serving_intervals (provider_project_id, database_id) WHERE ended_at IS NULL;
CREATE INDEX pgcf_serving_interval_usage ON pgcf_database_serving_intervals (provider_project_id, database_id, started_at);
CREATE TRIGGER pgcf_serving_interval_close_only BEFORE UPDATE ON pgcf_database_serving_intervals
  WHEN OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
    OR NEW.organization_id <> OLD.organization_id OR NEW.project_id <> OLD.project_id OR NEW.physical_environment_id <> OLD.physical_environment_id
    OR NEW.target_version <> OLD.target_version OR NEW.provider_project_id <> OLD.provider_project_id OR NEW.database_id <> OLD.database_id
    OR NEW.started_at <> OLD.started_at OR NEW.billable_from <> OLD.billable_from
BEGIN SELECT RAISE(ABORT, 'PGCF serving history is immutable'); END;
CREATE TRIGGER pgcf_serving_interval_no_delete BEFORE DELETE ON pgcf_database_serving_intervals
BEGIN SELECT RAISE(ABORT, 'PGCF serving history is immutable'); END;

CREATE TRIGGER pgcf_serving_interval_on_head_insert AFTER INSERT ON database_provider_target_heads
  WHEN NEW.state = 'active' AND NEW.activated_at IS NOT NULL
BEGIN
  INSERT INTO pgcf_database_serving_intervals(organization_id, project_id, physical_environment_id, target_version, provider_project_id, database_id, started_at, billable_from, ended_at)
  SELECT r.organization_id, r.project_id, r.physical_environment_id, r.target_version, r.provider_project_id, r.database_id, NEW.activated_at, strftime('%Y-%m-%dT%H:00:00.000000Z', substr(NEW.activated_at,1,13)||':00:00Z', '+1 hour'), NULL
    FROM database_provider_target_revisions r
   WHERE r.organization_id = NEW.organization_id AND r.project_id = NEW.project_id AND r.physical_environment_id = NEW.physical_environment_id AND r.target_version = NEW.target_version AND r.provider = 'pgcf';
END;
CREATE TRIGGER pgcf_serving_interval_on_head_update AFTER UPDATE ON database_provider_target_heads
BEGIN
  UPDATE pgcf_database_serving_intervals SET ended_at = CASE WHEN NEW.updated_at IS OLD.updated_at THEN strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z' ELSE NEW.updated_at END
   WHERE organization_id = OLD.organization_id AND project_id = OLD.project_id AND physical_environment_id = OLD.physical_environment_id AND ended_at IS NULL
     AND NOT (NEW.state = 'active' AND NEW.activated_at IS NOT NULL AND NEW.activated_at = started_at AND EXISTS (SELECT 1 FROM database_provider_target_revisions current_target WHERE current_target.organization_id = NEW.organization_id AND current_target.project_id = NEW.project_id AND current_target.physical_environment_id = NEW.physical_environment_id AND current_target.target_version = NEW.target_version AND current_target.provider = 'pgcf' AND current_target.provider_project_id = pgcf_database_serving_intervals.provider_project_id AND current_target.database_id = pgcf_database_serving_intervals.database_id));
  INSERT INTO pgcf_database_serving_intervals(organization_id, project_id, physical_environment_id, target_version, provider_project_id, database_id, started_at, billable_from, ended_at)
  SELECT r.organization_id, r.project_id, r.physical_environment_id, r.target_version, r.provider_project_id, r.database_id, NEW.activated_at, strftime('%Y-%m-%dT%H:00:00.000000Z', substr(NEW.activated_at,1,13)||':00:00Z', '+1 hour'), NULL
    FROM database_provider_target_revisions r
   WHERE NEW.state = 'active' AND NEW.activated_at IS NOT NULL
     AND r.organization_id = NEW.organization_id AND r.project_id = NEW.project_id AND r.physical_environment_id = NEW.physical_environment_id AND r.target_version = NEW.target_version AND r.provider = 'pgcf'
     AND NOT EXISTS (SELECT 1 FROM pgcf_database_serving_intervals still_open WHERE still_open.organization_id = NEW.organization_id AND still_open.project_id = NEW.project_id AND still_open.physical_environment_id = NEW.physical_environment_id AND still_open.ended_at IS NULL);
END;

CREATE TRIGGER pgcf_serving_interval_on_head_delete AFTER DELETE ON database_provider_target_heads
BEGIN
  UPDATE pgcf_database_serving_intervals SET ended_at = strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'
   WHERE organization_id = OLD.organization_id AND project_id = OLD.project_id AND physical_environment_id = OLD.physical_environment_id AND ended_at IS NULL;
END;
