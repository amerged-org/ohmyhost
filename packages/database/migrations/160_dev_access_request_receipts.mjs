// B21: repeating an access-mode change or revocation must replay its first result without
// reopening public Dev or withdrawing a replacement link; capability URLs stay encrypted.
export function up(pgm) {
  pgm.sql(`CREATE TABLE project_dev_access_requests (
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL REFERENCES projects(project_id),
    actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
    key_sha256 bytea NOT NULL CHECK(octet_length(key_sha256)=32),
    request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
    response_ciphertext bytea NOT NULL CHECK(octet_length(response_ciphertext) BETWEEN 17 AND 5136),
    response_nonce bytea NOT NULL CHECK(octet_length(response_nonce)=12),
    response_value_sha256 bytea NOT NULL CHECK(octet_length(response_value_sha256)=32),
    response_key_version integer NOT NULL CHECK(response_key_version>0),
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY(organization_id,project_id,actor_id,key_sha256)
  );
  CREATE TRIGGER project_dev_access_requests_append_only BEFORE UPDATE OR DELETE ON project_dev_access_requests
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
    REVOKE ALL ON project_dev_access_requests FROM control_runtime;
    GRANT SELECT,INSERT ON project_dev_access_requests TO control_runtime;
  END IF; END $$;`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_dev_access_requests) THEN
    RAISE EXCEPTION 'Recorded Dev access requests prevent a lossless downgrade';
  END IF; END $$;
  DROP TABLE project_dev_access_requests;`);
}
