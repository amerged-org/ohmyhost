-- Abort tombstone of a domain claim that the reservation sweep closed (core-model 5.5), the same pattern as project_creation_aborts.
-- The sweep writes it in the same shard batch that proves the claim has no backing row; the claiming command's shard batch is guarded
-- against it. A claimant that was only delayed can therefore never commit its row after the directory reservation was released and
-- another owner reserved the name. claim_id is the stable id of the claiming command (`<operationId>:<handle>`), unique per command.
CREATE TABLE domain_claim_aborts (
  class            TEXT NOT NULL CHECK (class IN ('app_prod', 'app_dev', 'cf_mail', 'paid_hostname', 'project_mail', 'resend_live', 'workspace_live')),
  domain           TEXT NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
  organization_id  TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  claim_id         TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 128),
  aborted_at       TEXT NOT NULL CHECK (aborted_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (class, domain, claim_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX domain_claim_aborts_claim ON domain_claim_aborts (organization_id, claim_id);
CREATE TRIGGER domain_claim_aborts_immutable BEFORE UPDATE ON domain_claim_aborts
BEGIN SELECT RAISE(ABORT, 'E55000 a domain claim abort tombstone is immutable'); END;
