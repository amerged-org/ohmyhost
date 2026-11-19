-- core-v1 source: migrations/shard/0054_metering_cohort_lane.sql
-- Settlement lane of the tenant shard (milestone Q3, cohort runtime): the shard-local twin of PostgreSQL migrations
-- 183 (metering work) and 194 (unified families). The owner row, the organization claim and the cohort tasks live in
-- THE SAME DATABASE as the wallet and the ledger, so one db.batch can fence on all of them at commit time; a directory
-- precheck of the owner could not (the original held FOR SHARE on the owner row through the commit).
--
-- Nothing here computes a price or touches a ledger. The owner starts as 'control' (epoch 1): this migration never
-- activates the metering owner, and the runtime refuses to settle for an owner that is not its own.

-- One row: which engine may claim and finalize on THIS shard. Only the epoch-increasing owner flip is representable;
-- an ordinary financial command never writes it (the trigger is the operator-only guard D1 can express, the
-- operator authority itself is a separate factory).
CREATE TABLE metering_lane_owner (
  lane   TEXT    NOT NULL PRIMARY KEY CHECK (lane = 'financial'),
  owner  TEXT    NOT NULL CHECK (owner IN ('control', 'metering')),
  epoch  INTEGER NOT NULL CHECK (epoch > 0)
) STRICT, WITHOUT ROWID;
INSERT INTO metering_lane_owner (lane, owner, epoch) VALUES ('financial', 'control', 1);
CREATE TRIGGER metering_lane_owner_flip_only BEFORE UPDATE ON metering_lane_owner
  WHEN NEW.lane <> OLD.lane OR NEW.owner = OLD.owner OR NEW.epoch <> OLD.epoch + 1
BEGIN SELECT RAISE(ABORT, 'the metering lane owner only flips, one epoch at a time'); END;
CREATE TRIGGER metering_lane_owner_no_delete BEFORE DELETE ON metering_lane_owner
BEGIN SELECT RAISE(ABORT, 'the metering lane owner is never deleted'); END;

