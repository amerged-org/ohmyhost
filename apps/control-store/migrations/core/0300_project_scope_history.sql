-- Global project / environment / data-environment identity and ONE current owner per project (core-v1 only).
--
-- The lineage keys every tenant table by (organization_id, project_id). The original PostgreSQL schema has a GLOBAL project,
-- environment and billing-epoch identity next to the ownership rows, so an ownership transfer moves the project to another
-- organization while the former organization's financial, provider and operation history stays exactly where it was recorded.
-- The shared core keeps the composite keys (every historical row keeps its exact parent: no row is relabelled, no proof is
-- rewritten, nothing is cloned) and restores the global rules next to them:
--   * project_identities: the project id, its creating organization and created_event_id exist once, globally.
--   * at most ONE scope row of a project is current (owner_state <> 'transferred'); the former owner's row is `transferred`.
--   * at most ONE billing epoch of a project is open, globally (the lineage allowed one per owning organization).
--   * a scope row becomes `transferred` only after its epoch is closed, and then never changes again.
--   * environment ids and data-environment ids keep one project (and one physical origin) across every scope that names them.
-- The identity tables are written by AFTER INSERT triggers, so every writer (the typed commands and an import) gets the same
-- rule, and a later scope row of the same project must carry the identical identity or the batch aborts.

CREATE TABLE project_identities (
  project_id               TEXT NOT NULL PRIMARY KEY
    CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  created_organization_id  TEXT NOT NULL CHECK (length(created_organization_id) = 26),
  created_event_id         TEXT NOT NULL UNIQUE CHECK (length(created_event_id) = 26),
  created_at               TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

CREATE TRIGGER projects_global_identity AFTER INSERT ON projects
BEGIN
  INSERT INTO project_identities(project_id, created_organization_id, created_event_id, created_at)
    SELECT NEW.project_id, NEW.created_organization_id, NEW.created_event_id, NEW.created_at
    WHERE NOT EXISTS (SELECT 1 FROM project_identities WHERE project_id = NEW.project_id);
  SELECT RAISE(ABORT, 'a project scope row carries the global identity of its project')
    WHERE NOT EXISTS (
      SELECT 1 FROM project_identities
       WHERE project_id = NEW.project_id AND created_organization_id = NEW.created_organization_id
         AND created_event_id = NEW.created_event_id AND created_at = NEW.created_at);
END;

-- The scope row (organization_id, project_id) is the organization's STABLE relation to the project; every historical row keeps
-- its exact composite parent for ever. Which organization owns the project NOW is the one scope row that is not
-- `transferred`; which epoch is current is the one open billing epoch of the project (global). An ownership RETURN
-- (A -> B -> A) therefore does not clone, relabel or delete anything: the former owner's row leaves `transferred` through ONE
-- guarded transition that opens a FRESH third epoch (a new global epoch id, strictly later than every other epoch of the
-- project), raises the ownership version above every scope row of the project, and first appends the retired state of the
-- scope to `project_scope_history`. The two earlier epochs, and everything keyed by them (operations, holds, usage sources,
-- valuations, grants, provider history), stay exactly as recorded.
CREATE UNIQUE INDEX projects_one_current_owner ON projects (project_id) WHERE owner_state <> 'transferred';

CREATE TRIGGER projects_transfer_after_epoch_close BEFORE UPDATE OF owner_state ON projects
  WHEN NEW.owner_state = 'transferred' AND OLD.owner_state <> 'transferred' AND NOT EXISTS (
    SELECT 1 FROM billing_epochs
     WHERE organization_id = OLD.organization_id AND billing_epoch_id = OLD.active_billing_epoch_id AND ended_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'a project scope is transferred only after its billing epoch is closed'); END;

-- A transferred scope is history. It changes only by a RETURN: back to `active`, with an ownership version above every scope
-- row of the project, a fresh epoch of this organization that is open, belongs to this project and starts after every other
-- epoch of the project has ended, and the lifecycle (state AND version) of the project as its LAST other scope left it: the
-- original keeps ONE `projects` row whose lifecycle a transfer never touches, so a return can neither roll the project back
-- to the stale lifecycle this scope held nor resurrect a deleting or deleted project. The original does not refuse a transfer
-- of a deleting or deleted project, so neither does the core: the lifecycle simply travels with the project.
CREATE TRIGGER projects_transferred_terminal BEFORE UPDATE ON projects
  WHEN OLD.owner_state = 'transferred'
    AND (NEW.owner_state IS NOT 'active'
      OR NEW.ownership_version <= (SELECT max(ownership_version) FROM projects WHERE project_id = OLD.project_id)
      OR NEW.active_billing_epoch_id IS OLD.active_billing_epoch_id
      OR NOT EXISTS (
        SELECT 1 FROM billing_epochs e
         WHERE e.organization_id = OLD.organization_id AND e.billing_epoch_id = NEW.active_billing_epoch_id
           AND e.project_id = OLD.project_id AND e.ended_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM billing_epochs o
                            WHERE o.project_id = e.project_id AND o.billing_epoch_id <> e.billing_epoch_id
                              AND (o.ended_at IS NULL OR o.ended_at > e.started_at)))
      OR NOT EXISTS (
        SELECT 1 FROM (SELECT p.lifecycle_state, p.lifecycle_version FROM projects p
                        WHERE p.project_id = OLD.project_id AND p.organization_id <> OLD.organization_id
                        ORDER BY p.updated_at DESC, p.ownership_version DESC LIMIT 1) last
         WHERE last.lifecycle_state = NEW.lifecycle_state AND last.lifecycle_version = NEW.lifecycle_version))
