-- W32 original103 notes and original156 powered-by request facts. Existing0323 period history remains intact.
-- New tables carry original source bytes and constraints; no source fact, writer or default is invented.
CREATE TABLE project_agent_notes (
 project_id TEXT PRIMARY KEY REFERENCES project_identities(project_id) CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
 markdown TEXT NOT NULL CHECK(instr(markdown,char(0))=0 AND length(CAST(markdown AS BLOB))<=16384 AND (CASE WHEN markdown='' THEN 0 ELSE length(markdown)-length(replace(markdown,char(10),''))+1 END)<=250),
 updated_at TEXT NOT NULL CHECK(length(updated_at)=27 AND length(CAST(updated_at AS BLOB))=27 AND updated_at GLOB '????-??-??T??:??:??.??????Z' AND substr(updated_at,1,4)<>'0000' AND substr(updated_at,1,4) NOT GLOB '*[^0-9]*' AND substr(updated_at,6,2) NOT GLOB '*[^0-9]*' AND substr(updated_at,9,2) NOT GLOB '*[^0-9]*' AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND substr(updated_at,15,2) BETWEEN '00' AND '59' AND substr(updated_at,18,2) BETWEEN '00' AND '59' AND substr(updated_at,21,6) NOT GLOB '*[^0-9]*' AND date(substr(updated_at,1,10)) IS substr(updated_at,1,10))
) STRICT, WITHOUT ROWID;
CREATE TABLE project_agent_note_requests (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL REFERENCES project_identities(project_id) CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256 AND instr(actor_id,char(0))=0),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND instr(idempotency_key,char(0))=0),
 request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
 updated_at TEXT NOT NULL CHECK(length(updated_at)=27 AND length(CAST(updated_at AS BLOB))=27 AND updated_at GLOB '????-??-??T??:??:??.??????Z' AND substr(updated_at,1,4)<>'0000' AND substr(updated_at,1,4) NOT GLOB '*[^0-9]*' AND substr(updated_at,6,2) NOT GLOB '*[^0-9]*' AND substr(updated_at,9,2) NOT GLOB '*[^0-9]*' AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND substr(updated_at,15,2) BETWEEN '00' AND '59' AND substr(updated_at,18,2) BETWEEN '00' AND '59' AND substr(updated_at,21,6) NOT GLOB '*[^0-9]*' AND date(substr(updated_at,1,10)) IS substr(updated_at,1,10)),
 PRIMARY KEY(organization_id,project_id,actor_id,idempotency_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE project_powered_by_flag_requests (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL REFERENCES project_identities(project_id) CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256 AND instr(actor_id,char(0))=0),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND instr(idempotency_key,char(0))=0),
 request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 enabled_at TEXT CHECK(enabled_at IS NULL OR(length(enabled_at)=27 AND length(CAST(enabled_at AS BLOB))=27 AND enabled_at GLOB '????-??-??T??:??:??.??????Z' AND substr(enabled_at,1,4)<>'0000' AND substr(enabled_at,1,4) NOT GLOB '*[^0-9]*' AND substr(enabled_at,6,2) NOT GLOB '*[^0-9]*' AND substr(enabled_at,9,2) NOT GLOB '*[^0-9]*' AND substr(enabled_at,12,2) BETWEEN '00' AND '23' AND substr(enabled_at,15,2) BETWEEN '00' AND '59' AND substr(enabled_at,18,2) BETWEEN '00' AND '59' AND substr(enabled_at,21,6) NOT GLOB '*[^0-9]*' AND date(substr(enabled_at,1,10)) IS substr(enabled_at,1,10))),
 recorded_at TEXT NOT NULL CHECK(length(recorded_at)=27 AND length(CAST(recorded_at AS BLOB))=27 AND recorded_at GLOB '????-??-??T??:??:??.??????Z' AND substr(recorded_at,1,4)<>'0000' AND substr(recorded_at,1,4) NOT GLOB '*[^0-9]*' AND substr(recorded_at,6,2) NOT GLOB '*[^0-9]*' AND substr(recorded_at,9,2) NOT GLOB '*[^0-9]*' AND substr(recorded_at,12,2) BETWEEN '00' AND '23' AND substr(recorded_at,15,2) BETWEEN '00' AND '59' AND substr(recorded_at,18,2) BETWEEN '00' AND '59' AND substr(recorded_at,21,6) NOT GLOB '*[^0-9]*' AND date(substr(recorded_at,1,10)) IS substr(recorded_at,1,10)),
 CHECK(enabled=(enabled_at IS NOT NULL)),
 PRIMARY KEY(organization_id,project_id,actor_id,idempotency_key)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER purge_deleted_project_agent_notes AFTER UPDATE OF lifecycle_state ON projects
 WHEN NEW.lifecycle_state='deleted'
BEGIN DELETE FROM project_agent_notes WHERE project_id=NEW.project_id; END;
