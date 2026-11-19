-- Preserve the original final runtime-secret state, defaults and monotonicity. Historical state belongs to the
-- current organization/environment identity; immutable delivery receipts keep their stable environment parent.
CREATE TABLE runtime_secret_delivery_states_0370 (
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  desired_generation INTEGER NOT NULL DEFAULT 0 CHECK(desired_generation>=0),
  applied_generation INTEGER NOT NULL DEFAULT 0 CHECK(applied_generation>=0 AND applied_generation<=desired_generation),
  active_lease_id TEXT CHECK(active_lease_id IS NULL OR (length(active_lease_id)=26 AND substr(active_lease_id,1,1) BETWEEN '0' AND '7' AND active_lease_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  claimed_generation INTEGER,
  claimed_trigger TEXT,
  claimed_at TEXT CHECK(claimed_at IS NULL OR claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  provider_tag TEXT CHECK(provider_tag IS NULL OR (length(provider_tag) BETWEEN 1 AND 128 AND substr(provider_tag,1,1) GLOB '[A-Za-z0-9]' AND provider_tag NOT GLOB '*[^A-Za-z0-9._:/-]*')),
  applied_secret_names TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(applied_secret_names) AND json_type(applied_secret_names)='array'),
  applied_manifest_sha256 BLOB,
  applied_secret_count INTEGER NOT NULL DEFAULT 0 CHECK(applied_secret_count BETWEEN 0 AND 100),
  last_failure_code TEXT,
  last_failed_at TEXT CHECK(last_failed_at IS NULL OR last_failed_at GLOB '????-??-??T??:??:??.??????Z'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at>=created_at),
  next_release_sequence INTEGER NOT NULL DEFAULT 1,
  claimed_release_sequence INTEGER,
  applied_release_sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(organization_id,project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK((active_lease_id IS NULL AND claimed_generation IS NULL AND claimed_trigger IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
    OR (active_lease_id IS NOT NULL AND claimed_generation IS NOT NULL AND claimed_generation>=applied_generation AND claimed_generation<=desired_generation
      AND claimed_trigger IN ('deploy','rollback','promotion','reconcile') AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at)),
  CHECK((provider_tag IS NULL AND applied_manifest_sha256 IS NULL AND applied_secret_count=0 AND json_array_length(applied_secret_names)=0)
    OR (provider_tag IS NOT NULL AND length(applied_manifest_sha256)=32 AND applied_secret_count=json_array_length(applied_secret_names))),
  CHECK((last_failure_code IS NULL AND last_failed_at IS NULL)
    OR (length(last_failure_code) BETWEEN 1 AND 64 AND substr(last_failure_code,1,1) GLOB '[A-Z]' AND last_failure_code NOT GLOB '*[^A-Z0-9_]*' AND last_failed_at IS NOT NULL)),
  CHECK(applied_release_sequence>=0 AND next_release_sequence>applied_release_sequence
    AND ((active_lease_id IS NULL AND claimed_release_sequence IS NULL)
      OR (active_lease_id IS NOT NULL AND claimed_release_sequence>applied_release_sequence AND claimed_release_sequence<next_release_sequence)))
) STRICT, WITHOUT ROWID;
INSERT INTO runtime_secret_delivery_states_0370(
  organization_id,project_id,environment_id,desired_generation,applied_generation,active_lease_id,claimed_generation,claimed_trigger,
  claimed_at,lease_expires_at,provider_tag,applied_secret_names,applied_manifest_sha256,applied_secret_count,last_failure_code,last_failed_at,
  created_at,updated_at,next_release_sequence,claimed_release_sequence,applied_release_sequence)
SELECT organization_id,project_id,environment_id,desired_generation,applied_generation,active_lease_id,claimed_generation,claimed_trigger,
  claimed_at,lease_expires_at,provider_tag,applied_secret_names,applied_manifest_sha256,applied_secret_count,last_failure_code,last_failed_at,
  created_at,updated_at,next_release_sequence,claimed_release_sequence,applied_release_sequence FROM runtime_secret_delivery_states;
DROP TABLE runtime_secret_delivery_states;
ALTER TABLE runtime_secret_delivery_states_0370 RENAME TO runtime_secret_delivery_states;
CREATE INDEX runtime_secret_delivery_pending ON runtime_secret_delivery_states (updated_at, organization_id, project_id, environment_id)
  WHERE desired_generation > applied_generation OR last_failure_code IS NOT NULL OR active_lease_id IS NOT NULL;
CREATE TRIGGER runtime_secret_delivery_generations_monotonic BEFORE UPDATE ON runtime_secret_delivery_states
  WHEN NEW.desired_generation<OLD.desired_generation OR NEW.applied_generation<OLD.applied_generation
BEGIN SELECT RAISE(ABORT,'runtime secret generations are monotonic'); END;

CREATE TABLE runtime_secret_delivery_receipts (
  receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id)=26 AND substr(receipt_id,1,1) BETWEEN '0' AND '7' AND receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  lease_id TEXT NOT NULL UNIQUE CHECK(length(lease_id)=26 AND substr(lease_id,1,1) BETWEEN '0' AND '7' AND lease_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  generation INTEGER NOT NULL CHECK(generation>=0),
  trigger TEXT NOT NULL CHECK(trigger IN ('deploy','rollback','promotion','reconcile')),
  provider_tag TEXT NOT NULL CHECK(length(provider_tag) BETWEEN 1 AND 128 AND substr(provider_tag,1,1) GLOB '[A-Za-z0-9]' AND provider_tag NOT GLOB '*[^A-Za-z0-9._:/-]*'),
  applied_secret_names TEXT NOT NULL CHECK(json_valid(applied_secret_names) AND json_type(applied_secret_names)='array'),
  manifest_sha256 BLOB NOT NULL CHECK(length(manifest_sha256)=32),
  manifest_secret_count INTEGER NOT NULL CHECK(manifest_secret_count BETWEEN 0 AND 100 AND manifest_secret_count=json_array_length(applied_secret_names)),
  completed_at TEXT NOT NULL CHECK(completed_at GLOB '????-??-??T??:??:??.??????Z'),
  release_sequence INTEGER NOT NULL CHECK(release_sequence>0),
  FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id) ON DELETE RESTRICT,
  UNIQUE(organization_id,project_id,environment_id,release_sequence)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER runtime_secret_delivery_receipts_no_update BEFORE UPDATE ON runtime_secret_delivery_receipts
BEGIN SELECT RAISE(ABORT,'runtime secret delivery receipt is append-only'); END;
CREATE TRIGGER runtime_secret_delivery_receipts_no_delete BEFORE DELETE ON runtime_secret_delivery_receipts
BEGIN SELECT RAISE(ABORT,'runtime secret delivery receipt is append-only'); END;
