-- core-v1 source: migrations/shard/0011_project_operation_guards.sql
-- Triggers that replace the PL/pgSQL scope, identity and state guards of the project and operation tables.
-- The commit-time rules (exact environment set, data mode against assignments, completed idempotency record) are
-- assertions at the end of the creating batch; everything checkable at statement time is a trigger here.

CREATE TRIGGER operations_require_current_owner BEFORE INSERT ON operations
  WHEN NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id AND owner_state = 'active')
BEGIN SELECT RAISE(ABORT, 'operation requires a project the organization actively owns'); END;

CREATE TRIGGER operations_scope_immutable BEFORE UPDATE OF organization_id, project_id, billing_epoch_id ON operations
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id OR NEW.billing_epoch_id IS NOT OLD.billing_epoch_id
BEGIN SELECT RAISE(ABORT, 'operation scope is immutable'); END;

CREATE TRIGGER outbox_events_scope_immutable BEFORE UPDATE OF organization_id, project_id, billing_epoch_id ON outbox_events
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id OR NEW.billing_epoch_id IS NOT OLD.billing_epoch_id
BEGIN SELECT RAISE(ABORT, 'outbox event scope is immutable'); END;

CREATE TRIGGER environments_require_current_owner BEFORE INSERT ON environments
  WHEN NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id AND owner_state = 'active')
BEGIN SELECT RAISE(ABORT, 'environment requires a project the organization actively owns'); END;

CREATE TRIGGER environments_identity_immutable BEFORE UPDATE ON environments
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.environment_id IS NOT OLD.environment_id
    OR NEW.project_id IS NOT OLD.project_id OR NEW.name IS NOT OLD.name OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'environment identity is immutable'); END;

CREATE TRIGGER environments_no_delete BEFORE DELETE ON environments
BEGIN SELECT RAISE(ABORT, 'environments are never deleted'); END;

CREATE TRIGGER projects_identity_immutable BEFORE UPDATE ON projects
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
    OR NEW.created_organization_id IS NOT OLD.created_organization_id OR NEW.name IS NOT OLD.name
    OR NEW.created_event_id IS NOT OLD.created_event_id OR NEW.created_at IS NOT OLD.created_at
    OR ((NEW.handle IS NOT OLD.handle OR NEW.handle_version IS NOT OLD.handle_version OR NEW.handle_attempt IS NOT OLD.handle_attempt)
        AND NOT (NEW.handle IS NOT OLD.handle AND NEW.handle_version = 'customer-chosen-v1' AND NEW.handle_attempt = 0))
BEGIN SELECT RAISE(ABORT, 'project identity is immutable'); END;

CREATE TRIGGER projects_region_immutable BEFORE UPDATE OF region ON projects
  WHEN NEW.region IS NOT OLD.region
BEGIN SELECT RAISE(ABORT, 'project region is chosen once'); END;

-- shared data mode means the dev and prod environments currently point at one data environment
CREATE TRIGGER projects_data_mode_matches_assignments BEFORE UPDATE OF data_mode ON projects
  WHEN NEW.data_mode IS NOT OLD.data_mode AND NOT (
    (SELECT data_environment_id FROM environment_data_assignments a WHERE a.organization_id = NEW.organization_id AND a.project_id = NEW.project_id
       AND a.environment_id = (SELECT environment_id FROM environments e WHERE e.organization_id = NEW.organization_id AND e.project_id = NEW.project_id AND e.name = 'dev')
       ORDER BY a.assignment_version DESC LIMIT 1) IS NOT NULL
    AND (SELECT data_environment_id FROM environment_data_assignments a WHERE a.organization_id = NEW.organization_id AND a.project_id = NEW.project_id
       AND a.environment_id = (SELECT environment_id FROM environments e WHERE e.organization_id = NEW.organization_id AND e.project_id = NEW.project_id AND e.name = 'prod')
       ORDER BY a.assignment_version DESC LIMIT 1) IS NOT NULL
    AND ((NEW.data_mode = 'shared') = (
      (SELECT data_environment_id FROM environment_data_assignments a WHERE a.organization_id = NEW.organization_id AND a.project_id = NEW.project_id
         AND a.environment_id = (SELECT environment_id FROM environments e WHERE e.organization_id = NEW.organization_id AND e.project_id = NEW.project_id AND e.name = 'dev')
         ORDER BY a.assignment_version DESC LIMIT 1)
      = (SELECT data_environment_id FROM environment_data_assignments a WHERE a.organization_id = NEW.organization_id AND a.project_id = NEW.project_id
         AND a.environment_id = (SELECT environment_id FROM environments e WHERE e.organization_id = NEW.organization_id AND e.project_id = NEW.project_id AND e.name = 'prod')
         ORDER BY a.assignment_version DESC LIMIT 1))))
BEGIN SELECT RAISE(ABORT, 'project data mode must match the current data assignments'); END;

CREATE TRIGGER environment_data_assignments_no_update BEFORE UPDATE ON environment_data_assignments
BEGIN SELECT RAISE(ABORT, 'environment_data_assignments is append-only'); END;
CREATE TRIGGER environment_data_assignments_no_delete BEFORE DELETE ON environment_data_assignments
BEGIN SELECT RAISE(ABORT, 'environment_data_assignments is append-only'); END;

-- An idempotency record is inserted complete together with its effect and never rewritten; it is only purged.
CREATE TRIGGER api_idempotency_records_no_update BEFORE UPDATE ON api_idempotency_records
BEGIN SELECT RAISE(ABORT, 'api_idempotency_records are immutable'); END;

-- Authoritative bucket fence of this shard. The directory's bucket map is cached by every isolate, so a command can
-- still be routed here after its bucket moved. A row here stops it at the database: `moving` refuses writes of the
-- bucket's organizations (reads stay served), `moved` refuses reads too. Every organization write batch carries a
-- `bucket_fenced` guard against this table, so the fence cannot be missed between routing and commit.
CREATE TABLE bucket_fences (
  bucket    INTEGER NOT NULL PRIMARY KEY CHECK (bucket BETWEEN 0 AND 1023),
  state     TEXT    NOT NULL CHECK (state IN ('moving','moved')),
  move_id   TEXT    NOT NULL CHECK (length(move_id) = 26),
  fenced_at TEXT    NOT NULL CHECK (fenced_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

-- Tombstone of a project creation that the reservation resolver closed. The creating batch is guarded against it,
-- so a creator that was only delayed can never commit after its directory reservation was released.
CREATE TABLE project_creation_aborts (
  project_id       TEXT NOT NULL PRIMARY KEY CHECK (length(project_id) = 26),
  organization_id  TEXT NOT NULL CHECK (length(organization_id) = 26),
  aborted_at       TEXT NOT NULL CHECK (aborted_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

-- Sweepers drain a shard, not an organization, so they cannot be routed through the organization's fenced
-- database; they skip the organizations whose bucket (`organizations.bucket`, 0001, always 0..1023) has a fence row.
