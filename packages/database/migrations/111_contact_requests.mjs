export function up(pgm) {
  pgm.sql(`CREATE TABLE contact_requests (
    request_id uuid PRIMARY KEY,
    payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),
    name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
    email text NOT NULL CHECK(length(email) BETWEEN 3 AND 254),
    company text NOT NULL CHECK(length(company)<=200),
    message text NOT NULL CHECK(length(message) BETWEEN 1 AND 8000),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK(expires_at>created_at)
  );
  CREATE INDEX contact_requests_expiry ON contact_requests(expires_at);
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
    GRANT SELECT,INSERT,DELETE ON contact_requests TO control_runtime;
  END IF; END $$;`);
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM contact_requests) THEN RAISE EXCEPTION 'Contact requests prevent rollback'; END IF; END $$`,
  );
  pgm.dropTable("contact_requests");
}
