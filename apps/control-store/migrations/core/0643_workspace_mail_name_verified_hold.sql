-- A workspace sender name is held platform-wide only once its domain is provider verified (`sending_status` ready), or
-- when it is a legacy mirror. An unverified sender reserves its name for seven days in the command (see the shared name
-- check), and after that it holds nothing: the live-name index no longer counts it, so the name is free again. Retired
-- senders stay out of the index as before. No sender identity or receipt changes; only the index predicate.
DROP INDEX workspace_mail_domain_live_name;
CREATE UNIQUE INDEX workspace_mail_domain_live_name ON workspace_mail_domains(domain)
WHERE status<>'retired' AND(sending_status='ready' OR legacy_domain_id IS NOT NULL);
