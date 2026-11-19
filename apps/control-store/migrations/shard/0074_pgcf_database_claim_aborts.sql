-- Abort tombstone of a global PGCF physical-identity claim (provider_project_id, database_id) that the directory sweep or
-- the claimant itself closed: the same fence as domain_claim_aborts and project_creation_aborts. It is written in the
-- same shard batch that proves no ACTIVE head backs the claim; the activating command's shard batch is guarded against
-- it. A claimant that was only delayed can therefore never commit a head after the directory released the identity and
-- another owner reserved it. claim_id is the stable id of the reserving operation (`<operationId>:<targetVersion>`).
CREATE TABLE pgcf_database_claim_aborts (
  provider_project_id  TEXT NOT NULL CHECK (length(provider_project_id) = 24 AND substr(provider_project_id, 1, 4) = 'prj_' AND substr(provider_project_id, 5) NOT GLOB '*[^a-z0-9]*'),
  database_id          TEXT NOT NULL CHECK (length(database_id) = 20 AND substr(database_id, 1, 1) GLOB '[a-z]' AND database_id NOT GLOB '*[^a-z0-9]*'),
  organization_id      TEXT NOT NULL CHECK (length(organization_id) = 26),
  claim_id             TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 128),
  aborted_at           TEXT NOT NULL CHECK (aborted_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (provider_project_id, database_id, claim_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX pgcf_database_claim_aborts_claim ON pgcf_database_claim_aborts (organization_id, claim_id);
CREATE TRIGGER pgcf_database_claim_aborts_immutable BEFORE UPDATE ON pgcf_database_claim_aborts
BEGIN SELECT RAISE(ABORT, 'E55000 a PGCF database claim abort tombstone is immutable'); END;
CREATE TRIGGER pgcf_database_claim_aborts_no_delete BEFORE DELETE ON pgcf_database_claim_aborts
BEGIN SELECT RAISE(ABORT, 'E55000 a PGCF database claim abort tombstone is immutable'); END;
