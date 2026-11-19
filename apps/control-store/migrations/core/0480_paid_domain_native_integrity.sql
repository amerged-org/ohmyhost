-- Exact original paid-domain source constraints (072/075/143/145), preserving existing0391 notices.
-- This is ONE migration batch. Original rows/opaque JSON/bytea/instants remain byte-for-byte; no domain API,
-- metadata wake, owner change, price or valuation is produced by copying them into the replacement table.
CREATE TABLE paid_project_domains_copy_0480 AS SELECT * FROM paid_project_domains;
DROP TABLE paid_project_domains;
CREATE TABLE paid_project_domains (
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  hostname TEXT NOT NULL CHECK(hostname=lower(hostname) AND length(hostname)<=253),
  gateway_script_name TEXT,
  state TEXT NOT NULL CHECK(state IN ('awaiting_deployment','pending','active','deleting','deleted')),
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
  CHECK((state='awaiting_deployment' AND gateway_script_name IS NULL AND provisioning_started_at IS NULL)
    OR (state IN ('pending','active') AND gateway_script_name IS NOT NULL AND provisioning_started_at IS NOT NULL)
    OR (state IN ('deleting','deleted') AND ((gateway_script_name IS NULL AND provisioning_started_at IS NULL
      AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL) OR (gateway_script_name IS NOT NULL AND provisioning_started_at IS NOT NULL)))),
  CHECK(provisioning_started_at IS NULL OR provisioning_started_at>=created_at),
  -- Preserve the original SQL NULL semantics: do not turn nullable native jsonb/hash checks into invented NOT NULL.
  CHECK((state IN ('awaiting_deployment','pending') AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL
      AND delete_idempotency_sha256 IS NULL AND delete_request_sha256 IS NULL AND deleted_at IS NULL)
    OR (state='active' AND json_type(custom_hostname_receipt)='object' AND json_type(worker_route_receipt)='object' AND deleted_at IS NULL)
    OR (state IN ('deleting','deleted') AND ((json_type(custom_hostname_receipt)='object' AND json_type(worker_route_receipt)='object')
      OR (custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL))
      AND length(delete_idempotency_sha256)=32 AND length(delete_request_sha256)=32
      AND (deleted_at IS NULL)=(state='deleting')))
) STRICT, WITHOUT ROWID;

-- Exact ASCII hostname grammar of native075. A fixed JSON split is safe only AFTER the character guard below.
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

-- Exact ASCII hostname grammar of native075. A fixed JSON split is safe only AFTER the character guard below.
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

INSERT INTO paid_project_domains SELECT * FROM paid_project_domains_copy_0480;
DROP TABLE paid_project_domains_copy_0480;
CREATE UNIQUE INDEX paid_project_domains_live_hostname ON paid_project_domains(hostname) WHERE state<>'deleted';
CREATE INDEX paid_project_domains_hostname_idx ON paid_project_domains(hostname) WHERE custom_hostname_receipt IS NOT NULL;
CREATE TRIGGER paid_project_domains_lifetime_notice AFTER INSERT ON paid_project_domains WHEN NEW.custom_hostname_receipt IS NOT NULL BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,source_kind,resource_reference,organization_id,project_id) VALUES('resource','domain',coalesce(NEW.provisioning_started_at,NEW.created_at),'custom-hostname',NEW.hostname,NEW.organization_id,NEW.project_id); END;
CREATE TRIGGER paid_project_domains_lifetime_notice_update AFTER UPDATE ON paid_project_domains
WHEN (OLD.custom_hostname_receipt IS NOT NULL OR NEW.custom_hostname_receipt IS NOT NULL)
AND (OLD.hostname IS NOT NEW.hostname OR OLD.organization_id IS NOT NEW.organization_id OR OLD.project_id IS NOT NEW.project_id OR (OLD.custom_hostname_receipt IS NULL) IS NOT (NEW.custom_hostname_receipt IS NULL) OR OLD.provisioning_started_at IS NOT NEW.provisioning_started_at OR OLD.deleted_at IS NOT NEW.deleted_at)
BEGIN
 INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,source_kind,resource_reference,organization_id,project_id)
 SELECT 'resource','domain',coalesce((SELECT min(v) FROM (SELECT CASE WHEN OLD.hostname IS NOT NEW.hostname OR OLD.organization_id IS NOT NEW.organization_id OR OLD.project_id IS NOT NEW.project_id OR (OLD.custom_hostname_receipt IS NULL) IS NOT (NEW.custom_hostname_receipt IS NULL) THEN coalesce(NEW.provisioning_started_at,NEW.created_at) END AS v UNION ALL SELECT CASE WHEN OLD.provisioning_started_at IS NOT NEW.provisioning_started_at THEN min(coalesce(OLD.provisioning_started_at,OLD.created_at),coalesce(NEW.provisioning_started_at,NEW.created_at)) END AS v UNION ALL SELECT CASE WHEN OLD.deleted_at IS NOT NEW.deleted_at THEN (SELECT min(v) FROM (SELECT OLD.deleted_at AS v UNION ALL SELECT NEW.deleted_at AS v)) END AS v)),coalesce(NEW.provisioning_started_at,NEW.created_at)),'custom-hostname',NEW.hostname,NEW.organization_id,NEW.project_id WHERE NEW.custom_hostname_receipt IS NOT NULL;
 INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,source_kind,resource_reference,organization_id,project_id)
 SELECT 'resource','domain',coalesce(OLD.provisioning_started_at,OLD.created_at),'custom-hostname',OLD.hostname,OLD.organization_id,OLD.project_id WHERE OLD.custom_hostname_receipt IS NOT NULL AND (OLD.hostname IS NOT NEW.hostname OR OLD.organization_id IS NOT NEW.organization_id OR OLD.project_id IS NOT NEW.project_id OR (OLD.custom_hostname_receipt IS NULL) IS NOT (NEW.custom_hostname_receipt IS NULL));
END;
