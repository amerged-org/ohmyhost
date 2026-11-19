CREATE TABLE make_action_bindings (
 binding_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 import_id TEXT NOT NULL REFERENCES workspace_connection_imports(import_id), project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
 capability_digest TEXT NOT NULL CHECK(length(capability_digest)=64), action TEXT NOT NULL CHECK(json_valid(action)),
 ownership_version INTEGER NOT NULL, billing_epoch_id TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER make_action_binding_immutable BEFORE UPDATE ON make_action_bindings BEGIN SELECT RAISE(ABORT,'make action binding immutable'); END;
CREATE TABLE make_action_executions (
 organization_id TEXT NOT NULL, binding_id TEXT NOT NULL REFERENCES make_action_bindings(binding_id), execution_id TEXT NOT NULL,
 input_digest TEXT NOT NULL CHECK(length(input_digest)=64), grant_generation INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','completed','uncertain','denied')),
 PRIMARY KEY(organization_id,binding_id,execution_id)
) STRICT, WITHOUT ROWID;