BEGIN SELECT RAISE(ABORT, 'a transferred project scope is history and changes only by a return to a fresh billing epoch'); END;

-- The same invariant on the first copy: a new scope row of a project that already has one carries the lifecycle of the
-- project as its latest scope row left it (the original copies nothing: it has one row).
CREATE TRIGGER projects_copy_follows_lifecycle BEFORE INSERT ON projects
  WHEN EXISTS (SELECT 1 FROM projects o WHERE o.project_id = NEW.project_id)
    AND NOT EXISTS (
      SELECT 1 FROM (SELECT p.lifecycle_state, p.lifecycle_version FROM projects p
                      WHERE p.project_id = NEW.project_id ORDER BY p.updated_at DESC, p.ownership_version DESC LIMIT 1) last
       WHERE last.lifecycle_state = NEW.lifecycle_state AND last.lifecycle_version = NEW.lifecycle_version)
BEGIN SELECT RAISE(ABORT, 'a new scope row of a project carries the latest lifecycle of the project'); END;

-- The retired state of a scope, appended when the scope returns. One row per (organization, project, ownership version) and
-- never changed: the ownership history of a returning organization keeps its epoch pointer, version and lifecycle.
CREATE TABLE project_scope_history (
  organization_id          TEXT    NOT NULL CHECK (length(organization_id) = 26),
  project_id               TEXT    NOT NULL CHECK (length(project_id) = 26),
  ownership_version        INTEGER NOT NULL CHECK (ownership_version > 0),
  owner_state              TEXT    NOT NULL CHECK (owner_state = 'transferred'),
  active_billing_epoch_id  TEXT    NOT NULL CHECK (length(active_billing_epoch_id) = 26),
  lifecycle_state          TEXT    NOT NULL CHECK (lifecycle_state IN ('active','deleting','deleted')),
  lifecycle_version        INTEGER NOT NULL CHECK (lifecycle_version > 0),
  scope_updated_at         TEXT    NOT NULL CHECK (scope_updated_at GLOB '????-??-??T??:??:??.??????Z'),
  returned_at              TEXT    NOT NULL CHECK (returned_at GLOB '????-??-??T??:??:??.??????Z'),
  returned_to_billing_epoch_id TEXT NOT NULL CHECK (length(returned_to_billing_epoch_id) = 26),
  PRIMARY KEY (organization_id, project_id, ownership_version),
  UNIQUE (organization_id, active_billing_epoch_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, active_billing_epoch_id) REFERENCES billing_epochs (organization_id, billing_epoch_id),
  FOREIGN KEY (organization_id, returned_to_billing_epoch_id) REFERENCES billing_epochs (organization_id, billing_epoch_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER projects_return_history AFTER UPDATE ON projects
  WHEN OLD.owner_state = 'transferred' AND NEW.owner_state = 'active'
BEGIN
  INSERT INTO project_scope_history(organization_id, project_id, ownership_version, owner_state, active_billing_epoch_id,
      lifecycle_state, lifecycle_version, scope_updated_at, returned_at, returned_to_billing_epoch_id)
    VALUES (OLD.organization_id, OLD.project_id, OLD.ownership_version, OLD.owner_state, OLD.active_billing_epoch_id,
      OLD.lifecycle_state, OLD.lifecycle_version, OLD.updated_at, NEW.updated_at, NEW.active_billing_epoch_id);
END;
CREATE TRIGGER project_scope_history_append_only_update BEFORE UPDATE ON project_scope_history
BEGIN SELECT RAISE(ABORT, 'a project scope history row never changes'); END;
CREATE TRIGGER project_scope_history_append_only_delete BEFORE DELETE ON project_scope_history
BEGIN SELECT RAISE(ABORT, 'a project scope history row is never deleted'); END;

-- Exactly one open epoch per project, GLOBALLY (the lineage allowed one per owning organization), and the epochs of a project
-- are a chronological chain: an epoch opens only after every other epoch has ended, ends once, and is never deleted.
DROP INDEX billing_epochs_one_open_per_project;
CREATE UNIQUE INDEX billing_epochs_one_open_per_project ON billing_epochs (project_id) WHERE ended_at IS NULL;

CREATE TRIGGER billing_epochs_chronological BEFORE INSERT ON billing_epochs
  WHEN EXISTS (SELECT 1 FROM billing_epochs o WHERE o.project_id = NEW.project_id AND o.ended_at IS NOT NULL AND o.ended_at > NEW.started_at)
BEGIN SELECT RAISE(ABORT, 'a billing epoch opens after every earlier epoch of its project has ended'); END;
CREATE TRIGGER billing_epochs_history_update BEFORE UPDATE ON billing_epochs
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.billing_epoch_id IS NOT OLD.billing_epoch_id
    OR NEW.project_id IS NOT OLD.project_id OR NEW.started_at IS NOT OLD.started_at
    OR NEW.created_by_principal_id IS NOT OLD.created_by_principal_id OR OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a billing epoch only ends, once'); END;
CREATE TRIGGER billing_epochs_history_delete BEFORE DELETE ON billing_epochs
BEGIN SELECT RAISE(ABORT, 'a billing epoch is history and is never deleted'); END;

CREATE TABLE environment_identities (
  environment_id  TEXT NOT NULL PRIMARY KEY
    CHECK (length(environment_id) = 26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id      TEXT NOT NULL CHECK (length(project_id) = 26),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 63),
  created_at      TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

CREATE TRIGGER environments_global_identity AFTER INSERT ON environments
BEGIN
  INSERT INTO environment_identities(environment_id, project_id, name, created_at)
    SELECT NEW.environment_id, NEW.project_id, NEW.name, NEW.created_at
    WHERE NOT EXISTS (SELECT 1 FROM environment_identities WHERE environment_id = NEW.environment_id);
  SELECT RAISE(ABORT, 'an environment scope row carries the global identity of its environment')
    WHERE NOT EXISTS (
      SELECT 1 FROM environment_identities
       WHERE environment_id = NEW.environment_id AND project_id = NEW.project_id AND name = NEW.name);
END;

-- The physical data environment of a project belongs to the organization that first recorded it. A later owner reaches it
-- through an alias row of its own (the original aliases the retained physical environment under the new organization and
-- appends an assignment); the alias names the same project, and the physical origin never moves.
CREATE TABLE data_environment_identities (
  data_environment_id      TEXT NOT NULL PRIMARY KEY CHECK (length(data_environment_id) = 26),
  project_id               TEXT NOT NULL CHECK (length(project_id) = 26),
  physical_organization_id TEXT NOT NULL CHECK (length(physical_organization_id) = 26),
  created_at               TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

CREATE TRIGGER project_data_environments_global_identity AFTER INSERT ON project_data_environments
BEGIN
  INSERT INTO data_environment_identities(data_environment_id, project_id, physical_organization_id, created_at)
    SELECT NEW.data_environment_id, NEW.project_id, NEW.organization_id, NEW.created_at
    WHERE NOT EXISTS (SELECT 1 FROM data_environment_identities WHERE data_environment_id = NEW.data_environment_id);
  SELECT RAISE(ABORT, 'a data environment alias names the project of its physical environment')
    WHERE NOT EXISTS (
      SELECT 1 FROM data_environment_identities
       WHERE data_environment_id = NEW.data_environment_id AND project_id = NEW.project_id);
END;

-- Historical billing environment scopes (append-only). The lineage absorbed the original billing_environment_scopes into
-- `environments`; the holds, usage sources and cohort work of 0220 / 0252 / 0254 then pointed at the CURRENT environment row,
-- so a fact recorded for an environment that no longer exists (the original's gone-environment PGCF fallback) or for the
-- scope of a former owner had no valid parent. They now reference this table: every environment row writes its scope here
-- (trigger, so the typed commands and an import share one rule) and an import of a gone environment writes its scope row
-- with origin 'history' and NO environments row, so no fake current environment appears. A scope row is never updated or
-- deleted, which keeps every financial row's parent alive for as long as the row exists.
CREATE TABLE billing_environment_scopes (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26),
  environment_id  TEXT NOT NULL CHECK (length(environment_id) = 26),
  project_id      TEXT NOT NULL CHECK (length(project_id) = 26),
  origin          TEXT NOT NULL CHECK (origin IN ('environment', 'history')),
  recorded_at     TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, environment_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;

INSERT INTO billing_environment_scopes(organization_id, environment_id, project_id, origin, recorded_at)
  SELECT organization_id, environment_id, project_id, 'environment', created_at FROM environments;

CREATE TRIGGER environments_billing_scope AFTER INSERT ON environments
BEGIN
  INSERT INTO billing_environment_scopes(organization_id, environment_id, project_id, origin, recorded_at)
    VALUES (NEW.organization_id, NEW.environment_id, NEW.project_id, 'environment', NEW.created_at);
END;

CREATE TRIGGER billing_environment_scopes_append_only_update BEFORE UPDATE ON billing_environment_scopes
BEGIN SELECT RAISE(ABORT, 'a billing environment scope is history and never changes'); END;
CREATE TRIGGER billing_environment_scopes_append_only_delete BEFORE DELETE ON billing_environment_scopes
BEGIN SELECT RAISE(ABORT, 'a billing environment scope is history and is never deleted'); END;
