-- Q4-A: registrations of a physical data environment's database (PostgreSQL migrations 141, 165, 202, 220).
-- `metadata` is the sorted-key compact JSON of the registration (never a connection string or secret), so equality of
-- two registrations is equality of their text. The exact key set is enforced by the BEFORE INSERT triggers (a CHECK
-- cannot hold a subquery). A reservation is deleted only after its receipt exists (retention).

CREATE TABLE project_database_registration_reservations (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  operation_id             TEXT    NOT NULL,
  claim_id                 TEXT    NOT NULL CHECK (length(claim_id) = 26),
  registration_version     INTEGER NOT NULL CHECK (registration_version > 0),
  metadata                 TEXT    NOT NULL CHECK (json_valid(metadata) AND json_type(metadata) = 'object'
    AND json_extract(metadata, '$.organizationId') = organization_id AND json_extract(metadata, '$.projectId') = project_id
    AND json_extract(metadata, '$.physicalEnvironmentId') = physical_environment_id AND json_extract(metadata, '$.operationId') = operation_id
    AND json_extract(metadata, '$.registrationVersion') = registration_version
    AND json_extract(metadata, '$.status') IN ('active', 'revoked') AND json_extract(metadata, '$.region') IN ('us', 'eu')
    AND json_extract(metadata, '$.originUser') = 'ohmyho_rw_' || lower(physical_environment_id)
    AND json_type(metadata, '$.authorizedEnvironmentIds') = 'array' AND json_array_length(metadata, '$.authorizedEnvironmentIds') BETWEEN 1 AND 2
    AND ((json_extract(metadata, '$.provider') = 'pgcf'
          AND json_extract(metadata, '$.originDatabase') = json_extract(metadata, '$.databaseId')
          AND length(json_extract(metadata, '$.providerProjectId')) = 24 AND substr(json_extract(metadata, '$.providerProjectId'), 1, 4) = 'prj_'
          AND length(json_extract(metadata, '$.databaseId')) = 20 AND substr(json_extract(metadata, '$.databaseId'), 1, 1) GLOB '[a-z]')
      OR (json_extract(metadata, '$.provider') IS NULL
          AND json_extract(metadata, '$.originDatabase') = 'neondb' AND json_type(metadata, '$.branchId') = 'text'))),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, registration_version),
  FOREIGN KEY (organization_id, project_id, physical_environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE project_database_registration_receipts (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  operation_id             TEXT    NOT NULL,
  claim_id                 TEXT    NOT NULL CHECK (length(claim_id) = 26),
  registration_version     INTEGER NOT NULL CHECK (registration_version > 0),
  status                   TEXT    NOT NULL CHECK (status IN ('active', 'revoked')),
  metadata                 TEXT    NOT NULL CHECK (json_valid(metadata) AND json_type(metadata) = 'object'
    AND json_extract(metadata, '$.organizationId') = organization_id AND json_extract(metadata, '$.projectId') = project_id
    AND json_extract(metadata, '$.physicalEnvironmentId') = physical_environment_id AND json_extract(metadata, '$.operationId') = operation_id
    AND json_extract(metadata, '$.registrationVersion') = registration_version AND json_extract(metadata, '$.status') = status
    AND json_extract(metadata, '$.region') IN ('us', 'eu')
    AND json_extract(metadata, '$.originUser') = 'ohmyho_rw_' || lower(physical_environment_id)
    AND json_type(metadata, '$.authorizedEnvironmentIds') = 'array' AND json_array_length(metadata, '$.authorizedEnvironmentIds') BETWEEN 1 AND 2
    AND ((json_extract(metadata, '$.provider') = 'pgcf'
          AND json_extract(metadata, '$.originDatabase') = json_extract(metadata, '$.databaseId')
          AND length(json_extract(metadata, '$.providerProjectId')) = 24 AND substr(json_extract(metadata, '$.providerProjectId'), 1, 4) = 'prj_'
          AND length(json_extract(metadata, '$.databaseId')) = 20 AND substr(json_extract(metadata, '$.databaseId'), 1, 1) GLOB '[a-z]')
      OR (json_extract(metadata, '$.provider') IS NULL
          AND json_extract(metadata, '$.originDatabase') = 'neondb' AND json_type(metadata, '$.branchId') = 'text'))),
  observed_at              TEXT    NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, registration_version),
  FOREIGN KEY (organization_id, project_id, physical_environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER project_database_registration_reservations_shape BEFORE INSERT ON project_database_registration_reservations
  WHEN (SELECT count(*) FROM json_each(NEW.metadata)) <> CASE json_extract(NEW.metadata, '$.provider') WHEN 'pgcf' THEN 14 ELSE 13 END
BEGIN SELECT RAISE(ABORT, 'registration metadata has an unexpected key set'); END;
CREATE TRIGGER project_database_registration_receipts_shape BEFORE INSERT ON project_database_registration_receipts
  WHEN (SELECT count(*) FROM json_each(NEW.metadata)) <> CASE json_extract(NEW.metadata, '$.provider') WHEN 'pgcf' THEN 14 ELSE 13 END
BEGIN SELECT RAISE(ABORT, 'registration metadata has an unexpected key set'); END;
CREATE TRIGGER project_database_registration_reservations_no_update BEFORE UPDATE ON project_database_registration_reservations
BEGIN SELECT RAISE(ABORT, 'project_database_registration_reservations is append-only'); END;
CREATE TRIGGER project_database_registration_reservations_delete_after_receipt BEFORE DELETE ON project_database_registration_reservations
  WHEN NOT EXISTS (SELECT 1 FROM project_database_registration_receipts receipt WHERE receipt.organization_id = OLD.organization_id AND receipt.project_id = OLD.project_id AND receipt.physical_environment_id = OLD.physical_environment_id AND receipt.registration_version = OLD.registration_version AND receipt.metadata = OLD.metadata)
BEGIN SELECT RAISE(ABORT, 'a registration reservation is deleted only after its receipt exists'); END;
CREATE TRIGGER project_database_registration_receipts_no_update BEFORE UPDATE ON project_database_registration_receipts
BEGIN SELECT RAISE(ABORT, 'project_database_registration_receipts is append-only'); END;
CREATE TRIGGER project_database_registration_receipts_no_delete BEFORE DELETE ON project_database_registration_receipts
BEGIN SELECT RAISE(ABORT, 'project_database_registration_receipts is append-only'); END;

-- The applied SQL migration bundle of one deploy against the PGCF database (its writer is a later F10 milestone).
CREATE TABLE pgcf_database_migration_receipts (
  organization_id          TEXT    NOT NULL,
  project_id               TEXT    NOT NULL,
  physical_environment_id  TEXT    NOT NULL,
  operation_id             TEXT    NOT NULL,
  claim_id                 TEXT    NOT NULL CHECK (length(claim_id) = 26),
  provider_project_id      TEXT    NOT NULL CHECK (length(provider_project_id) = 24 AND substr(provider_project_id, 1, 4) = 'prj_' AND substr(provider_project_id, 5) NOT GLOB '*[^a-z0-9]*'),
  database_id              TEXT    NOT NULL CHECK (length(database_id) = 20 AND substr(database_id, 1, 1) GLOB '[a-z]' AND database_id NOT GLOB '*[^a-z0-9]*'),
  bundle_sha256            BLOB    NOT NULL CHECK (length(bundle_sha256) = 32),
  applied_paths            TEXT    NOT NULL CHECK (json_valid(applied_paths) AND json_type(applied_paths) = 'array'),
  replayed_paths           TEXT    NOT NULL CHECK (json_valid(replayed_paths) AND json_type(replayed_paths) = 'array'),
  completed_at             TEXT    NOT NULL CHECK (completed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, physical_environment_id, operation_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER pgcf_database_migration_receipts_no_update BEFORE UPDATE ON pgcf_database_migration_receipts
BEGIN SELECT RAISE(ABORT, 'pgcf_database_migration_receipts is append-only'); END;
CREATE TRIGGER pgcf_database_migration_receipts_no_delete BEFORE DELETE ON pgcf_database_migration_receipts
BEGIN SELECT RAISE(ABORT, 'pgcf_database_migration_receipts is append-only'); END;
