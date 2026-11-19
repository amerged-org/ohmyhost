-- Actual original001 provider_resources, distinct from run_resource_inventory and provider-specific receipts.
-- Preserve nine captured fields, native mutable state and original timestamp infinity ordering; seed no evidence.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE provider_resources(
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 operation_id TEXT NOT NULL CHECK(length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 capability TEXT NOT NULL CHECK(capability IN('static-hosting','edge-runtime','build','database','domain','mail','usage')),
 provider TEXT NOT NULL CHECK(instr(provider,char(0))=0 AND provider=trim(provider) AND length(provider) BETWEEN 1 AND 128),
 external_id TEXT NOT NULL CHECK(instr(external_id,char(0))=0 AND external_id=trim(external_id) AND length(external_id) BETWEEN 1 AND 512),
 created_at TEXT NOT NULL CHECK(created_at IN('-infinity','+infinity') OR (created_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(created_at AS BLOB))=27 AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)||substr(created_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59') IS TRUE),
 observed_at TEXT NOT NULL CHECK(observed_at IN('-infinity','+infinity') OR (observed_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(observed_at AS BLOB))=27 AND substr(observed_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(observed_at,1,10),'+0 days')=substr(observed_at,1,10) AND (substr(observed_at,12,2)||substr(observed_at,15,2)||substr(observed_at,18,2)||substr(observed_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(observed_at,12,2) BETWEEN '00' AND '23' AND substr(observed_at,15,2) BETWEEN '00' AND '59' AND substr(observed_at,18,2) BETWEEN '00' AND '59') IS TRUE),
 state TEXT NOT NULL CHECK(state IN('pending','ready','failed','removed')),
 PRIMARY KEY(organization_id,operation_id,capability),
 FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
 CHECK(created_at='-infinity' OR observed_at='+infinity' OR(created_at NOT IN('-infinity','+infinity') AND observed_at NOT IN('-infinity','+infinity') AND observed_at>=created_at))
) STRICT, WITHOUT ROWID;
CREATE INDEX provider_resources_external_idx ON provider_resources(capability,provider,external_id);
