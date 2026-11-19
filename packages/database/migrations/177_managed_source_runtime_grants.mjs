// Forward correction for the restricted Worker role after the scoped Dev rollout.
const immutable =
  "source_connections,managed_source_repositories,managed_source_blobs,managed_source_reservations,operation_mcp_delegations";
const mutable =
  "project_source_bindings,managed_source_publications,managed_source_initializations";

export function up(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
    GRANT SELECT,INSERT ON ${immutable} TO control_runtime;
    GRANT SELECT,INSERT,UPDATE ON ${mutable} TO control_runtime;
  END IF; END $$;`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
    REVOKE SELECT,INSERT ON ${immutable} FROM control_runtime;
    REVOKE SELECT,INSERT,UPDATE ON ${mutable} FROM control_runtime;
  END IF; END $$;`);
}
