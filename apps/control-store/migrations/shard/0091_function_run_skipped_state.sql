-- A run whose occurrence is more than an hour overdue is never dispatched: the claim records it as `skipped`, a missed
-- occurrence, with no attempt and no lease. Rebuilt in place: the state CHECK and the shape triggers admit the new state.
CREATE TABLE function_runs_0091 (
  organization_id          TEXT    NOT NULL,
  run_id                   TEXT    NOT NULL CHECK (length(run_id) = 26),
  project_id               TEXT    NOT NULL,
  environment_id           TEXT    NOT NULL,
  deployment_id            TEXT    NOT NULL,
  immutable_script_name    TEXT    NOT NULL,
  cron                     TEXT    NOT NULL,
  scheduled_at             TEXT    NOT NULL CHECK (scheduled_at GLOB '????-??-??T??:??:??.??????Z'),
  state                    TEXT    NOT NULL CHECK (state IN ('due','running','retry','succeeded','failed','skipped')),
  attempt                  INTEGER NOT NULL CHECK (attempt >= 0),
  lease_until              TEXT    CHECK (lease_until IS NULL OR lease_until GLOB '????-??-??T??:??:??.??????Z'),
  started_at               TEXT    CHECK (started_at IS NULL OR started_at GLOB '????-??-??T??:??:??.??????Z'),
  finished_at              TEXT    CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.??????Z'),
  status_code              INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  egress_allowed_origins   TEXT    NOT NULL CHECK (json_valid(egress_allowed_origins)),
  created_at               TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at               TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, run_id),
  UNIQUE (organization_id, environment_id, cron, scheduled_at)
) STRICT, WITHOUT ROWID;
INSERT INTO function_runs_0091(organization_id,run_id,project_id,environment_id,deployment_id,immutable_script_name,cron,scheduled_at,state,attempt,lease_until,started_at,finished_at,status_code,egress_allowed_origins,created_at,updated_at) SELECT organization_id,run_id,project_id,environment_id,deployment_id,immutable_script_name,cron,scheduled_at,state,attempt,lease_until,started_at,finished_at,status_code,egress_allowed_origins,created_at,updated_at FROM function_runs;
DROP TABLE function_runs;
ALTER TABLE function_runs_0091 RENAME TO function_runs;
CREATE INDEX function_runs_open ON function_runs (scheduled_at, run_id) WHERE state IN ('due','retry','running');
CREATE INDEX function_runs_newest ON function_runs (organization_id, environment_id, scheduled_at DESC, cron);
