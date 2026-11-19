export function up(pgm) {
  pgm.sql(`CREATE TABLE project_recovery_jobs (
    operation_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL,
    environment_id ulid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('export','daily')),
    input_ciphertext bytea,
    input_nonce bytea,
    input_key_version integer,
    input_expires_at timestamptz NOT NULL,
    requested_at timestamptz NOT NULL,
    claim_id uuid,
    started_at timestamptz,
    archive_bucket text NOT NULL CHECK (archive_bucket IN ('ohmyho-development-backups','ohmyho-production-backups')),
    archive_key text GENERATED ALWAYS AS ('snapshots/'||organization_id::text||'/'||project_id::text||'/'||operation_id::text||'.tar.age') STORED,
    archive_bytes bigint,
    archive_sha256 bytea,
    captured_at timestamptz,
    archive_expires_at timestamptz,
    verified_at timestamptz,
    finished_at timestamptz,
    failure_code text,
    FOREIGN KEY (organization_id,project_id,operation_id)
      REFERENCES operations (organization_id,project_id,operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id,project_id,environment_id)
      REFERENCES environments (organization_id,project_id,environment_id) ON DELETE RESTRICT,
    CHECK ((input_ciphertext IS NULL AND input_nonce IS NULL AND input_key_version IS NULL)
      OR (input_ciphertext IS NOT NULL AND octet_length(input_ciphertext) BETWEEN 17 AND 2097168
        AND input_nonce IS NOT NULL AND octet_length(input_nonce)=12 AND input_key_version IS NOT NULL AND input_key_version>0)),
    CHECK (input_expires_at=requested_at+interval '1 hour'),
    CHECK ((claim_id IS NULL AND started_at IS NULL) OR (claim_id IS NOT NULL AND started_at IS NOT NULL)),
    CHECK ((archive_bytes IS NULL AND archive_sha256 IS NULL AND captured_at IS NULL AND archive_expires_at IS NULL)
      OR (archive_bytes IS NOT NULL AND archive_bytes BETWEEN 1 AND 536870912 AND archive_sha256 IS NOT NULL AND octet_length(archive_sha256)=32 AND captured_at IS NOT NULL AND archive_expires_at IS NOT NULL
        AND archive_expires_at=captured_at+interval '7 days')),
    CHECK (verified_at IS NULL OR (archive_sha256 IS NOT NULL AND finished_at IS NOT NULL AND failure_code IS NULL)),
    CHECK (failure_code IS NULL OR (failure_code~'^[A-Z][A-Z0-9_]{0,95}$' AND finished_at IS NOT NULL AND verified_at IS NULL)),
    CHECK (finished_at IS NULL OR (input_ciphertext IS NULL AND (verified_at IS NOT NULL OR failure_code IS NOT NULL)))
  )`);
  pgm.createIndex("project_recovery_jobs", ["organization_id", "project_id", "requested_at"]);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_recovery_jobs) THEN
      RAISE EXCEPTION 'Retain recovery jobs and archive receipts before removing this delivery';
    END IF;
  END $$`);
  pgm.dropTable("project_recovery_jobs");
}
