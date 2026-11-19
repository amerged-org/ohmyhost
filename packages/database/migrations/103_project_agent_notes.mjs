export function up(pgm) {
  pgm.sql(`CREATE TABLE project_agent_notes (
    project_id ulid PRIMARY KEY REFERENCES projects(project_id),
    version integer NOT NULL CHECK(version>0),
    markdown text NOT NULL CHECK(octet_length(markdown)<=16384 AND cardinality(string_to_array(markdown,E'\n'))<=250),
    updated_at timestamptz NOT NULL
  );
  CREATE TABLE project_agent_note_requests (
    organization_id ulid NOT NULL,project_id ulid NOT NULL REFERENCES projects(project_id),
    actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
    version integer NOT NULL CHECK(version>0),updated_at timestamptz NOT NULL,
    PRIMARY KEY(organization_id,project_id,actor_id,idempotency_key)
  );
  CREATE FUNCTION purge_deleted_project_agent_notes() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN DELETE FROM project_agent_notes WHERE project_id=NEW.project_id; RETURN NEW; END $$;
  CREATE TRIGGER purge_deleted_project_agent_notes AFTER UPDATE OF lifecycle_state ON projects
  FOR EACH ROW WHEN (NEW.lifecycle_state='deleted') EXECUTE FUNCTION purge_deleted_project_agent_notes()`);
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_agent_notes) OR EXISTS(SELECT 1 FROM project_agent_note_requests) THEN RAISE EXCEPTION 'Project note data prevents rollback'; END IF; END $$`,
  );
  pgm.sql(
    "DROP TRIGGER purge_deleted_project_agent_notes ON projects; DROP FUNCTION purge_deleted_project_agent_notes()",
  );
  pgm.dropTable("project_agent_note_requests");
  pgm.dropTable("project_agent_notes");
}