-- Claim, lease and fairness state of one organization across the four families. The generation persists when a claim is
-- released and grows with every claim. Times are stored microsecond instants of the DATABASE clock. The completion
-- marker is written by the same compare-and-swap that releases the claim, so a lost response is observable.
CREATE TABLE organization_metering_work (
  organization_id          TEXT    NOT NULL PRIMARY KEY REFERENCES organizations (organization_id),
  generation               INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  last_served_at           TEXT    CHECK (last_served_at IS NULL OR last_served_at GLOB '????-??-??T??:??:??.??????Z'),
  claim_owner              TEXT    CHECK (claim_owner IN ('control', 'metering')),
  claim_token              TEXT    CHECK (claim_token IS NULL OR length(claim_token) = 26),
  claim_epoch              INTEGER CHECK (claim_epoch > 0),
  claimed_at               TEXT    CHECK (claimed_at IS NULL OR claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_until              TEXT    CHECK (lease_until IS NULL OR lease_until GLOB '????-??-??T??:??:??.??????Z'),
  -- Initially 'maintenance', so the first family served is cohort.
  last_family              TEXT    NOT NULL DEFAULT 'maintenance'
    CHECK (last_family IN ('cohort', 'lifetime', 'provider', 'maintenance')),
  completed_claim_token    TEXT    CHECK (completed_claim_token IS NULL OR length(completed_claim_token) = 26),
  completed_owner_epoch    INTEGER,
  completed_generation     INTEGER,
  completed_family         TEXT,
  completed_outcome        TEXT,
  completed_selection_sha256 BLOB,
  completed_at             TEXT    CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  CONSTRAINT organization_metering_work_claim_shape CHECK (
    (claim_owner IS NULL AND claim_token IS NULL AND claim_epoch IS NULL AND claimed_at IS NULL AND lease_until IS NULL)
    OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_until IS NOT NULL AND lease_until > claimed_at AND generation > 0)),
  CONSTRAINT organization_metering_work_completion_shape CHECK (
    (completed_claim_token IS NULL AND completed_owner_epoch IS NULL AND completed_generation IS NULL
      AND completed_family IS NULL AND completed_outcome IS NULL AND completed_selection_sha256 IS NULL
      AND completed_at IS NULL)
    OR (completed_claim_token IS NOT NULL AND completed_owner_epoch IS NOT NULL AND completed_owner_epoch > 0
      AND completed_generation IS NOT NULL AND completed_generation > 0 AND completed_generation <= generation
      AND completed_family IN ('cohort', 'lifetime', 'provider', 'maintenance')
      AND completed_outcome IN ('posted', 'replayed', 'evaluated', 'wait', 'rerouted', 'maintenance')
      AND completed_selection_sha256 IS NOT NULL AND length(completed_selection_sha256) = 32
      AND completed_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX organization_metering_work_served ON organization_metering_work (last_served_at, organization_id);
CREATE TRIGGER organization_metering_work_no_delete BEFORE DELETE ON organization_metering_work
BEGIN SELECT RAISE(ABORT, 'organization metering work is never deleted'); END;
CREATE TRIGGER organization_metering_work_generation_forward BEFORE UPDATE ON organization_metering_work
  WHEN NEW.generation < OLD.generation OR NEW.organization_id <> OLD.organization_id
BEGIN SELECT RAISE(ABORT, 'the claim generation only grows'); END;

-- One exact, already-discovered measurement per source observation. The labels are what postMeasuredUsage accepts and the
-- ledger can store, so a task that could never post is refused at enqueue. Identity and measurement never change;
-- scheduling fields stay mutable until completion, which is terminal.
CREATE TABLE metering_cohort_work (
  work_id                 TEXT    NOT NULL PRIMARY KEY CHECK (length(work_id) = 26),
  source_kind             TEXT    NOT NULL
    CHECK (length(source_kind) BETWEEN 1 AND 64 AND source_kind GLOB '[a-z]*' AND source_kind NOT GLOB '*[^a-z0-9_.-]*'),
  source_reference        TEXT    NOT NULL
    CHECK (length(source_reference) BETWEEN 1 AND 256 AND source_reference GLOB '[A-Za-z0-9]*'
      AND source_reference NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  observation_reference   TEXT    NOT NULL
    CHECK (length(observation_reference) BETWEEN 1 AND 256 AND observation_reference GLOB '[A-Za-z0-9]*'
      AND observation_reference NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  organization_id         TEXT    NOT NULL REFERENCES organization_metering_work (organization_id),
  project_id              TEXT    NOT NULL,
  environment_id          TEXT,
  billing_epoch_id        TEXT    NOT NULL,
  meter                   TEXT    NOT NULL
    CHECK (length(meter) BETWEEN 1 AND 128 AND meter GLOB '[A-Za-z0-9]*' AND meter NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  unit                    TEXT    NOT NULL
    CHECK (length(unit) BETWEEN 1 AND 64 AND unit GLOB '[A-Za-z0-9]*' AND unit NOT GLOB '*[^A-Za-z0-9_.:/-]*'),
  quantity                INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 9223372036854775807),
  event_time              TEXT    NOT NULL CHECK (event_time GLOB '????-??-??T??:??:??.??????Z'),
  observed_at             TEXT    NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  available_at            TEXT    NOT NULL CHECK (available_at GLOB '????-??-??T??:??:??.??????Z'),
  attempts                INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_failure_stage      TEXT    CHECK (last_failure_stage IN ('discovery', 'posting', 'finalize')),
  last_failure_code       TEXT    CHECK (last_failure_code IN (
    'lock_not_available', 'statement_canceled', 'idle_in_transaction_timeout', 'transaction_timeout', 'deadlock',
    'read_only_violation', 'budget_unsupported', 'connection', 'invalid_measurement', 'measurement_conflict',
    'unknown')),
  completed_at            TEXT    CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_valuation_id  TEXT    CHECK (completed_valuation_id IS NULL OR length(completed_valuation_id) = 26),
  CONSTRAINT metering_cohort_work_identity_key UNIQUE (source_kind, source_reference, observation_reference),
  CONSTRAINT metering_cohort_work_chronology CHECK (event_time <= observed_at),
  CONSTRAINT metering_cohort_work_failure_shape CHECK ((last_failure_stage IS NULL) = (last_failure_code IS NULL)),
  CONSTRAINT metering_cohort_work_completion_shape CHECK ((completed_at IS NULL) = (completed_valuation_id IS NULL)),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES billing_environment_scopes (organization_id, environment_id),
  FOREIGN KEY (organization_id, billing_epoch_id) REFERENCES billing_epochs (organization_id, billing_epoch_id),
  FOREIGN KEY (organization_id, completed_valuation_id) REFERENCES usage_valuations (organization_id, valuation_id)
) STRICT, WITHOUT ROWID;
-- Due-work lookup and fetch order for one organization; completed history is not indexed.
CREATE INDEX metering_cohort_work_pending ON metering_cohort_work (organization_id, available_at, event_time, work_id)
  WHERE completed_at IS NULL;
CREATE TRIGGER metering_cohort_work_guard BEFORE UPDATE ON metering_cohort_work
  WHEN OLD.completed_at IS NOT NULL
    OR NEW.work_id <> OLD.work_id OR NEW.source_kind <> OLD.source_kind OR NEW.source_reference <> OLD.source_reference
    OR NEW.observation_reference <> OLD.observation_reference OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.environment_id IS NOT OLD.environment_id
    OR NEW.billing_epoch_id <> OLD.billing_epoch_id OR NEW.meter <> OLD.meter OR NEW.unit <> OLD.unit
    OR NEW.quantity <> OLD.quantity OR NEW.event_time <> OLD.event_time OR NEW.observed_at <> OLD.observed_at
BEGIN SELECT RAISE(ABORT, 'completed metering work is terminal and its measurement immutable'); END;
CREATE TRIGGER metering_cohort_work_no_delete BEFORE DELETE ON metering_cohort_work
BEGIN SELECT RAISE(ABORT, 'metering work is never deleted'); END;
