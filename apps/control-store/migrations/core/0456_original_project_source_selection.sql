-- Original009/171/173 source selection history, independent of the current project_source_bindings row.
-- Native ready-grant/binding effects belong to the same closed live SourceLink completion batch;
-- historical import supplies the captured current binding, never chronologically recreates a generation.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE project_sources (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 source_id TEXT NOT NULL CHECK(length(source_id)=26 AND length(CAST(source_id AS BLOB))=26 AND substr(source_id,1,1) BETWEEN '0' AND '7' AND source_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 billing_epoch_id TEXT NOT NULL CHECK(length(billing_epoch_id)=26 AND length(CAST(billing_epoch_id AS BLOB))=26 AND substr(billing_epoch_id,1,1) BETWEEN '0' AND '7' AND billing_epoch_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 grant_id TEXT NOT NULL CHECK(length(grant_id)=26 AND length(CAST(grant_id AS BLOB))=26 AND substr(grant_id,1,1) BETWEEN '0' AND '7' AND grant_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 provider TEXT NOT NULL CHECK(provider IN('github','managed')),
 installation_id TEXT CHECK(installation_id IS NULL OR instr(installation_id,char(0))=0),
 external_repository_id TEXT NOT NULL CHECK(instr(external_repository_id,char(0))=0),
 repository_owner TEXT NOT NULL CHECK(instr(repository_owner,char(0))=0),repository_name TEXT NOT NULL CHECK(instr(repository_name,char(0))=0),
 state TEXT NOT NULL CHECK(state IN('pending','ready','failed','revoked')),failure_code TEXT CHECK(failure_code IS NULL OR instr(failure_code,char(0))=0),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
 created_at TEXT NOT NULL CHECK((created_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(created_at AS BLOB))=27 AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)||substr(created_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59') IS TRUE),updated_at TEXT NOT NULL CHECK((updated_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(updated_at AS BLOB))=27 AND substr(updated_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(updated_at,1,10),'+0 days')=substr(updated_at,1,10) AND (substr(updated_at,12,2)||substr(updated_at,15,2)||substr(updated_at,18,2)||substr(updated_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND substr(updated_at,15,2) BETWEEN '00' AND '59' AND substr(updated_at,18,2) BETWEEN '00' AND '59') IS TRUE),
 PRIMARY KEY(organization_id,project_id,source_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,project_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,project_id,billing_epoch_id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,project_id,grant_id) REFERENCES repository_grants(organization_id,project_id,grant_id) ON DELETE RESTRICT,
 CHECK(updated_at>=created_at AND ((provider='github' AND installation_id IS NOT NULL) OR(provider='managed' AND installation_id IS NULL))
 AND((state='failed' AND failure_code IS NOT NULL) OR(state<>'failed' AND failure_code IS NULL)))
) STRICT, WITHOUT ROWID;

-- Original171/173 generation is int4. Refuse a prototype overflow without rewriting it.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM project_source_bindings WHERE generation NOT BETWEEN 1 AND 2147483647);
CREATE TRIGGER project_source_bindings_original_generation_insert BEFORE INSERT ON project_source_bindings WHEN NEW.generation NOT BETWEEN 1 AND 2147483647 BEGIN SELECT RAISE(ABORT,'source generation exceeds native int4'); END;
CREATE TRIGGER project_source_bindings_original_generation_update BEFORE UPDATE ON project_source_bindings WHEN NEW.generation NOT BETWEEN 1 AND 2147483647 BEGIN SELECT RAISE(ABORT,'source generation exceeds native int4'); END;
