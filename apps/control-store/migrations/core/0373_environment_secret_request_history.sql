-- Original014/058 request history includes pending accepted mutations. Preserve opaque JSON bytes and old scope.
-- Source-invalid prototype rows refuse the atomic forward copy; no pending response or current environment is invented.
CREATE TABLE environment_secret_requests_0373 (
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  action TEXT NOT NULL CHECK(action IN ('set','delete')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128 AND substr(name,1,1) GLOB '[A-Z]' AND name NOT GLOB '*[^A-Z0-9_]*'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key=trim(idempotency_key)),
  request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),
  response TEXT CHECK(response IS NULL OR (json_valid(response) AND json_type(response)='object')),
  requested_at TEXT NOT NULL CHECK(requested_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at TEXT CHECK(completed_at IS NULL OR (completed_at GLOB '????-??-??T??:??:??.??????Z' AND completed_at>=requested_at)),
  PRIMARY KEY(organization_id,project_id,environment_id,action,idempotency_key),
  FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id) ON DELETE CASCADE,
  CHECK((response IS NULL)=(completed_at IS NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO environment_secret_requests_0373(organization_id,project_id,environment_id,action,name,idempotency_key,request_sha256,response,requested_at,completed_at)
 SELECT organization_id,project_id,environment_id,action,name,idempotency_key,request_sha256,response,requested_at,completed_at FROM environment_secret_requests;
DROP TABLE environment_secret_requests;
ALTER TABLE environment_secret_requests_0373 RENAME TO environment_secret_requests;
CREATE INDEX environment_secret_requests_purge ON environment_secret_requests (completed_at);
