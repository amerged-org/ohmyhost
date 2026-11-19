-- Original199 callbacks after0480 rebuilds the native paid-domain table.
--0466/0480/0490 bytes and all lifetime/hostname guards remain unchanged; no past proof/binding is backfilled.
CREATE TRIGGER invalidate_changed_application_mail_domain_insert AFTER INSERT ON paid_project_domains
WHEN EXISTS(SELECT 1 FROM project_application_domain_identities i WHERE i.organization_id=NEW.organization_id AND i.project_id=NEW.project_id AND i.state<>'revoked' AND NEW.hostname<>i.registrable_domain AND substr(NEW.hostname,-length(i.registrable_domain)-1)<>'.'||i.registrable_domain)
BEGIN
 UPDATE project_application_domain_identities SET state='revoked',revoked_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND state<>'revoked';
 UPDATE project_mail_domain_bindings SET state='suspended',sending=0,revision=revision+1,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND NOT legacy AND state='active';
END;

CREATE TRIGGER invalidate_changed_application_mail_domain_update AFTER UPDATE OF hostname,state ON paid_project_domains
WHEN (NEW.hostname IS NOT OLD.hostname OR(NEW.state IN('deleting','deleted') AND OLD.state NOT IN('deleting','deleted'))) OR EXISTS(SELECT 1 FROM project_application_domain_identities i WHERE i.organization_id=NEW.organization_id AND i.project_id=NEW.project_id AND i.state<>'revoked' AND NEW.hostname<>i.registrable_domain AND substr(NEW.hostname,-length(i.registrable_domain)-1)<>'.'||i.registrable_domain)
BEGIN
 UPDATE project_application_domain_identities SET state='revoked',revoked_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND state<>'revoked';
 UPDATE project_mail_domain_bindings SET state='suspended',sending=0,revision=revision+1,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND NOT legacy AND state='active';
END;
