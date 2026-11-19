-- W38: previews are bounded commit-scoped runtime leases, never a third project environment.
CREATE TABLE preview_sessions (
  preview_id TEXT PRIMARY KEY CHECK(length(preview_id)=26),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  billing_epoch_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  delegation TEXT CHECK(delegation IS NULL OR json_valid(delegation)),
  generation INTEGER NOT NULL CHECK(generation>0),
  source_connection_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation>0),
  commit_sha TEXT NOT NULL CHECK(length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*' AND commit_sha<>'0000000000000000000000000000000000000000'),
  framework_plan TEXT NOT NULL CHECK(json_valid(framework_plan)),
  source_archive TEXT NOT NULL CHECK(json_valid(source_archive)),
  environment_id TEXT NOT NULL,
  environment_name TEXT NOT NULL CHECK(environment_name IN('dev','prod')),
  data_environment_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL CHECK(assignment_version>0),
  region TEXT NOT NULL CHECK(region IN('us','eu')),
  shared_data INTEGER NOT NULL CHECK(shared_data IN(0,1)),
  instance_type TEXT NOT NULL CHECK(instance_type IN('basic','standard-1')),
  compute_quote TEXT NOT NULL CHECK(json_valid(compute_quote)),
  status TEXT NOT NULL CHECK(status IN('queued','starting','ready','sleeping','failed','stopped','expired','superseded')),
  public_origin TEXT NOT NULL UNIQUE,
  failure_code TEXT,
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.??????Z' AND julianday(expires_at)-julianday(created_at) BETWEEN 0.041666665 AND 0.041666668),
  last_activity_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cleanup_completed_at TEXT,
  UNIQUE(organization_id,project_id,generation),
  UNIQUE(organization_id,project_id,request_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  FOREIGN KEY(organization_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,billing_epoch_id),
  FOREIGN KEY(organization_id,project_id,source_connection_id) REFERENCES source_connections(organization_id,project_id,source_connection_id)
) STRICT;
CREATE UNIQUE INDEX preview_one_live_project ON preview_sessions(project_id) WHERE status IN('queued','starting','ready','sleeping');
CREATE INDEX preview_expiry ON preview_sessions(expires_at) WHERE status IN('queued','starting','ready','sleeping');
CREATE INDEX preview_cleanup ON preview_sessions(updated_at) WHERE cleanup_completed_at IS NULL;
CREATE TRIGGER preview_identity_immutable BEFORE UPDATE ON preview_sessions
WHEN NEW.preview_id<>OLD.preview_id OR NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id
 OR NEW.billing_epoch_id<>OLD.billing_epoch_id OR NEW.principal_id<>OLD.principal_id OR NEW.request_id<>OLD.request_id
 OR NEW.request_sha256<>OLD.request_sha256 OR NEW.delegation IS NOT OLD.delegation OR NEW.generation<>OLD.generation OR NEW.source_connection_id<>OLD.source_connection_id OR NEW.source_generation<>OLD.source_generation
 OR NEW.commit_sha<>OLD.commit_sha OR NEW.framework_plan<>OLD.framework_plan OR NEW.source_archive<>OLD.source_archive
 OR NEW.environment_id<>OLD.environment_id OR NEW.environment_name<>OLD.environment_name OR NEW.data_environment_id<>OLD.data_environment_id
 OR NEW.assignment_version<>OLD.assignment_version OR NEW.region<>OLD.region OR NEW.shared_data<>OLD.shared_data
 OR NEW.instance_type<>OLD.instance_type OR NEW.compute_quote<>OLD.compute_quote OR NEW.public_origin<>OLD.public_origin OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
BEGIN SELECT RAISE(ABORT,'preview_identity_immutable'); END;
CREATE TRIGGER preview_terminal_immutable BEFORE UPDATE OF status ON preview_sessions
WHEN OLD.status IN('failed','stopped','expired','superseded') AND NEW.status<>OLD.status
BEGIN SELECT RAISE(ABORT,'preview_terminal_immutable'); END;
CREATE TABLE preview_usage_intervals (
  preview_id TEXT NOT NULL REFERENCES preview_sessions(preview_id),
  interval_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL UNIQUE,
  seconds INTEGER NOT NULL CHECK(seconds BETWEEN 1 AND 60),
  quoted_micros INTEGER NOT NULL CHECK(quoted_micros>0),
  rate_card_id TEXT NOT NULL REFERENCES published_credit_rate_cards(rate_card_id),
  state TEXT NOT NULL CHECK(state IN('reserved','settled','released')),
  cpu_milliseconds INTEGER CHECK(cpu_milliseconds>=0),
  active_milliseconds INTEGER CHECK(active_milliseconds>=0),
  charged_micros INTEGER CHECK(charged_micros>=0),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(preview_id,interval_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX preview_one_open_hold ON preview_usage_intervals(preview_id) WHERE state='reserved';
-- Every accepted public request key retains its original lease, including same-version reuse.
CREATE TABLE preview_requests (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256)=64),
  preview_id TEXT NOT NULL REFERENCES preview_sessions(preview_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,project_id,request_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER preview_request_immutable BEFORE UPDATE ON preview_requests
BEGIN SELECT RAISE(ABORT,'preview_request_immutable'); END;
-- A definitely refused hold may leave a measured shutdown tail; the platform absorbs it.
-- This evidence is never a replacement for an existing or uncertain customer reservation.
CREATE TABLE preview_unfunded_usage (
  preview_id TEXT NOT NULL REFERENCES preview_sessions(preview_id),
  interval_id TEXT NOT NULL,
  active_milliseconds INTEGER NOT NULL CHECK(active_milliseconds>=0),
  cpu_milliseconds INTEGER NOT NULL CHECK(cpu_milliseconds>=0),
  provider_quantity_pico_usd TEXT NOT NULL,
  platform_overrun_micros INTEGER NOT NULL CHECK(platform_overrun_micros>=0),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(preview_id,interval_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER preview_unfunded_usage_immutable BEFORE UPDATE ON preview_unfunded_usage
BEGIN SELECT RAISE(ABORT,'preview_unfunded_usage_immutable'); END;
