// A flag change required an Idempotency-Key but never stored it, so a retried request switched the
// flag again after an opposite change (Dev, 2026-09-25: a replayed key closed the period another
// key had opened at 19:59:38Z). Each organization, project, principal and key keeps its answer.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE project_powered_by_flag_requests (
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL REFERENCES projects(project_id),
    actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
    enabled boolean NOT NULL,
    enabled_at timestamptz,
    recorded_at timestamptz NOT NULL,
    CHECK (enabled=(enabled_at IS NOT NULL)),
    PRIMARY KEY (organization_id,project_id,actor_id,idempotency_key)
  )`);
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      REVOKE ALL ON project_powered_by_flag_requests FROM control_runtime;
      GRANT SELECT,INSERT ON project_powered_by_flag_requests TO control_runtime;
    END IF;
  END $$`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_powered_by_flag_requests) THEN
      RAISE EXCEPTION 'Recorded powered-by flag requests prevent a lossless downgrade';
    END IF;
  END $$`);
  pgm.sql(`DROP TABLE project_powered_by_flag_requests`);
}
