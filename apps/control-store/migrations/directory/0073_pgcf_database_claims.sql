-- GLOBAL exclusive claim of a PGCF physical database identity (provider_project_id, database_id). The original PostgreSQL
-- migration 202 made that pair globally unique among ACTIVE heads; external_route cannot carry it because its primary
-- key includes the organization and project, so several owners could hold one key. This table's primary key is the
-- identity alone: at most one owner holds it, in any state.
--
-- Protocol (core-model 5.5, the domain_directory saga): reserve here, write the head in the owner's shard, confirm here.
-- A reservation is settled by the claim sweep in ONE shard batch that writes the abort tombstone
-- (pgcf_database_claim_aborts) unless an ACTIVE head backs the claim, and only then is the row confirmed or deleted.
-- The shard batch that creates the head is guarded against the tombstone, so a delayed writer never commits after the
-- identity became reusable. A confirmed claim is released only after its head is retired, by the same tombstone batch.
-- claim_id is the stable id of the reserving operation (`<operationId>:<targetVersion>`), identical on every retry.
CREATE TABLE pgcf_database_claims (
  provider_project_id      TEXT NOT NULL CHECK (length(provider_project_id) = 24 AND substr(provider_project_id, 1, 4) = 'prj_' AND substr(provider_project_id, 5) NOT GLOB '*[^a-z0-9]*'),
  database_id              TEXT NOT NULL CHECK (length(database_id) = 20 AND substr(database_id, 1, 1) GLOB '[a-z]' AND database_id NOT GLOB '*[^a-z0-9]*'),
  organization_id          TEXT NOT NULL REFERENCES org_directory (organization_id),
  project_id               TEXT NOT NULL CHECK (length(project_id) = 26),
  physical_environment_id  TEXT NOT NULL CHECK (length(physical_environment_id) = 26),
  target_version           INTEGER NOT NULL CHECK (target_version > 0),
  claim_id                 TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 128),
  state                    TEXT NOT NULL CHECK (state IN ('reserved', 'active')),
  expires_at               TEXT CHECK (expires_at IS NULL OR expires_at GLOB '????-??-??T??:??:??.??????Z'),
  created_at               TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at               TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (provider_project_id, database_id),
  CHECK ((state = 'reserved') = (expires_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX pgcf_database_claims_reserved ON pgcf_database_claims (expires_at) WHERE state = 'reserved';
CREATE INDEX pgcf_database_claims_owner ON pgcf_database_claims (organization_id, project_id, physical_environment_id);
CREATE TRIGGER pgcf_database_claims_identity BEFORE UPDATE ON pgcf_database_claims
  WHEN NEW.provider_project_id <> OLD.provider_project_id OR NEW.database_id <> OLD.database_id OR NEW.organization_id <> OLD.organization_id
    OR NEW.project_id <> OLD.project_id OR NEW.physical_environment_id <> OLD.physical_environment_id OR NEW.target_version <> OLD.target_version
    OR NEW.claim_id <> OLD.claim_id OR NEW.created_at <> OLD.created_at OR (OLD.state = 'active' AND NEW.state <> 'active')
BEGIN SELECT RAISE(ABORT, 'E55000 a PGCF database claim keeps its owner, version and claim id'); END;
