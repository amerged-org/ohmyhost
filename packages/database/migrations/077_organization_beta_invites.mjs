export function up(pgm) {
  pgm.sql(`
    CREATE TABLE organization_beta_invites (
      code_sha256 bytea PRIMARY KEY CHECK (octet_length(code_sha256)=32),
      issued_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at>issued_at),
      claimed_request_id ulid UNIQUE REFERENCES organization_onboarding_requests(request_id),
      claimed_at timestamptz,
      CHECK ((claimed_request_id IS NULL AND claimed_at IS NULL)
        OR (claimed_request_id IS NOT NULL AND claimed_at IS NOT NULL
          AND claimed_at>=issued_at AND claimed_at<expires_at))
    );
  `);
}

export function down(pgm) {
  pgm.dropTable("organization_beta_invites");
}
