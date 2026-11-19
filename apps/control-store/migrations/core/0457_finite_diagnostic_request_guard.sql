-- Source-only finite predicate repair after0454. D1 rejects the overlong Unicode GLOB pattern.
-- Preserve the original21 diagnostic fields/constraints/data and exact whitespace policy.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE _0457_deployment_diagnostics AS SELECT * FROM deployment_diagnostics;
DROP TABLE deployment_diagnostics;
CREATE TABLE deployment_diagnostics (
 diagnostic_event_id TEXT NOT NULL PRIMARY KEY CHECK(length(diagnostic_event_id)=26 AND length(CAST(diagnostic_event_id AS BLOB))=26 AND diagnostic_event_id GLOB '[0-7]*' AND diagnostic_event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL,project_id TEXT NOT NULL,environment_id TEXT NOT NULL,deployment_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN('build','control','runtime','function')),
 code TEXT NOT NULL CHECK(instr(code,char(0))=0 AND length(code) BETWEEN 2 AND 64 AND code GLOB '[A-Z]*' AND code NOT GLOB '*[^A-Z0-9_]*'),
 catalog_message TEXT NOT NULL CHECK(instr(catalog_message,char(0))=0 AND length(catalog_message) BETWEEN 2 AND 128 AND catalog_message GLOB '[A-Z]*' AND catalog_message NOT GLOB '*[^A-Z0-9_]*'),
 exception_class TEXT CHECK(exception_class IS NULL OR(instr(exception_class,char(0))=0 AND length(exception_class) BETWEEN 1 AND 128 AND exception_class GLOB '[A-Za-z]*' AND exception_class NOT GLOB '*[^A-Za-z0-9_.]*')),
 source_file TEXT CHECK(source_file IS NULL OR(length(source_file) BETWEEN 1 AND 512 AND source_file NOT LIKE '/%' AND source_file NOT LIKE '%..%' AND instr(source_file,char(0))=0 AND source_file NOT GLOB '*['||char(1)||'-'||char(31)||char(127)||'-'||char(159)||']*')),
 source_line INTEGER CHECK(source_line IS NULL OR source_line BETWEEN -2147483648 AND 2147483647),
 source_column INTEGER CHECK(source_column IS NULL OR source_column BETWEEN -2147483648 AND 2147483647),
 route_template TEXT CHECK(route_template IS NULL OR(instr(route_template,char(0))=0 AND route_template LIKE '/%' AND length(route_template)<=512 AND route_template NOT LIKE '%?%')),
 request_id TEXT CHECK(request_id IS NULL OR(length(request_id) BETWEEN 1 AND 128 AND instr(request_id,char(0))=0 AND request_id NOT GLOB '*['||char(1)||'-'||char(32)||char(127)||'-'||char(159)||']*' AND instr(request_id,char(160))=0 AND instr(request_id,char(5760))=0 AND instr(request_id,char(8192))=0 AND instr(request_id,char(8193))=0 AND instr(request_id,char(8194))=0 AND instr(request_id,char(8195))=0 AND instr(request_id,char(8196))=0 AND instr(request_id,char(8197))=0 AND instr(request_id,char(8198))=0 AND instr(request_id,char(8199))=0 AND instr(request_id,char(8200))=0 AND instr(request_id,char(8201))=0 AND instr(request_id,char(8202))=0 AND instr(request_id,char(8232))=0 AND instr(request_id,char(8233))=0 AND instr(request_id,char(8239))=0 AND instr(request_id,char(8287))=0 AND instr(request_id,char(12288))=0)),
 trace_id TEXT CHECK(trace_id IS NULL OR(instr(trace_id,char(0))=0 AND length(trace_id) BETWEEN 1 AND 128 AND trace_id NOT GLOB '*[^A-Za-z0-9_-]*')),
 duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms BETWEEN 0 AND 900000),
 occurred_at TEXT NOT NULL CHECK((occurred_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(occurred_at AS BLOB))=27 AND substr(occurred_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(occurred_at,1,10),'+0 days')=substr(occurred_at,1,10) AND (substr(occurred_at,12,2)||substr(occurred_at,15,2)||substr(occurred_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(occurred_at,12,2) BETWEEN '00' AND '23' AND substr(occurred_at,15,2) BETWEEN '00' AND '59' AND substr(occurred_at,18,2) BETWEEN '00' AND '59' AND substr(occurred_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE),
 recorded_at TEXT NOT NULL CHECK((recorded_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(recorded_at AS BLOB))=27 AND substr(recorded_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(recorded_at,1,10),'+0 days')=substr(recorded_at,1,10) AND (substr(recorded_at,12,2)||substr(recorded_at,15,2)||substr(recorded_at,18,2)) NOT GLOB '*[^0-9]*' AND substr(recorded_at,12,2) BETWEEN '00' AND '23' AND substr(recorded_at,15,2) BETWEEN '00' AND '59' AND substr(recorded_at,18,2) BETWEEN '00' AND '59' AND substr(recorded_at,21,6) NOT GLOB '*[^0-9]*') IS TRUE),
 excerpt TEXT,excerpt_truncated INTEGER CHECK(excerpt_truncated IS NULL OR excerpt_truncated IN(0,1)),status_code INTEGER,
 FOREIGN KEY(organization_id,project_id,environment_id,deployment_id) REFERENCES deployments(organization_id,project_id,environment_id,deployment_id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id) ON DELETE RESTRICT,
 CHECK((source_line IS NULL AND source_column IS NULL) OR(source_line>0 AND source_column>=0)),
 CHECK(occurred_at<=recorded_at AND occurred_at>=strftime('%Y-%m-%dT%H:%M:%S',recorded_at,'-7 days')||substr(recorded_at,20)),
 CHECK((excerpt IS NULL)=(excerpt_truncated IS NULL)),
 CHECK(excerpt IS NULL OR(code IN('BUILD_FAILED','HEALTH_CHECK_FAILED') AND length(excerpt) BETWEEN 1 AND 16384 AND instr(excerpt,char(0))=0
  AND excerpt NOT GLOB '*['||char(1)||'-'||char(8)||char(11)||char(12)||char(14)||'-'||char(31)||char(127)||'-'||char(159)||']*'
  AND substr(excerpt,-1) NOT IN(char(9),char(10),char(11),char(12),char(13),' ',char(133),char(160),char(5760),char(8192),char(8193),char(8194),char(8195),char(8196),char(8197),char(8198),char(8199),char(8200),char(8201),char(8202),char(8232),char(8233),char(8239),char(8287),char(12288)))),
 CHECK(status_code IS NULL OR(code='HEALTH_CHECK_FAILED' AND status_code BETWEEN 100 AND 599))
) STRICT, WITHOUT ROWID;
CREATE INDEX deployment_diagnostics_scope_order_idx ON deployment_diagnostics(organization_id,project_id,environment_id,occurred_at,diagnostic_event_id);
INSERT INTO deployment_diagnostics SELECT * FROM _0457_deployment_diagnostics;
DROP TABLE _0457_deployment_diagnostics;
