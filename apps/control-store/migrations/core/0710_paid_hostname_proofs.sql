-- A Paid hostname's ownership proof is its own record, keyed by project and hostname. It is no longer the project's
-- application domain identity, which proves the mail sender domain. Declaring, re-declaring or verifying one never
-- revokes, suspends or refuses the other, so proving a routed hostname cannot suspend mail and re-proving mail cannot
-- unprove a live hostname.
--
-- A pending record is the challenge the Paid apply issued for an unproven hostname; a verified record proves it until
-- `expires_at`. Backfill: every verified, unrevoked application identity of a project is copied as the Paid proof of its
-- own hostname, so no existing proof is lost, whether or not the project has a Paid connection on it. Live rows that are
-- already proven keep their `hostname_proven_at` (migration 0640).
CREATE TABLE IF NOT EXISTS paid_hostname_proofs (
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  hostname TEXT NOT NULL CHECK(hostname=lower(hostname) AND length(hostname) BETWEEN 4 AND 253 AND instr(hostname,'.')>0),
  state TEXT NOT NULL CHECK(state IN ('pending','verified')),
  challenge_name TEXT NOT NULL CHECK(challenge_name='_omh-project.'||hostname),
  challenge_value TEXT NOT NULL CHECK(length(challenge_value) BETWEEN 32 AND 128),
  declared_at TEXT NOT NULL CHECK(declared_at GLOB '????-??-??T??:??:??.??????Z'),
  verified_at TEXT CHECK(verified_at IS NULL OR verified_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT CHECK(expires_at IS NULL OR expires_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,hostname),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  CHECK((state='pending' AND verified_at IS NULL AND expires_at IS NULL)
    OR (state='verified' AND verified_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at>verified_at))
) STRICT, WITHOUT ROWID;

INSERT OR IGNORE INTO paid_hostname_proofs(organization_id,project_id,hostname,state,challenge_name,challenge_value,declared_at,verified_at,expires_at)
SELECT i.organization_id,i.project_id,i.hostname,'verified',i.challenge_name,i.challenge_value,i.declared_at,i.verified_at,i.expires_at
FROM project_application_domain_identities i
WHERE i.state='verified' AND i.revoked_at IS NULL AND i.verified_at IS NOT NULL AND i.expires_at>i.verified_at;

-- The coupling of the two proofs ends: a Paid connection's hostname no longer revokes the mail identity and suspends its
-- bindings (insert and update of the connection), and a mail identity is no longer refused for a Paid hostname outside
-- its domain. Only the revision rule of the identity remains.
DROP TRIGGER IF EXISTS invalidate_changed_application_mail_domain_insert;
DROP TRIGGER IF EXISTS invalidate_changed_application_mail_domain_update;
DROP TRIGGER IF EXISTS guard_application_mail_identity_insert;
DROP TRIGGER IF EXISTS guard_application_mail_identity_update;
CREATE TRIGGER IF NOT EXISTS guard_application_mail_identity_update BEFORE UPDATE ON project_application_domain_identities
BEGIN
 SELECT RAISE(ABORT,'mail_identity_revision_conflict') WHERE NEW.revision<OLD.revision OR(NEW.revision=OLD.revision AND(NEW.hostname IS NOT OLD.hostname OR NEW.registrable_domain IS NOT OLD.registrable_domain OR NEW.challenge_name IS NOT OLD.challenge_name OR NEW.challenge_value IS NOT OLD.challenge_value));
END;
