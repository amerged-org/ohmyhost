-- The Paid domain connection gains the terminal state `displaced`: an unproven reservation whose hostname a proven
-- project's verified proof took. A displaced connection never routes, holds nothing and has no provider object; its
-- owner sees the hostname as taken until it proves ownership again. Only the state list and its checks change; no receipt,
-- money or proof value moves. SQLite cannot widen a CHECK in place, so the table is rebuilt exactly as 0480 and 0640 left
-- it, with the same triggers and indexes recreated from their migrations.
CREATE TABLE paid_project_domains_copy_0642 AS SELECT * FROM paid_project_domains;
DROP TABLE paid_project_domains;
CREATE TABLE paid_project_domains (
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  hostname TEXT NOT NULL CHECK(hostname=lower(hostname) AND length(hostname)<=253),
  gateway_script_name TEXT,
  state TEXT NOT NULL CHECK(state IN ('awaiting_deployment','pending','active','deleting','deleted','displaced')),
  configured_by_principal_id TEXT NOT NULL,
  apply_idempotency_sha256 BLOB NOT NULL CHECK(length(apply_idempotency_sha256)=32),
  apply_request_sha256 BLOB NOT NULL CHECK(length(apply_request_sha256)=32),
  custom_hostname_receipt TEXT CHECK(custom_hostname_receipt IS NULL OR json_valid(custom_hostname_receipt)),
  worker_route_receipt TEXT CHECK(worker_route_receipt IS NULL OR json_valid(worker_route_receipt)),
  delete_idempotency_sha256 BLOB,
  delete_request_sha256 BLOB,
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z'),
  deleted_at TEXT CHECK(deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.??????Z'),
  provisioning_started_at TEXT CHECK(provisioning_started_at IS NULL OR provisioning_started_at GLOB '????-??-??T??:??:??.??????Z'),
  hostname_proven_at TEXT CHECK (hostname_proven_at IS NULL OR hostname_proven_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  CHECK(updated_at>=created_at AND (deleted_at IS NULL OR deleted_at>=created_at)),
  CHECK(hostname NOT IN ('omh.st','ohmyho.st') AND hostname NOT LIKE '%.omh.st' AND hostname NOT LIKE '%.ohmyho.st'
    AND hostname NOT LIKE '%.poc.aixyte.com'),
  CHECK(gateway_script_name IS NULL OR gateway_script_name='ohmyho-gateway-production'
    OR gateway_script_name='g-p-'||lower(project_id)||'-prod'
    OR (gateway_script_name NOT GLOB '*[^a-z-]*' AND length(gateway_script_name)-length(replace(gateway_script_name,'-',''))=2
      AND substr(gateway_script_name,1,1) BETWEEN 'a' AND 'z' AND substr(gateway_script_name,-1) BETWEEN 'a' AND 'z'
      AND instr(gateway_script_name,'--')=0)),
  CHECK(state='displaced' OR (state='awaiting_deployment' AND gateway_script_name IS NULL AND provisioning_started_at IS NULL)
    OR (state IN ('pending','active') AND gateway_script_name IS NOT NULL AND provisioning_started_at IS NOT NULL)
    OR (state IN ('deleting','deleted') AND ((gateway_script_name IS NULL AND provisioning_started_at IS NULL
      AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL) OR (gateway_script_name IS NOT NULL AND provisioning_started_at IS NOT NULL)))),
  CHECK(provisioning_started_at IS NULL OR provisioning_started_at>=created_at),
  -- A displaced connection is the terminal mark of a reservation that a proven owner displaced: it never routes, holds nothing and has no provider object.
  CHECK(state<>'displaced' OR (custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL AND delete_idempotency_sha256 IS NULL
    AND delete_request_sha256 IS NULL AND deleted_at IS NULL AND hostname_proven_at IS NULL AND ((gateway_script_name IS NULL)=(provisioning_started_at IS NULL)))),
  -- Preserve the original SQL NULL semantics: do not turn nullable native jsonb/hash checks into invented NOT NULL.
  CHECK(state='displaced' OR (state IN ('awaiting_deployment','pending') AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL
      AND delete_idempotency_sha256 IS NULL AND delete_request_sha256 IS NULL AND deleted_at IS NULL)
    OR (state='active' AND json_type(custom_hostname_receipt)='object' AND json_type(worker_route_receipt)='object' AND deleted_at IS NULL)
    OR (state IN ('deleting','deleted') AND ((json_type(custom_hostname_receipt)='object' AND json_type(worker_route_receipt)='object')
      OR (custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL))
      AND length(delete_idempotency_sha256)=32 AND length(delete_request_sha256)=32
      AND (deleted_at IS NULL)=(state='deleting')))
) STRICT, WITHOUT ROWID;
INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,custom_hostname_receipt,worker_route_receipt,delete_idempotency_sha256,delete_request_sha256,created_at,updated_at,deleted_at,provisioning_started_at,hostname_proven_at) SELECT organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,custom_hostname_receipt,worker_route_receipt,delete_idempotency_sha256,delete_request_sha256,created_at,updated_at,deleted_at,provisioning_started_at,hostname_proven_at FROM paid_project_domains_copy_0642;
DROP TABLE paid_project_domains_copy_0642;
CREATE INDEX paid_project_domains_hostname_idx ON paid_project_domains(hostname) WHERE custom_hostname_receipt IS NOT NULL;
CREATE UNIQUE INDEX paid_project_domains_live_hostname ON paid_project_domains(hostname)
WHERE state<>'deleted' AND hostname_proven_at IS NOT NULL;
CREATE TRIGGER paid_project_domains_native_hostname_insert BEFORE INSERT ON paid_project_domains
BEGIN
  SELECT RAISE(ABORT,'Invalid paid domain hostname') WHERE NEW.hostname GLOB '*[^a-z0-9.-]*' OR instr(NEW.hostname,'.')=0;
  SELECT RAISE(ABORT,'Invalid paid domain hostname') WHERE EXISTS(
    SELECT 1 FROM json_each('["'||replace(NEW.hostname,'.','","')||'"]')
    WHERE length(value) NOT BETWEEN 1 AND 63 OR substr(value,1,1) NOT GLOB '[a-z0-9]'
      OR substr(value,-1) NOT GLOB '[a-z0-9]');
  SELECT RAISE(ABORT,'Invalid paid domain hostname') WHERE EXISTS(
    SELECT 1 FROM json_each('["'||replace(NEW.hostname,'.','","')||'"]')
    WHERE CAST(key AS INTEGER)=json_array_length('["'||replace(NEW.hostname,'.','","')||'"]')-1
      AND (length(value) NOT BETWEEN 2 AND 63 OR value GLOB '*[^a-z]*'));
END;
CREATE TRIGGER paid_project_domains_native_hostname_update BEFORE UPDATE OF hostname ON paid_project_domains
BEGIN
  SELECT RAISE(ABORT,'Invalid paid domain hostname') WHERE NEW.hostname GLOB '*[^a-z0-9.-]*' OR instr(NEW.hostname,'.')=0;
  SELECT RAISE(ABORT,'Invalid paid domain hostname') WHERE EXISTS(
    SELECT 1 FROM json_each('["'||replace(NEW.hostname,'.','","')||'"]')
    WHERE length(value) NOT BETWEEN 1 AND 63 OR substr(value,1,1) NOT GLOB '[a-z0-9]'
      OR substr(value,-1) NOT GLOB '[a-z0-9]');
  SELECT RAISE(ABORT,'Invalid paid domain hostname') WHERE EXISTS(
    SELECT 1 FROM json_each('["'||replace(NEW.hostname,'.','","')||'"]')
    WHERE CAST(key AS INTEGER)=json_array_length('["'||replace(NEW.hostname,'.','","')||'"]')-1
      AND (length(value) NOT BETWEEN 2 AND 63 OR value GLOB '*[^a-z]*'));
END;
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
CREATE TRIGGER native_auth_custom_origin_lost AFTER UPDATE OF state,deleted_at,hostname,gateway_script_name,custom_hostname_receipt,worker_route_receipt ON paid_project_domains
WHEN OLD.state='active' AND (NEW.state<>'active' OR NEW.deleted_at IS NOT NULL OR NEW.hostname<>OLD.hostname OR NEW.gateway_script_name IS NOT 'ohmyho-gateway-production' OR NEW.custom_hostname_receipt IS NULL OR NEW.worker_route_receipt IS NULL)
BEGIN
  UPDATE native_auth_providers SET last_success_at=NULL WHERE (organization_id,project_id,environment_id) IN
    (SELECT organization_id,project_id,environment_id FROM native_auth_realms WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin='https://'||OLD.hostname);
  UPDATE native_auth_realms SET canonical_origin=NULL,configuration_revision=configuration_revision+1,revocation_epoch=revocation_epoch+1
   WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin='https://'||OLD.hostname;
END;
CREATE TRIGGER native_auth_custom_origin_deleted AFTER DELETE ON paid_project_domains
BEGIN
  UPDATE native_auth_providers SET last_success_at=NULL WHERE (organization_id,project_id,environment_id) IN
    (SELECT organization_id,project_id,environment_id FROM native_auth_realms WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin='https://'||OLD.hostname);
  UPDATE native_auth_realms SET canonical_origin=NULL,configuration_revision=configuration_revision+1,revocation_epoch=revocation_epoch+1
   WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin='https://'||OLD.hostname;
END;
